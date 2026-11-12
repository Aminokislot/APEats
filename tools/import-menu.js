// Builds data/stalls.json and data/dishes.json from the raw menu files in data/source/*.json (one combined
// file with "menus": [...] or single menu files with "cuisine" + "items") plus data/extra-items.json.
// Newer files override older ones for the same cuisine.
//
// Safety:
//   - the source is validated first; any error stops the import and nothing is written;
//   - the generated menu is validated again before writing;
//   - the previous dishes.json / stalls.json are copied to data/backups/<time>/ (restore: npm run menu:rollback);
//   - files are written atomically; data/import-report.json lists added, changed and removed items.
//
// Hand-made decisions (item roles, price notes) live in data/menu-overrides.json and are re-applied every time.
//
// Gemini steps (cached, so re-running only processes new or changed items):
//   1. translate Russian descriptions to English        -> data/translations.en.json
//   2. enrich every item: short newcomer blurb, spice 0-5, likely allergens,
//      price estimate when the board shows none, photo topic  -> data/enrichment.json
//
// Usage: npm run import                      (all files in data/source, uses Gemini for new items)
//        npm run import -- --no-ai           (cached AI results only; new items get "unknown" spice/allergens)
//        npm run import -- --check           (validate and report, write nothing)
//        npm run import -- --data-dir <dir>  (another data folder, used by tests)
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, copyFileSync, renameSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../lib/env.js";
import { generateJson, hasGeminiKey } from "../lib/gemini.js";
import { defaultRole, baseOf, ROLES } from "../lib/roles.js";
import { validateMenu, WEEKDAYS } from "../lib/menu-data.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(join(root, ".env"));
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  return args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
};
const DATA = resolve(option("--data-dir") ?? join(root, "data"));
const isProjectData = DATA === resolve(join(root, "data"));
const SOURCE = join(DATA, "source");
const TRANSLATIONS = join(DATA, "translations.en.json");
const ENRICHMENT = join(DATA, "enrichment.json");
const useAi = !args.includes("--no-ai") && !args.includes("--no-translate");
const checkOnly = args.includes("--check");
const campus = JSON.parse(readFileSync(join(DATA, "campus.json"), "utf8"));

export const ALLERGENS = ["peanuts", "tree nuts", "milk", "egg", "wheat/gluten", "soy", "fish", "shellfish", "sesame"];

const readJson = (path, fallback) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback);
const slug = (text) => text.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const rm = (n) => `RM${Number(n).toFixed(2)}`;
const hash = (value) => createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 12);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function fail(problems) {
  console.error(`Import stopped: ${problems.length} problem(s). Nothing was written.`);
  for (const p of problems.slice(0, 40)) console.error(`  - ${p}`);
  if (problems.length > 40) console.error(`  … and ${problems.length - 40} more`);
  process.exit(1);
}

// Stall ids stay stable (they key the AI caches); the shown cuisine name comes from campus.json.
const ID_LABEL = { "Lets Kopitian": "Kopitiam" }; // fixes a typo in the source cuisine name
const cuisineName = (source) => campus.cuisineNames?.[source] ?? ID_LABEL[source] ?? source;

// ---------- Source validation ----------

const isMoney = (v) => typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1000;

function validateSourceItem(item, where) {
  const problems = [];
  if (!item || typeof item !== "object") return [`${where}: not an object`];
  if (typeof item.id !== "string" && typeof item.id !== "number") problems.push(`${where}: missing id`);
  if (typeof item.name !== "string" || !item.name.trim()) problems.push(`${where}: missing name`);
  if (item.price_rm != null && !isMoney(item.price_rm)) problems.push(`${where}: price_rm must be a positive number`);
  if (item.price_options_rm != null && (!Array.isArray(item.price_options_rm) || !item.price_options_rm.length || !item.price_options_rm.every(isMoney))) {
    problems.push(`${where}: price_options_rm must be positive numbers`);
  }
  if (item.price_range_rm != null) {
    const { min, max } = item.price_range_rm;
    if (!isMoney(min) || !isMoney(max) || min > max) problems.push(`${where}: price_range_rm needs 0 < min <= max`);
  }
  for (const o of item.price_observations ?? []) {
    if (o.price_rm != null && !isMoney(o.price_rm)) problems.push(`${where}: bad price observation`);
    if (o.price_range_rm && !(isMoney(o.price_range_rm.min) && isMoney(o.price_range_rm.max) && o.price_range_rm.min <= o.price_range_rm.max)) {
      problems.push(`${where}: bad price observation range`);
    }
  }
  if (item.availability_days != null && (!Array.isArray(item.availability_days) || item.availability_days.some((d) => !WEEKDAYS.includes(d)))) {
    problems.push(`${where}: availability_days must be weekday names`);
  }
  if ("available" in item && ![true, false, null].includes(item.available)) problems.push(`${where}: available must be true, false or null`);
  if (item.printed_value_set_available_after != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.printed_value_set_available_after)) {
    problems.push(`${where}: printed_value_set_available_after must be HH:MM`);
  }
  if (item.vegan === true && item.vegetarian !== true) problems.push(`${where}: vegan item must also be vegetarian`);
  return problems;
}

function validateMenus(menus) {
  const problems = [];
  for (const { menu, file } of menus) {
    if (typeof menu.cuisine !== "string" || !menu.cuisine.trim()) {
      problems.push(`${file}: menu without a cuisine name`);
      continue;
    }
    if (!Array.isArray(menu.items)) problems.push(`${file} / ${menu.cuisine}: "items" must be an array`);
    if (menu.drinks != null && !Array.isArray(menu.drinks)) problems.push(`${file} / ${menu.cuisine}: "drinks" must be an array`);
    const ids = new Set();
    for (const list of ["items", "drinks"]) {
      for (const [i, item] of (Array.isArray(menu[list]) ? menu[list] : []).entries()) {
        const where = `${menu.cuisine} ${list}[${i}] ${item?.id ?? ""}`.trim();
        problems.push(...validateSourceItem(item, where));
        const key = String(item?.id ?? "").toLowerCase();
        if (key && ids.has(key)) problems.push(`${where}: duplicate id within ${menu.cuisine}`);
        ids.add(key);
      }
    }
  }
  return problems;
}

// ---------- Categories ----------

const CATEGORY_GROUPS = {
  Rice: ["rice", "rice_with_egg", "mixed_rice", "nasi_lemak", "fried_rice", "katsu_rice", "grilled_chicken_rice",
    "stir_fried_rice", "cheese_baked_rice", "chicken_rice", "ayam_kunyit"],
  Noodles: ["noodles", "fried_noodles", "pan_mee"],
  Soup: ["soup", "oden"],
  "Sushi & Bento": ["sushi", "temaki", "bento"],
  "Burgers & Wraps": ["burger_board", "hotdog_board", "grab_n_go", "wrap", "quesadilla", "sandwich"],
  "Roti & Breakfast": ["roti", "naan_and_tandoori", "capati", "tosai", "toast_and_egg", "breakfast"],
  Mains: ["western_main", "chicken_chop", "fish_and_chips", "main", "prepared_dish", "separate_dish"],
  "Counter dishes": ["ready_counter"],
  "Snacks & Sides": ["appetiser", "snack", "side", "salad", "rice_cakes"],
  Desserts: ["dessert"],
  "Add-ons": ["add_on", "food_add_on", "topping"],
  Drinks: ["drink", "coffee", "tea", "milk_tea", "jasmine_green_tea", "fruit_tea", "smoothie", "sparkling_drink",
    "other_drink", "juice"],
};
const CATEGORY_OF = Object.fromEntries(Object.entries(CATEGORY_GROUPS).flatMap(([group, raws]) => raws.map((r) => [r, group])));

function categoryOf(item, isDrink) {
  if (isDrink) return "Drinks";
  if (CATEGORY_OF[item.category]) return CATEGORY_OF[item.category];
  const name = item.name.toLowerCase();
  if (/rice|nasi/.test(name)) return "Rice";
  if (/noodle|ramen|ramyeon|udon|mee|laksa/.test(name)) return "Noodles";
  if (/soup/.test(name)) return "Soup";
  return "Mains";
}

// ---------- Prices ----------
// price = lowest shown price (for sorting), priceMax = highest (used for any budget check).

function priceOf(item) {
  if (typeof item.price_rm === "number") return { price: item.price_rm, priceMax: item.price_rm, priceText: rm(item.price_rm), priceNote: null };

  if (Array.isArray(item.price_options_rm) && item.price_options_rm.length) {
    const options = [...item.price_options_rm].sort((a, b) => a - b);
    return {
      price: options[0],
      priceMax: options.at(-1),
      priceText: options.map(rm).join(" / "),
      priceNote: "Two prices are shown on the board; the difference (e.g. portion) isn't stated. Budgets use the higher one.",
    };
  }

  if (item.price_range_rm) {
    const { min, max } = item.price_range_rm;
    return { price: min, priceMax: max, priceText: `${rm(min)}–${max.toFixed(2)}`, priceNote: "Price range shown for this group of counter dishes. Budgets use the top of the range." };
  }

  if (Array.isArray(item.price_observations) && item.price_observations.length) {
    const values = item.price_observations.flatMap((o) =>
      typeof o.price_rm === "number" ? [o.price_rm] : o.price_range_rm ? [o.price_range_rm.min, o.price_range_rm.max] : [],
    );
    if (values.length) {
      const min = Math.min(...values);
      const max = Math.max(...values);
      return {
        price: min,
        priceMax: max,
        priceText: min === max ? rm(min) : `${rm(min)}–${max.toFixed(2)}`,
        priceNote: "Different boards show different prices - check at the counter. Budgets use the higher one.",
      };
    }
  }
  return { price: null, priceMax: null, priceText: null, priceNote: null };
}

function priceConditionOf(item) {
  const c = item.price_conditions;
  if (!c) return null;
  const who = c.audience?.length ? c.audience.join(" and ") : "some customers";
  return `Board price for ${who}${c.payment_method ? ` paying with ${c.payment_method.replace("AP Card", "APCard")}` : ""}; other prices are not shown.`;
}

// What the board says is part of the dish. Pictures alone don't count.
function includesOf(item) {
  const includes = [];
  if (item.composition) {
    const { vegetable_choices: veg = 0, meat_choices: meat = 0 } = item.composition;
    includes.push("rice");
    if (veg) includes.push(`${veg} vegetable dish${veg > 1 ? "es" : ""} of your choice`);
    if (meat) includes.push(`${meat} meat dish${meat > 1 ? "es" : ""} of your choice`);
  }
  if (item.category === "rice_with_egg") includes.push("rice", "egg");
  if (item.includes_fries === true) includes.push("fries");
  if (item.includes_salad === true) includes.push("salad");
  const pictured = (item.illustrated_sides ?? []).filter((s) => !(s === "fries" && item.includes_fries === true));
  return {
    includes: [...new Set(includes)],
    includesNote: pictured.length ? `${pictured.join(" and ")} pictured on the board; not stated whether included in the price.` : null,
  };
}

// ---------- Items ----------

function notesOf(item, stallId) {
  const notes = [];
  if (item.printed_value_set_available_after) {
    notes.push(`The printed Value Set lists this as available after ${item.printed_value_set_available_after}.`);
  }
  if (item.availability_days) notes.push(`Daily special: ${item.availability_days.join(", ")}.`);
  if (item.available === false) notes.push("Marked as not available.");
  else if ("available" in item && item.available == null) notes.push("Seen on a poster; availability not confirmed.");
  if (stallId === "asian" && item.source_menu === "black_menu") notes.push("From the separate black menu at this counter.");
  return notes;
}

function convertItem(item, { stallId, cuisine, isDrink, addedByTeam }) {
  const dish = {
    id: `${stallId}--${String(item.id).toLowerCase()}`,
    sourceId: item.id,
    stallId,
    name: item.name,
    cuisine,
    category: categoryOf(item, isDrink),
    subcategory: item.category ?? null,
    role: null,
    roleBasis: null,
    base: null,
    ...priceOf(item),
    priceEstimated: false,
    priceCondition: priceConditionOf(item),
    spicySource: typeof item.spice_level === "number" ? item.spice_level : null, // 0-3 estimate from the photos
    spicy: null, // 0-5, from enrichment
    vegetarian: typeof item.vegetarian === "boolean" ? item.vegetarian : null,
    vegan: item.vegan === true,
    halal: campus.allHalal === true,
    allergens: null, // null = unknown until the enrichment step estimates them
    temperature: item.temperature ?? null,
    days: item.availability_days ?? null,
    availableAfter: item.printed_value_set_available_after ?? null,
    available: item.available === false ? false : "available" in item && item.available == null ? null : true,
    ...includesOf(item),
    origin: addedByTeam ? "team" : "menu-board",
    notes: notesOf(item, stallId),
    blurb: null,
    // Items added by the team (data/extra-items.json) come with an English description.
    descriptionRu: item.description_en ? null : item.description ?? null,
    description: item.description_en ?? null,
    photoKey: null,
    // Optional fixed photo topic, e.g. {"photo_query": "Sprite can"}; otherwise Gemini picks one.
    photoFixed: "photo_title" in item || "photo_query" in item || "photo_file" in item,
    photoTitle: item.photo_title || null,
    photoQuery: item.photo_query || null,
    photoFile: item.photo_file || null, // exact Wikimedia Commons file chosen by hand
  };
  const { role, basis } = defaultRole(dish);
  dish.role = role;
  dish.roleBasis = basis;
  dish.base = baseOf(dish);
  return dish;
}

// ---------- Stalls ----------

function offerText(offer) {
  if (offer.quantity && offer.total_price_rm != null) {
    const what = offer.category ? offer.category[0].toUpperCase() + offer.category.slice(1) : "Offer";
    return `${what}: ${offer.quantity} for ${rm(offer.total_price_rm)}`;
  }
  if (offer.additional_price_rm != null) {
    const choices = offer.choices?.length ? ` (${offer.choices.join(", ")})` : "";
    return `${offer.name}: +${rm(offer.additional_price_rm)}${choices}`;
  }
  return offer.name ?? null;
}

function convertStall(menu, cuisine, stallId, itemCount) {
  const service = menu.service_notes ?? {};
  const notes = [];
  if (campus.allHalal) notes.push("Halal.");
  if (service.cashless_only) notes.push("Cashless only.");
  if (service.student_staff_discount_note) notes.push("Extra student/staff discounts when paying with APCard (amount not shown).");
  if (service.cold_drink_sugar_options_percent) {
    notes.push(`Sugar level for cold drinks: ${service.cold_drink_sugar_options_percent.join("/")}%; hot drinks: ${(service.hot_drink_sugar_options_percent ?? []).join("/")}%.`);
  }
  if (menu.metadata?.menu_groups?.black_menu) notes.push("Includes the Sri Emas menu and a separate black menu (owner not shown).");
  if (menu.metadata?.daily_special_note) notes.push("Daily specials follow the Daily Special board; other days not confirmed.");

  const extras = [
    ...(menu.toppings ?? []).map((x) => ({ kind: "Topping", name: x.name, price: x.price_rm ?? null })),
    ...(menu.sauce_options ?? []).map((x) => ({ kind: "Sauce", name: x.name, price: x.extra_price_rm ?? null })),
    ...(menu.oden_soup_options ?? []).map((x) => ({ kind: "Oden broth", name: x.name, price: x.extra_price_rm ?? null })),
    ...(menu.charges ?? []).map((x) => ({ kind: "Charge", name: x.name, price: x.price_rm ?? null })),
  ];

  const brand = menu.brand_name_on_menu ?? null;
  return {
    id: stallId,
    name: cuisine,
    brand: campus.brandNames && menu.cuisine in campus.brandNames
      ? campus.brandNames[menu.cuisine]
      : brand ?? menu.brand_name_on_sri_emas_menu ?? null,
    cuisine,
    coverPhoto: campus.coverPhotos?.[menu.cuisine] ?? null,
    halal: campus.allHalal === true,
    location: menu.location ?? null,
    hours: service.printed_hours ? service.printed_hours.replace(/[–—]/g, "-") : null,
    payment: service.accepted_payment_methods ?? null,
    notes,
    menuNoteRu: menu.metadata?.menu_note ?? null,
    menuNote: null,
    offers: (menu.offers ?? []).map(offerText).filter(Boolean),
    extras,
    itemCount,
  };
}

// ---------- Sources ----------

function loadMenus() {
  if (!existsSync(SOURCE)) fail([`No ${SOURCE} folder - put menu JSON files there`]);
  const files = readdirSync(SOURCE)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ file: f, path: join(SOURCE, f), mtime: statSync(join(SOURCE, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);
  if (!files.length) fail([`${SOURCE} has no .json menu files`]);
  const byCuisine = new Map();
  const problems = [];
  const sourceInfo = [];
  let compiledOn = null;
  for (const { file, path } of files) {
    const text = readFileSync(path, "utf8");
    let json;
    try {
      json = JSON.parse(text);
    } catch (error) {
      problems.push(`${file}: not valid JSON (${error.message})`);
      continue;
    }
    sourceInfo.push({ file, sha256: sha256(text) });
    if (typeof json.compiled_on === "string") compiledOn = json.compiled_on;
    const menus = Array.isArray(json.menus) ? json.menus : json.cuisine && json.items ? [json] : [];
    if (!menus.length) problems.push(`${file}: no menus found`);
    for (const menu of menus) {
      if (byCuisine.has(menu.cuisine)) console.log(`  ${file}: replaces earlier "${menu.cuisine}"`);
      byCuisine.set(menu.cuisine, { menu, file, team: { items: new Set(), drinks: new Set() } });
    }
  }
  // Items the team adds by hand (not on the menu photos) are appended to their cuisine.
  const extrasPath = join(DATA, "extra-items.json");
  if (existsSync(extrasPath)) {
    const text = readFileSync(extrasPath, "utf8");
    sourceInfo.push({ file: "../extra-items.json", sha256: sha256(text) });
    const extras = JSON.parse(text).cuisines ?? {};
    for (const [cuisine, add] of Object.entries(extras)) {
      const entry = byCuisine.get(cuisine);
      if (!entry) {
        problems.push(`extra-items.json: no cuisine "${cuisine}" in the menus`);
        continue;
      }
      const menu = { ...entry.menu };
      for (const list of ["items", "drinks"]) {
        if (!add[list]) continue;
        menu[list] = [...(menu[list] ?? []), ...add[list]];
        for (const item of add[list]) entry.team[list].add(String(item.id));
      }
      entry.menu = menu;
    }
  }
  const menus = [...byCuisine.values()];
  problems.push(...validateMenus(menus));
  if (problems.length) fail(problems);
  return { files: sourceInfo, compiledOn, menus };
}

// ---------- Manual overrides ----------

const OVERRIDE_FIELDS = ["role", "reason", "disputed", "base", "priceEstimated", "priceNote", "includes", "includesNote", "photoKey"];

function loadOverrides() {
  const file = readJson(join(DATA, "menu-overrides.json"), { items: {} });
  const problems = [];
  for (const [id, o] of Object.entries(file.items ?? {})) {
    for (const key of Object.keys(o)) if (!OVERRIDE_FIELDS.includes(key)) problems.push(`menu-overrides.json ${id}: unknown field "${key}"`);
    if (o.role != null && !ROLES.includes(o.role)) problems.push(`menu-overrides.json ${id}: role must be one of ${ROLES.join(", ")}`);
    if (o.role != null && !o.reason) problems.push(`menu-overrides.json ${id}: a role change needs a reason`);
  }
  if (problems.length) fail(problems);
  return file.items ?? {};
}

function applyOverrides(dishes, overrides) {
  const byId = new Map(dishes.map((d) => [d.id, d]));
  const missing = [];
  let applied = 0;
  for (const [id, o] of Object.entries(overrides)) {
    const d = byId.get(id);
    if (!d) {
      missing.push(id);
      continue;
    }
    applied++;
    if (o.role) {
      d.role = o.role;
      d.roleBasis = `Manual: ${o.reason}`;
    }
    if (o.disputed) d.roleDisputed = true;
    if ("base" in o) d.base = o.base;
    if (o.includes) d.includes = o.includes;
    if ("includesNote" in o) d.includesNote = o.includesNote;
    if (o.priceNote) d.priceNote = o.priceNote;
    if (o.photoKey) d.photoKey = o.photoKey;
    if (o.priceEstimated === true && d.price != null) {
      d.priceEstimated = true;
      if (!d.priceText.startsWith("~")) d.priceText = `~${d.priceText}`;
    }
  }
  return { applied, missing };
}

// ---------- Step 1: translation ----------

const TRANSLATE_SYSTEM = `You translate short Russian food-menu descriptions into natural, concise English
for international university students in Malaysia.
- Keep dish names and local food words as they are (kuey teow, sambal, kopi, roti, oden, etc.).
- Keep any uncertainty the text expresses ("ingredients not listed", "spiciness estimated").
- Do not add facts. One or two short sentences.
Return every input item with the same index i.`;

const TRANSLATE_SCHEMA = {
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      items: { type: "OBJECT", properties: { i: { type: "INTEGER" }, en: { type: "STRING" } }, required: ["i", "en"] },
    },
  },
  required: ["items"],
};

async function translateMissing(texts, cache) {
  const missing = [...new Set(texts.filter((t) => t && !cache[t]))];
  if (!missing.length) return 0;
  if (!useAi || !hasGeminiKey()) {
    console.log(`  ${missing.length} texts not translated (${useAi ? "no GEMINI_API_KEY" : "--no-ai"}); Russian shown instead`);
    return 0;
  }
  console.log(`  translating ${missing.length} texts with Gemini…`);
  const BATCH = 60;
  let done = 0;
  for (let start = 0; start < missing.length; start += BATCH) {
    const batch = missing.slice(start, start + BATCH);
    try {
      const { data, model } = await generateJson({
        system: TRANSLATE_SYSTEM,
        contents: [{ role: "user", parts: [{ text: batch.map((text, i) => `${i}\t${text}`).join("\n") }] }],
        schema: TRANSLATE_SCHEMA,
        temperature: 0.2,
        timeoutMs: 90000,
        budgetMs: 240000,
      });
      for (const { i, en } of data.items ?? []) {
        if (batch[i] && en?.trim()) {
          cache[batch[i]] = en.trim();
          done++;
        }
      }
      if (!checkOnly) writeFileSync(TRANSLATIONS, JSON.stringify(cache, null, 1));
      console.log(`  translation batch ${start / BATCH + 1}/${Math.ceil(missing.length / BATCH)} ok (${model})`);
    } catch (error) {
      console.warn(`  translation batch failed: ${error.message.split("\n")[0]} - run import again to retry`);
    }
  }
  return done;
}

// ---------- Step 2: enrichment ----------

const ENRICH_SYSTEM = `You prepare a campus food app for freshmen and international students at a university in
Kuala Lumpur, Malaysia. All stalls are halal. For every menu item return:

- blurb: ONE short sentence (max 110 characters) that tells a newcomer what the item actually is and how it
  tastes, in plain English. Explain local words (e.g. "Kuey teow: flat rice noodles stir-fried with soy sauce,
  egg and bean sprouts."). Don't repeat the price. Don't invent stall-specific claims.
- spicy: integer 0-5 on THIS scale (not 0-3) for a typical Malaysian serving:
  0 none (plain rice, katsu, burgers, desserts, most drinks)
  1 barely - black pepper, mild Japanese curry, a little chili sauce on the side
  2 mild chili - kimchi, mild curry chicken, roti canai with curry
  3 medium - typical sambal: nasi lemak, sambal dishes, tom yam, kampung fried rice, mee goreng mamak
  4 hot - lots of chili: mala, sambal sotong/petai, "spicy" Korean dishes, ayam masak merah
  5 very hot - extra chili, "pedas" specials
  "photoHint" is an earlier rough estimate from the menu photo (none / slight / medium / very). Re-rate on the
  0-5 scale; do not copy numbers.
- allergens: likely allergens from this list only: ${ALLERGENS.join(", ")}.
  Think about usual recipes (soy sauce has soy and wheat; batter and noodles have wheat; satay and nasi lemak
  usually have peanuts; mayonnaise has egg; milk tea and kopi with milk have milk). Empty if none are likely.
- wikiTitle: the exact title of the English Wikipedia article about this specific dish or drink
  (e.g. "Nasi lemak", "Hainanese chicken rice", "Teh tarik", "Tonkatsu", "Shawarma", "Egg waffle", "Char kway teow").
  It must be an article about a dish, drink or ingredient - never a cuisine, country, company or brand
  ("Cantonese cuisine", "Coca-Cola" are wrong). Empty string if there is no such article.
- photoQuery: 2-4 English words to search a food photo of this item (e.g. "chicken katsu curry rice").
- estPrice: only when price is "none": a realistic price in RM based on similar priced items of the same stall
  (round to 0.10). Otherwise 0.

Return every input item with the same index i.`;

const ENRICH_SCHEMA = {
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          i: { type: "INTEGER" },
          blurb: { type: "STRING" },
          spicy: { type: "INTEGER" },
          allergens: { type: "ARRAY", items: { type: "STRING" } },
          wikiTitle: { type: "STRING" },
          photoQuery: { type: "STRING" },
          estPrice: { type: "NUMBER" },
        },
        required: ["i", "blurb", "spicy", "allergens", "wikiTitle", "photoQuery", "estPrice"],
      },
    },
  },
  required: ["items"],
};

const ENRICH_VERSION = 2; // bump when the prompt changes to re-enrich everything
// The cache key describes what the dish is, not what it costs: a price change keeps the description,
// spice and allergens. Only "price missing" matters, because then an estimate is needed.
const enrichKey = (d) => hash([ENRICH_VERSION, "k3", d.name, d.descriptionRu, d.price == null, d.spicySource, d.category]);
const legacyEnrichKey = (d) => hash([ENRICH_VERSION, d.name, d.descriptionRu, d.price, d.spicySource, d.category]);

// Older caches were keyed with the price; move them to the new key while the price is still the same.
function migrateEnrichmentKeys(dishes, cache) {
  let moved = 0;
  for (const d of dishes) {
    const entry = cache[d.id];
    if (entry && entry.key !== enrichKey(d) && entry.key === legacyEnrichKey(d)) {
      entry.key = enrichKey(d);
      moved++;
    }
  }
  return moved;
}

async function enrichMissing(dishes, stalls, cache) {
  const missing = dishes.filter((d) => cache[d.id]?.key !== enrichKey(d));
  if (!missing.length) return 0;
  if (!useAi || !hasGeminiKey()) {
    console.log(`  ${missing.length} items not enriched (${useAi ? "no GEMINI_API_KEY" : "--no-ai"}); their spice and allergens stay unknown`);
    return 0;
  }
  console.log(`  enriching ${missing.length} items with Gemini…`);
  const BATCH = 30;
  let done = 0;
  const byStall = new Map();
  for (const d of missing) byStall.set(d.stallId, [...(byStall.get(d.stallId) ?? []), d]);
  const batches = [...byStall.entries()].flatMap(([stallId, items]) => {
    const out = [];
    for (let s = 0; s < items.length; s += BATCH) out.push({ stallId, items: items.slice(s, s + BATCH) });
    return out;
  });

  for (const [n, { stallId, items }] of batches.entries()) {
    const stall = stalls.find((s) => s.id === stallId);
    const priced = dishes
      .filter((d) => d.stallId === stallId && d.price != null)
      .slice(0, 120)
      .map((d) => `${d.name} (${d.category}): ${d.priceText}`)
      .join("; ");
    const lines = items.map((d, i) =>
      [i, d.name, `category ${d.category}`, `price ${d.price == null ? "none" : d.priceText}`,
        `photoHint ${["none", "slight", "medium", "very"][d.spicySource] ?? "unknown"}`, `veg ${d.vegetarian ?? "?"}`, d.temperature ?? "", `desc: ${d.description ?? ""}`].join(" | "),
    );
    const prompt = `STALL: ${stall.name} (${stall.cuisine})\nPRICED ITEMS AT THIS STALL: ${priced}\n\nITEMS:\n${lines.join("\n")}`;
    try {
      const { data, model } = await generateJson({
        system: ENRICH_SYSTEM,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        schema: ENRICH_SCHEMA,
        temperature: 0.3,
        timeoutMs: 120000,
        budgetMs: 300000,
      });
      for (const r of data.items ?? []) {
        const d = items[r.i];
        if (!d || !r.blurb?.trim()) continue;
        cache[d.id] = {
          key: enrichKey(d),
          blurb: r.blurb.trim().slice(0, 160),
          spicy: Math.max(0, Math.min(5, Math.round(Number(r.spicy) || 0))),
          allergens: [...new Set((r.allergens ?? []).map((a) => a.toLowerCase().trim()).filter((a) => ALLERGENS.includes(a)))],
          wikiTitle: (r.wikiTitle ?? "").trim(),
          photoQuery: (r.photoQuery ?? "").trim(),
          estPrice: d.price == null && Number(r.estPrice) > 0 ? Math.round(Number(r.estPrice) * 10) / 10 : null,
          model,
        };
        done++;
      }
      if (!checkOnly) writeFileSync(ENRICHMENT, JSON.stringify(cache, null, 1));
      console.log(`  enrichment batch ${n + 1}/${batches.length} (${stall.name}) ok (${model})`);
    } catch (error) {
      console.warn(`  enrichment batch ${n + 1} failed: ${error.message.split("\n")[0]} - run import again to retry`);
    }
  }
  return done;
}

function applyEnrichment(d, e) {
  if (d.price == null) {
    if (e?.estPrice) {
      d.price = e.estPrice;
      d.priceMax = e.estPrice;
      d.priceText = `~${rm(e.estPrice)}`;
      d.priceEstimated = true;
      d.priceNote = "Not shown on the menu board - estimated from similar items at this stall.";
    } else {
      d.priceText = "Price not listed";
    }
  }
  if (!e) {
    // Without an AI estimate: spice from the photo hint (if any), allergens unknown (never "none").
    d.spicy = d.spicySource == null ? null : Math.round((d.spicySource * 5) / 3);
    d.allergens = null;
    return;
  }
  const clean = (s) => (s && !/^(null|none|n\/a|unknown)$/i.test(s.trim()) ? s.trim() : null);
  d.blurb = e.blurb;
  d.spicy = e.spicy;
  d.allergens = e.allergens;
  if (!d.photoFixed) {
    d.photoTitle = clean(e.wikiTitle);
    d.photoQuery = clean(e.photoQuery);
  }
  d.photoKey = slug(d.photoTitle || d.photoQuery || d.name);
}

// ---------- Output: diff, backup, atomic write ----------

const TRACKED = ["name", "stallId", "category", "role", "price", "priceMax", "priceText", "priceEstimated", "available",
  "days", "availableAfter", "vegetarian", "vegan", "allergens", "spicy"];

function diffMenus(previous, next) {
  const before = new Map(previous.map((d) => [d.id, d]));
  const after = new Set(next.map((d) => d.id));
  const added = next.filter((d) => !before.has(d.id)).map((d) => ({ id: d.id, name: d.name }));
  const removed = previous.filter((d) => !after.has(d.id)).map((d) => ({ id: d.id, name: d.name }));
  const changed = [];
  for (const d of next) {
    const old = before.get(d.id);
    if (!old) continue;
    const fields = {};
    for (const key of TRACKED) {
      if (JSON.stringify(old[key] ?? null) !== JSON.stringify(d[key] ?? null)) fields[key] = [old[key] ?? null, d[key] ?? null];
    }
    if (Object.keys(fields).length) changed.push({ id: d.id, name: d.name, fields });
  }
  return { added, removed, changed };
}

function writeAtomic(path, text) {
  writeFileSync(`${path}.tmp`, text);
  JSON.parse(readFileSync(`${path}.tmp`, "utf8")); // the written file must parse back
  renameSync(`${path}.tmp`, path);
}

const BACKUP_FILES = ["dishes.json", "stalls.json", "import-report.json"];
const KEEP_BACKUPS = 10;

function backupCurrent() {
  if (!existsSync(join(DATA, "dishes.json"))) return null;
  const dir = join(DATA, "backups", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  for (const f of BACKUP_FILES) if (existsSync(join(DATA, f))) copyFileSync(join(DATA, f), join(dir, f));
  const all = readdirSync(join(DATA, "backups")).filter((f) => /^\d{4}-/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) rmSync(join(DATA, "backups", old), { recursive: true, force: true });
  return dir;
}

function rolesMarkdown(dishes, stalls, report) {
  const stallName = Object.fromEntries(stalls.map((s) => [s.id, s.name]));
  const rows = (list) => list.map((d) => `| ${d.name} | ${stallName[d.stallId]} | ${d.role} | ${d.roleBasis.replace(/\|/g, "/")} | \`${d.id}\` |`).join("\n");
  const disputed = dishes.filter((d) => d.roleDisputed || d.role === "unknown");
  const manual = dishes.filter((d) => d.roleBasis?.startsWith("Manual:") && !disputed.includes(d));
  return `# Menu item roles

Generated by \`npm run import\` on ${report.importedAt.slice(0, 10)}. Do not edit by hand: change section rules in
\`lib/roles.js\` or single items in \`data/menu-overrides.json\`, then re-run the import.

Roles decide what the lunch finder may offer: only \`main\` items are offered as the dish and only \`drink\` items as the drink.
\`unknown\` items stay visible in the menu and search but are never offered as a full lunch.

## Counts

| Role | Items |
|---|---|
${Object.entries(report.counts.byRole).map(([r, n]) => `| ${r} | ${n} |`).join("\n")}

## Section rules (\`lib/roles.js\`)

- Drinks on the menu board → \`drink\`.
- Plated rice, noodle, bread and pasta sections → \`main\`.
- Snacks, appetisers, sides, single pieces, oden, roti/naan/chapati/tosai, toast → \`side\`.
- Add-ons and toppings → \`addon\`; desserts → \`dessert\`.
- Counter, "prepared dish", Korean section, soups and the turmeric section mix meals and single dishes → \`unknown\` until decided per item.

## Disputed or unclear items (${disputed.length})

These need a check at the counter. Each decision and its reason is in \`data/menu-overrides.json\`.

| Item | Stall | Role | Basis | ID |
|---|---|---|---|---|
${rows(disputed)}

## Other manual decisions (${manual.length})

| Item | Stall | Role | Basis | ID |
|---|---|---|---|---|
${rows(manual)}
`;
}

// ---------- Main ----------

const { files, compiledOn, menus } = loadMenus();
console.log(`Sources: ${files.map((f) => f.file).join(", ")}`);

const stalls = [];
const dishes = [];
const perStall = [];
for (const { menu, team } of menus) {
  const cuisine = cuisineName(menu.cuisine);
  const stallId = slug(ID_LABEL[menu.cuisine] ?? menu.cuisine);
  const converted = [
    ...(menu.items ?? []).map((item) => convertItem(item, { stallId, cuisine, isDrink: false, addedByTeam: team.items.has(String(item.id)) })),
    ...(menu.drinks ?? []).map((item) => convertItem(item, { stallId, cuisine, isDrink: true, addedByTeam: team.drinks.has(String(item.id)) })),
  ];
  dishes.push(...converted);
  stalls.push(convertStall(menu, cuisine, stallId, converted.length));
  perStall.push({ stall: cuisine, items: converted.length, noPriceOnBoard: converted.filter((d) => d.price == null).length, skippedUnclear: (menu.unresolved_items ?? []).length });
}

const translations = readJson(TRANSLATIONS, {});
const translated = await translateMissing([...dishes.map((d) => d.descriptionRu), ...stalls.map((s) => s.menuNoteRu)], translations);
for (const d of dishes) d.description ??= translations[d.descriptionRu] ?? d.descriptionRu;
for (const s of stalls) s.menuNote = translations[s.menuNoteRu] ?? s.menuNoteRu;

const enrichment = readJson(ENRICHMENT, {});
const migrated = migrateEnrichmentKeys(dishes, enrichment);
if (migrated && !checkOnly) writeAtomic(ENRICHMENT, JSON.stringify(enrichment, null, 1));
const enriched = await enrichMissing(dishes, stalls, enrichment);
for (const d of dishes) applyEnrichment(d, enrichment[d.id]?.key === enrichKey(d) ? enrichment[d.id] : null);

const overrideResult = applyOverrides(dishes, loadOverrides());

const { errors, warnings } = validateMenu({ stalls, dishes });
if (errors.length) fail(errors);

const importedAt = new Date().toISOString();
const previous = readJson(join(DATA, "dishes.json"), { dishes: [] }).dishes ?? [];
const changes = diffMenus(previous, dishes);
const byRole = Object.fromEntries(ROLES.map((r) => [r, dishes.filter((d) => d.role === r).length]));
const report = {
  _note: "Written by tools/import-menu.js. Compares this import with the previous data/dishes.json.",
  importedAt,
  sourceCompiledOn: compiledOn,
  sources: files,
  counts: {
    stalls: stalls.length,
    items: dishes.length,
    byRole,
    estimatedPrices: dishes.filter((d) => d.priceEstimated).length,
    noPrice: dishes.filter((d) => d.price == null).length,
    unknownSpice: dishes.filter((d) => d.spicy == null).length,
    unknownAllergens: dishes.filter((d) => d.allergens == null).length,
    timeRestricted: dishes.filter((d) => d.availableAfter).length,
    dayRestricted: dishes.filter((d) => d.days).length,
  },
  changes: { added: changes.added.length, changed: changes.changed.length, removed: changes.removed.length, ...changes },
  overrides: overrideResult,
  disputed: dishes.filter((d) => d.roleDisputed || d.role === "unknown").map((d) => ({ id: d.id, name: d.name, role: d.role, basis: d.roleBasis })),
  warnings: [...warnings, ...overrideResult.missing.map((id) => `menu-overrides.json: no item ${id} in this import`)],
  ai: { translatedNow: translated, enrichedNow: enriched, cacheKeysMigrated: migrated, usedAi: useAi && hasGeminiKey() },
};

console.table(perStall);
console.log(`Items: ${dishes.length} · roles ${Object.entries(byRole).map(([r, n]) => `${r} ${n}`).join(", ")}`);
console.log(`Changes since the previous menu: ${changes.added.length} added, ${changes.changed.length} changed, ${changes.removed.length} removed.`);
for (const c of changes.changed.slice(0, 15)) console.log(`  ~ ${c.id}: ${Object.entries(c.fields).map(([k, [a, b]]) => `${k} ${JSON.stringify(a)} → ${JSON.stringify(b)}`).join("; ")}`);
if (report.warnings.length) console.log(`Warnings: ${report.warnings.length} (see import-report.json)`);

if (checkOnly) {
  console.log("Check only: nothing was written.");
  process.exit(0);
}

const backup = backupCurrent();
report.backup = backup ? relative(DATA, backup).replace(/\\/g, "/") : null;
const meta = {
  _note: "Generated by tools/import-menu.js from data/source - edit the source files and re-run `npm run import`.",
  sources: files.map((f) => f.file),
  generatedAt: importedAt,
  sourceCompiledOn: compiledOn,
  halalNote: campus.allHalal ? campus.halalNote : null,
  disclaimer:
    "Short descriptions, spice level (0-5), allergens and prices marked ~ are estimates made with AI from the menu photos " +
    "and usual recipes - ask the stall if you have a severe allergy.",
};
writeAtomic(join(DATA, "stalls.json"), JSON.stringify({ ...meta, stalls }, null, 2));
writeAtomic(join(DATA, "dishes.json"), JSON.stringify({ ...meta, dishes }, null, 2));
writeAtomic(join(DATA, "import-report.json"), JSON.stringify(report, null, 2));
if (isProjectData) writeFileSync(join(root, "docs", "menu-roles.md"), rolesMarkdown(dishes, stalls, report));

console.log(`Missing blurb: ${dishes.filter((d) => !d.blurb).length}, estimated prices: ${report.counts.estimatedPrices}, still no price: ${report.counts.noPrice}.`);
console.log(`Translated now: ${translated}. Enriched now: ${enriched}. Cache keys migrated: ${migrated}.`);
console.log(`Backup of the previous menu: ${report.backup ?? "none (first import)"}. Report: data/import-report.json.`);
console.log("Next: npm run photos (fetch missing photos), then restart the server.");
