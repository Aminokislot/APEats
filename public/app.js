import {
  DIETS, ALLERGENS, ROLE_LABELS, BASE_LABELS, fitsDiet, fitsSpiceFilter, fitsPrefs, fitsBudget, spiceNote, spiceLabel, formatSen,
} from "/shared/filters.js";
import {
  WEEKDAYS, createLatest, createLunchSession, optionLabel, prefsText, provenance, requestParts, selectedLunchPayload,
} from "/shared/journey.js";

const CATEGORY_ORDER = ["Rice", "Noodles", "Soup", "Roti & Breakfast", "Burgers & Wraps", "Mains", "Sushi & Bento",
  "Counter dishes", "Snacks & Sides", "Desserts", "Drinks", "Add-ons"];
const MEAL_CATEGORIES = ["Rice", "Noodles", "Soup", "Mains", "Burgers & Wraps", "Sushi & Bento", "Roti & Breakfast"];
const PREFS_KEY = "apeats.prefs.v3"; // v3: diet + allergens only
const VOTER_KEY = "apeats.voter";
const LUNCH_KEY = "apeats.lunch.v1"; // last lunch form choices (per-browser convenience)
const SUGGESTIONS = [
  "I have RM10, something not spicy",
  "What's a good first Malaysian dish to try?",
  "Vegetarian lunch ideas?",
  "What is nasi lemak?",
];
// priceMin / priceMax: null means "no limit" (slider at its end).
const DEFAULT_FILTERS = {
  search: "", stall: "all", category: "all", spicy: "any", priceMin: null, priceMax: null, sort: "category",
  mainsOnly: false, vegetarian: false, today: true, usePrefs: true,
};
const SPICY_OPTIONS = [["any", "Any"], ["not-spicy", "Not spicy"], ["spicy", "Spicy"]];
const SORT_OPTIONS = [["category", "Category"], ["price", "Cheapest"], ["name", "A–Z"]];
const PRICE_STEP = 0.5;
const priceBounds = { min: 0, max: 20 }; // set from the menu after loading

const state = {
  stalls: [],
  dishes: [],
  byId: new Map(),
  clock: null,
  gemini: false,
  provider: "offline",
  asking: false,
  voting: false,
  conversationConstraints: null, // chat restrictions as the server last returned them
  focus: null, // what Ask is discussing: a selected lunch, one dish, or nothing
  meta: {},
  poll: { favorites: {}, favoriteVotes: 0, ratings: {}, mine: { favorite: null, ratings: {} } },
  prefs: loadPrefs(),
  filters: { ...DEFAULT_FILTERS },
  expanded: new Set(), // opened by the student (normal view)
  collapsed: new Set(), // closed by the student while searching
  history: [],
  openDish: null,
};

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const icon = (name, cls = "") => `<svg${cls ? ` class="${cls}"` : ""} aria-hidden="true"><use href="#i-${name}"/></svg>`;
const dateText = (value) => {
  if (!value) return "";
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};

// ---------- Local storage (per-device conveniences only) ----------

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: kept for this visit only */
  }
}

function loadPrefs() {
  const defaults = { diet: "any", avoidAllergens: [] };
  try {
    const saved = JSON.parse(storageGet(PREFS_KEY) ?? "{}");
    return { diet: DIETS.includes(saved.diet) ? saved.diet : defaults.diet, avoidAllergens: Array.isArray(saved.avoidAllergens) ? saved.avoidAllergens.filter(x=>ALLERGENS.includes(x)) : [] };
  } catch {
    return defaults;
  }
}

// Anonymous id so a student has one vote; it lives only on this device.
const voterId = (() => {
  let id = storageGet(VOTER_KEY);
  if (!id || !/^[a-z0-9-]{8,64}$/.test(id)) {
    id = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).toLowerCase();
    storageSet(VOTER_KEY, id);
  }
  return id;
})();

// signal: lets a newer request cancel this one (see createLatest in shared/journey.js).
async function api(path, { signal, ...options } = {}) {
  let response;
  const timeout = AbortSignal.timeout(35000);
  try {
    response = await fetch(path, { ...options, signal: signal && AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal ?? timeout });
  } catch (error) {
    throw new Error(error.name === "TimeoutError" ? "The server took too long to answer."
      : error.name === "AbortError" ? "Cancelled." : "Can't reach the APEats server. Check your connection.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `The server answered with an error (${response.status}).`);
  return data;
}

const postJson = (path, body, signal) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });

// Lunch results on screen: which choices produced them, the newest request wins, who selected each option.
const lunch = createLunchSession({ post: postJson, onChange: () => renderLunch() });

// ---------- Dish facts ----------

const stallOf = (dish) => state.stalls.find((s) => s.id === dish.stallId);
const today = () => WEEKDAYS[state.clock?.weekday ?? 0];

// "On today's menu" means the menu schedule allows it today. Actual stock is not tracked.
function onTodaysMenu(dish) {
  if (dish.available === false) return false;
  return !dish.days || dish.days.includes(today());
}

function spiceHtml(dish) {
  const note = spiceNote(dish);
  if (!note) return "";
  return ` <span class="spice-note${note.startsWith("A little") ? " little" : ""}">${note}.</span>`;
}

function thumb(dish, cls = "thumb") {
  if (dish.photo) return `<img class="${cls}" src="${escapeHtml(dish.photo.src)}" alt="" loading="lazy">`;
  return `<span class="${cls} placeholder" title="No photo yet">${icon(dish.role === "drink" || dish.category === "Drinks" ? "cup" : "bowl")}</span>`;
}

function starsHtml(stallId, { compact = false } = {}) {
  const r = state.poll.ratings[stallId];
  if (!r?.count) return `<span class="stars">No poll ratings yet</span>`;
  const filled = Math.round(r.avg);
  const row = Array.from({ length: 5 }, (_, i) => icon("star", i < filled ? "on" : "")).join("");
  return `<span class="stars" aria-label="Poll average ${r.avg} out of 5 from ${r.count} anonymous ratings"><span class="row">${row}</span><b>${r.avg.toFixed(1)}</b>${compact ? "" : ` (${r.count})`}</span>`;
}

// ---------- Find my lunch ----------

function renderPrefsSummary() {
  const text = prefsText(state.prefs);
  const used = $("#use-prefs").checked;
  $("#prefs-summary").innerHTML = !used
    ? `Saved preferences are <b>not used</b> for this search${text ? ` (${escapeHtml(text)})` : ""}. <a href="#me" data-goto="prefs">Change</a>`
    : text
      ? `Saved: <b>${escapeHtml(text)}</b>. <a href="#me" data-goto="prefs">Change</a>`
      : `No diet or allergy saved yet. <a href="#me" data-goto="prefs">Add them</a>`;
}

function loadLunchChoices() {
  try {
    return JSON.parse(storageGet(LUNCH_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function renderLunchForm() {
  const lunch = state.meta.lunch ?? {};
  const presets = lunch.presets?.length ? lunch.presets : [10];
  const saved = loadLunchChoices();
  const preferred = presets.includes(saved.budget) ? saved.budget : presets.includes(10) ? 10 : presets[Math.floor(presets.length / 2)];
  const custom = saved.budget != null && !presets.includes(saved.budget);
  $("#budget-choices").innerHTML = [
    ...presets.map((rm) => `<label class="choice"><input type="radio" name="budget" value="${rm}"${!custom && rm === preferred ? " checked" : ""}>RM${rm}</label>`),
    `<label class="choice"><input type="radio" name="budget" value="other"${custom ? " checked" : ""}>Other</label>`,
  ].join("");
  $("#budget-other").hidden = !custom;
  if (custom) $("#budget-input").value = saved.budget;
  $("#budget-hint").textContent = lunch.typicalFromSen
    ? `Half of the main dishes cost between ${formatSen(lunch.typicalFromSen)} and ${formatSen(lunch.typicalToSen)}.`
    : "";
  if (saved.spice) document.querySelector(`input[name="spice"][value="${saved.spice === "not-spicy" ? "not-spicy" : "any"}"]`).checked = true;
  if (saved.meal) document.querySelector(`input[name="meal"][value="${saved.meal === "main" ? "main" : "drink"}"]`).checked = true;
  if (typeof saved.usePrefs === "boolean") $("#use-prefs").checked = saved.usePrefs;
  renderPrefsSummary();
}

// The choices on the form right now, without validation messages. budget is null while it is not a valid amount.
function currentChoices() {
  const choice = document.querySelector('input[name="budget"]:checked')?.value;
  const raw = choice === "other" ? $("#budget-input").value.trim().replace(",", ".") : choice;
  const budget = Number(raw);
  return {
    budget: raw && Number.isFinite(budget) && budget >= 1 && budget <= 100 ? Math.round(budget * 100) / 100 : null,
    budgetIsOther: choice === "other",
    spice: document.querySelector('input[name="spice"]:checked').value,
    withDrink: document.querySelector('input[name="meal"]:checked').value === "drink",
    usePrefs: $("#use-prefs").checked,
    prefs: state.prefs,
    day: "today",
    weekday: state.clock?.weekday,
  };
}

// Reads and checks the form. Returns the request body, or null after showing the problem.
function readLunchForm() {
  const c = currentChoices();
  const error = $("#budget-error");
  if (c.budget == null) {
    error.textContent = "Enter a budget between RM1 and RM100.";
    error.hidden = false;
    $("#budget-input").setAttribute("aria-invalid", "true");
    (c.budgetIsOther ? $("#budget-input") : document.querySelector('input[name="budget"]')).focus();
    return null;
  }
  error.hidden = true;
  $("#budget-input").removeAttribute("aria-invalid");
  storageSet(LUNCH_KEY, JSON.stringify({ budget: c.budget, spice: c.spice, meal: c.withDrink ? "drink" : "main", usePrefs: c.usePrefs }));
  return { budget: c.budget, spice: c.spice, withDrink: c.withDrink, usePrefs: c.usePrefs, prefs: c.prefs, day: c.day };
}

function sourceBanner() {
  const { kind, text } = provenance(lunch.state.options, lunch.state.result);
  const cls = kind === "fallback" || kind === "rejected" ? "warn" : kind === "ai" || kind === "mixed" ? "ai" : "rules";
  const symbol = cls === "warn" ? "alert" : cls === "ai" ? "spark" : "check";
  return `<p class="source-banner ${cls}" data-provenance="${kind}">${icon(symbol)}<span>${escapeHtml(text)}</span></p>`;
}

function optionItem(item) {
  const dish = state.byId.get(item.dishId) ?? { name: item.name, role: item.role };
  const role = item.role === "drink" ? "Drink" : "Main dish";
  return `
    <li class="opt-item">
      ${thumb(dish, "opt-thumb")}
      <div class="opt-item-body">
        <span class="role-chip ${item.role}">${role}</span>
        <button type="button" class="link-btn opt-name" data-dish="${escapeHtml(item.dishId)}">${escapeHtml(item.name)}</button>
        ${item.about ? `<span class="opt-about">${escapeHtml(item.about)}</span>` : ""}
        <span class="opt-stall">${icon("store")}${escapeHtml(item.stallName)} counter</span>
        ${item.notes.map((n) => `<small class="opt-note">${escapeHtml(n)}</small>`).join("")}
      </div>
      <span class="opt-price">${formatSen(item.priceSen)}</span>
    </li>`;
}

// What this option was checked for, in the student's words. Estimates are named as estimates.
function checkedFor(request) {
  const parts = [];
  if (request.spice === "not-spicy") parts.push("not spicy (our estimate)");
  if (request.prefs.diet === "vegetarian") parts.push("vegetarian (by the dish name)");
  if (request.prefs.diet === "vegan") parts.push("vegan (confirmed only)");
  if (request.prefs.avoidAllergens.length) parts.push(`no ${request.prefs.avoidAllergens.join(", ")} in our estimate of the usual recipe`);
  return parts;
}

function optionCard(option, index, { stale, busy }) {
  const request = lunch.state.result.request;
  const main = state.byId.get(option.items[0].dishId);
  const counters = option.singleStall
    ? `<span class="badge one">${icon("store")}One counter</span>`
    : `<span class="badge two">${icon("alert")}Two counters: ${escapeHtml(option.items.map((i) => i.stallName).join(" and "))}</span>`;
  const kind = option.mainOnly ? "Main dish only" : "Main dish + drink";
  const tags = [];
  if (main?.base && BASE_LABELS[main.base]) tags.push(BASE_LABELS[main.base]);
  if (main) tags.push(`${spiceLabel(main)}${Number.isFinite(main.spicy) ? " (estimate)" : ""}`);
  const checks = checkedFor(request);
  const locked = stale || busy ? " disabled" : "";
  return `
    <article class="card lunch-option${stale ? " outdated" : ""}" data-option="${index}" aria-labelledby="opt-title-${index}"${lunch.state.swappingIndex === index ? ' aria-busy="true"' : ""}>
      <header class="opt-head">
        <h3 id="opt-title-${index}">Option ${index + 1} <span class="opt-kind${option.mainOnly && option.drinkRequested ? " warn" : ""}">${kind}</span></h3>
        ${counters}
      </header>
      ${option.mainOnly && option.drinkRequested ? `<p class="opt-drink-note">${icon("cup")}<span><b>Main dish only, no drink.</b> ${escapeHtml(option.drinkNote ?? "No suitable drink fits this lunch.")}</span></p>` : ""}
      <ul class="opt-items">${option.items.map(optionItem).join("")}</ul>
      <div class="opt-total">
        <span>Total</span>
        <b>${formatSen(option.totalSen)}</b>
      </div>
      <p class="opt-left">${formatSen(option.remainingSen)} left of your ${formatSen(option.budgetSen)}</p>
      ${tags.length ? `<div class="tags">${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
      ${checks.length ? `<p class="opt-checked">${icon("check")}<span>Checked for: ${escapeHtml(checks.join(" · "))}.</span></p>` : ""}
      <p class="opt-why"><b>${option.whySource === "ai" ? "Why this (written by AI):" : "Menu notes:"}</b> ${escapeHtml(option.why)}</p>
      <div class="opt-actions">
        <button type="button" class="btn outline" data-details="${index}">Details</button>
        <button type="button" class="btn outline" data-swap="${index}"${locked}>${icon("swap")}Show another</button>
        <button type="button" class="btn text" data-ask-option="${index}"${locked}>${icon("spark")}Ask about it</button>
        <span class="by-chip ${option.selectedBy === "rules" ? "rules" : "ai"}">${escapeHtml(optionLabel(option))}</span>
      </div>
      <p class="swap-note" id="swap-note-${index}" role="status"${swapNotes.has(index) ? "" : " hidden"}>${escapeHtml(swapNotes.get(index) ?? "")}</p>
    </article>`;
}

// One-line messages under an option ("Replaced with…"). Cleared by every new search.
const swapNotes = new Map();

function renderLunchLoading() {
  $("#lunch-out").innerHTML = `
    <p class="status-line">${icon("spark")}Checking prices, availability and your choices…</p>
    ${[0, 1].map(() => `<div class="card skeleton" aria-hidden="true"><span></span><span></span><span></span></div>`).join("")}`;
}

function renderLunchError(message) {
  $("#lunch-out").innerHTML = `
    <div class="card state-card error" role="alert">
      <h3>${icon("alert")}We couldn't get lunch ideas</h3>
      <p>${escapeHtml(message)}</p>
      <p class="muted">Your choices are kept. You can try again, or browse the Menu tab.</p>
      <button type="button" class="btn primary" id="lunch-retry">Try again</button>
    </div>`;
}

// Results always say which choices produced them. When the form or the saved preferences no longer match,
// the results are marked outdated and the actions that would rely on them are switched off.
function renderLunchResult() {
  const { result, options } = lunch.state;
  const changes = lunch.changes(currentChoices());
  const stale = changes.length > 0;
  const head = `<h3 class="results-head" id="lunch-results-head" tabindex="-1">Lunch ideas</h3>
    <ul class="made-for" aria-label="These results were made for">${requestParts(result.request).map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>`;
  const outdated = stale ? `
    <div class="card outdated-banner" role="status" id="lunch-outdated">
      <p>${icon("alert")}<span><b>These results are out of date.</b> Your choices changed: ${escapeHtml(changes.join("; "))}.</span></p>
      <button type="button" class="btn primary" id="lunch-update">Update results</button>
    </div>` : "";
  if (!options.length) {
    const empty = result.empty ?? { message: "No lunch matches all of your choices.", hints: [] };
    $("#lunch-out").innerHTML = `${head}${outdated}
      <div class="card state-card empty${stale ? " outdated" : ""}">
        <h3>${icon("info")}${escapeHtml(empty.message)}</h3>
        ${empty.hints.length ? `<ul>${empty.hints.map((h) => `<li>${escapeHtml(h)}</li>`).join("")}</ul>` : ""}
        <div class="btn-row">
          ${empty.cheapestSen && !stale ? `<button type="button" class="btn primary" data-try-budget="${empty.cheapestSen}">Try ${formatSen(empty.cheapestSen)}</button>` : ""}
          <button type="button" class="btn outline" data-goto="menu">Browse the menu</button>
        </div>
      </div>`;
    return;
  }
  const busy = lunch.state.swappingIndex != null;
  // The AI's opening sentence described its three picks; after a swap it no longer describes the cards.
  const intro = result.intro && !lunch.state.swapped ? `<p class="lunch-intro">${escapeHtml(result.intro)}</p>` : "";
  $("#lunch-out").innerHTML = `${head}${outdated}
    ${sourceBanner()}
    ${intro}
    ${options.map((o, i) => optionCard(o, i, { stale, busy })).join("")}
    <p class="fine-print">Prices are from the menu boards and are counted at their highest shown value. Descriptions, spice and allergen notes are estimates of the usual recipe, not checked with the stall. Please confirm at the counter.</p>`;
}

let lastLunchView = "";
function renderLunch() {
  const s = lunch.state;
  const button = $("#lunch-submit");
  button.disabled = s.status === "loading";
  button.textContent = s.status === "loading" ? "Checking the menu…" : "Find my lunch";
  $("#lunch-out").setAttribute("aria-busy", String(s.status === "loading"));
  if (s.status === "loading") renderLunchLoading();
  else if (s.status === "error") renderLunchError(s.error);
  else if (s.status === "ready") renderLunchResult();
  lastLunchView = lunchViewKey();
}

// Re-render only when staleness actually changed (the form fires on every keystroke).
const lunchViewKey = () => (lunch.state.status === "ready" ? lunch.changes(currentChoices()).join("|") : "");
function refreshLunchStale() {
  renderPrefsSummary();
  if (lunch.state.status === "ready" && lunchViewKey() !== lastLunchView) renderLunchResult();
  lastLunchView = lunchViewKey();
}

async function findLunch(body = readLunchForm()) {
  if (!body) return;
  swapNotes.clear();
  const outcome = await lunch.find(body);
  if (outcome !== "ok") return;
  $("#lunch-results-head")?.focus({ preventScroll: true });
  $("#lunch-results-head")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

const SWAP_MESSAGES = {
  none: "No other lunch matches these choices. This option stays.",
  stale: "Your choices changed. Update the results first.",
};
async function swapOption(index) {
  swapNotes.delete(index);
  const outcome = await lunch.swap(index, currentChoices());
  if (outcome.reason === "superseded" || outcome.reason === "busy" || outcome.reason === "not_ready") return;
  swapNotes.set(index, outcome.ok ? "Replaced with another rules-based menu match for the same choices."
    : outcome.reason === "error" ? `${outcome.message} Try again.` : SWAP_MESSAGES[outcome.reason]);
  renderLunch();
  if (outcome.ok) document.querySelector(`[data-option="${index}"] .opt-name`)?.focus();
}

// Opens Ask with the whole selected lunch: main dish, drink, budget and the preferences that applied.
function askAboutOption(index) {
  const option = lunch.state.options[index];
  const request = lunch.state.result?.request;
  if (!option || !request || lunch.isStale(currentChoices())) return;
  startFocus({
    type: "lunch",
    payload: selectedLunchPayload(option, request, lunch.state.result.menuVersion),
    view: { ...option, weekday: request.weekday, dayName: WEEKDAYS[request.weekday], spice: request.spice, usePrefs: request.usePrefs !== false, prefs: request.prefs, issues: [] },
  });
  showTab("ask");
  const main = option.items[0];
  ask(`What is ${main.name}? Is this lunch a good choice for me?`);
}

// ---------- Menu ----------

function filtersActive() {
  const f = state.filters;
  return Boolean(f.search.trim()) || f.stall !== "all" || f.category !== "all" || f.spicy !== "any" ||
    f.priceMin != null || f.priceMax != null || f.vegetarian || f.mainsOnly ||
    (f.usePrefs && (state.prefs.diet !== 'any' || state.prefs.avoidAllergens.length > 0));
}

// Items without a price only show while the price range is not narrowed.
function fitsPriceRange(dish) {
  const { priceMin, priceMax } = state.filters;
  if (priceMin == null && priceMax == null) return true;
  if (dish.price == null || dish.priceEstimated) return false;
  return (priceMin == null || dish.price >= priceMin) && fitsBudget(dish, priceMax);
}

function matchingDishes() {
  const f = state.filters;
  const query = f.search.trim().toLowerCase();
  return state.dishes.filter((d) => {
    if (query && ![d.name, d.cuisine, d.category, d.blurb, d.description, stallOf(d)?.brand].join(" ").toLowerCase().includes(query)) return false;
    if (f.stall !== "all" && d.stallId !== f.stall) return false;
    if (f.category === "all" ? d.category === "Add-ons" && !query : d.category !== f.category) return false;
    if (f.mainsOnly && d.role !== "main") return false;
    if (f.vegetarian && !fitsDiet(d, "vegetarian")) return false;
    if (!fitsSpiceFilter(d, f.spicy)) return false;
    if (!fitsPriceRange(d)) return false;
    if (f.today && !onTodaysMenu(d)) return false;
    if (f.usePrefs && !fitsPrefs(d, state.prefs)) return false;
    return true;
  });
}

function sortDishes(list) {
  const last = (v) => (v == null ? Infinity : v);
  const catIndex = (d) => {
    const i = CATEGORY_ORDER.indexOf(d.category);
    return i < 0 ? CATEGORY_ORDER.length : i;
  };
  const sorters = {
    category: (a, b) => catIndex(a) - catIndex(b) || last(a.price) - last(b.price) || a.name.localeCompare(b.name),
    price: (a, b) => last(a.price) - last(b.price) || a.name.localeCompare(b.name),
    name: (a, b) => a.name.localeCompare(b.name),
  };
  return [...list].sort(sorters[state.filters.sort]);
}

function dishCard(dish, { showCuisine = false } = {}) {
  const tags = [];
  if (["side", "addon", "unknown"].includes(dish.role)) tags.push(`<span class="tag role">${escapeHtml(ROLE_LABELS[dish.role])}</span>`);
  if (dish.vegetarian === true) tags.push(`<span class="tag veg">${icon("leaf")}Vegetarian</span>`);
  if (dish.days) tags.push(`<span class="tag warn">${escapeHtml(dish.days.map((d) => d.slice(0, 3)).join(", "))} only</span>`);
  if (dish.availableAfter) tags.push(`<span class="tag warn">After ${escapeHtml(dish.availableAfter)} (printed menu)</span>`);
  if (dish.priceEstimated) tags.push(`<span class="tag">Price estimated</span>`);
  if (dish.available === false) tags.push(`<span class="tag warn">Not available</span>`);
  if (dish.available === null) tags.push(`<span class="tag warn">Availability not confirmed</span>`);
  return `
    <button class="item dish${onTodaysMenu(dish) ? "" : " dim"}" data-dish="${escapeHtml(dish.id)}">
      ${thumb(dish)}
      <div class="body">
        <div class="item-top">
          <span class="item-title">${escapeHtml(dish.name)}</span>
          <span class="price${dish.price == null ? " unknown" : ""}">${escapeHtml(dish.priceText)}</span>
        </div>
        ${showCuisine ? `<div class="item-sub">${escapeHtml(dish.cuisine)} · ${escapeHtml(dish.category)}</div>` : ""}
        <div class="blurb">${escapeHtml(dish.blurb ?? "")}${spiceHtml(dish)}</div>
        ${tags.length ? `<div class="tags">${tags.join("")}</div>` : ""}
      </div>
    </button>`;
}

// Cover photo of each cuisine: a dish from its most common main category, never the same photo
// as another cuisine's cover. Computed once after the menu loads.
const covers = new Map();
function pickCovers() {
  const used = new Set();
  for (const stall of state.stalls) {
    const dishes = state.dishes.filter((d) => d.stallId === stall.id && d.photo);
    const counts = new Map();
    for (const d of dishes) if (MEAL_CATEGORIES.includes(d.category)) counts.set(d.category, (counts.get(d.category) ?? 0) + 1);
    const order = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    const chosen = stall.coverPhoto ? dishes.filter((d) => d.photoKey === stall.coverPhoto) : [];
    const candidates = [...chosen, ...order.flatMap((c) => dishes.filter((d) => d.category === c)), ...dishes];
    const cover = candidates.find((d) => !used.has(d.photo.src)) ?? candidates[0];
    if (cover) {
      used.add(cover.photo.src);
      covers.set(stall.id, cover);
    }
  }
}
const coverOf = (stallId) => covers.get(stallId);

function cuisineSection(stall, dishes, open) {
  const cover = coverOf(stall.id);
  const sorted = sortDishes(dishes);
  let body = "";
  if (open) {
    if (state.filters.sort === "category") {
      let current = null;
      for (const d of sorted) {
        if (d.category !== current) {
          current = d.category;
          body += `<h3 class="cat-head">${escapeHtml(current)}</h3>`;
        }
        body += dishCard(d);
      }
    } else {
      body = sorted.map((d) => dishCard(d)).join("");
    }
  }
  return `
    <section class="card cuisine" data-cuisine="${escapeHtml(stall.id)}">
      <button class="cuisine-head" aria-expanded="${open}">
        ${cover ? `<img class="cover" src="${escapeHtml(cover.photo.src)}" alt="">` : `<span class="cover placeholder">${icon("bowl")}</span>`}
        <span>
          <span class="cuisine-name">${escapeHtml(stall.name)}</span>
          ${stall.brand ? `<span class="cuisine-brand">${escapeHtml(stall.brand)}</span>` : ""}
          ${starsHtml(stall.id)}
        </span>
        <span class="cuisine-count">${dishes.length} ${dishes.length === 1 ? "item" : "items"}</span>
        ${icon("chevron", "chev")}
      </button>
      ${open ? `<div class="cuisine-body">${body}</div>` : ""}
    </section>`;
}

// While searching or filtering by cuisine, every cuisine with results opens (the student can still
// collapse one); otherwise sections start closed and the student opens them.
const autoOpen = () => Boolean(state.filters.search.trim()) || state.filters.stall !== "all";

function renderMenu() {
  const matches = matchingDishes();
  const active = filtersActive();
  const byStall = new Map(state.stalls.map((s) => [s.id, []]));
  for (const d of matches) byStall.get(d.stallId)?.push(d);

  const visible = state.stalls.filter((s) => !active || byStall.get(s.id).length);
  const isOpen = (id) => (autoOpen() ? !state.collapsed.has(id) : state.expanded.has(id));
  $("#cuisine-list").innerHTML = visible.length
    ? visible.map((s) => cuisineSection(s, byStall.get(s.id), isOpen(s.id))).join("")
    : `<p class="empty">${state.filters.usePrefs && state.prefs.diet === 'vegan' ? 'No confirmed vegan items match. Ask the stall to verify ingredients; vegetarian does not mean vegan.' : 'No items match all your filters. You can widen the search or price range while keeping your food preferences.'}</p>`;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  $("#result-count").textContent = `${plural(visible.length, "cuisine")} · ${plural(matches.length, "item")}`;
  renderFilterSummary();
}

function renderFilterSummary() {
  const f = state.filters;
  const parts = [];
  if (f.stall !== "all") parts.push(state.stalls.find((s) => s.id === f.stall)?.name);
  if (f.category !== "all") parts.push(f.category);
  if (f.spicy !== "any") parts.push(f.spicy === "spicy" ? "spicy" : "not spicy");
  if (f.priceMin != null || f.priceMax != null) parts.push(priceText());
  if (f.mainsOnly) parts.push("main dishes");
  if (f.vegetarian) parts.push("vegetarian");
  if (f.usePrefs && (state.prefs.diet !== "any" || state.prefs.avoidAllergens.length)) parts.push("my prefs");
  $("#filters-summary").textContent = parts.length ? parts.join(" · ") : "All cuisines · all categories";
}

const money = (n) => `RM${Number(n) % 1 ? Number(n).toFixed(2) : Number(n)}`;

function priceText() {
  const { priceMin, priceMax } = state.filters;
  if (priceMin == null && priceMax == null) return "Any price";
  if (priceMin == null) return `Up to ${money(priceMax)}`;
  if (priceMax == null) return `From ${money(priceMin)}`;
  return `${money(priceMin)} – ${money(priceMax)}`;
}

// Chip / segmented options: [value, label] pairs rendered as buttons with data-value.
function renderChoices(container, options, current, cls) {
  container.innerHTML = options
    .map(([value, label]) => `<button type="button" class="${cls}${value === current ? " active" : ""}" role="radio" aria-checked="${value === current}" data-value="${escapeHtml(value)}">${escapeHtml(label)}</button>`)
    .join("");
}

function fillFilterOptions() {
  const priced = state.dishes.map((d) => d.price).filter((p) => p != null);
  priceBounds.min = Math.floor(Math.min(...priced));
  priceBounds.max = Math.ceil(Math.max(...priced));
  for (const input of [$("#f-price-min"), $("#f-price-max")]) {
    input.min = priceBounds.min;
    input.max = priceBounds.max;
    input.step = PRICE_STEP;
  }
  $("#price-floor").textContent = money(priceBounds.min);
  $("#price-ceil").textContent = money(priceBounds.max);
}

function stallOptions() {
  return [["all", "All"], ...state.stalls.map((s) => [s.id, s.name])];
}

function categoryOptions() {
  const present = new Set(state.dishes.map((d) => d.category));
  const categories = [...CATEGORY_ORDER.filter((c) => present.has(c)), ...[...present].filter((c) => !CATEGORY_ORDER.includes(c))];
  return [["all", "All"], ...categories.map((c) => [c, c])];
}

function syncFilterInputs() {
  const f = state.filters;
  $("#search").value = f.search;
  renderChoices($("#f-stall"), stallOptions(), f.stall, "chip");
  renderChoices($("#f-category"), categoryOptions(), f.category, "chip");
  renderChoices($("#f-spicy"), SPICY_OPTIONS, f.spicy, "");
  renderChoices($("#f-sort"), SORT_OPTIONS, f.sort, "");
  $("#f-price-min").value = f.priceMin ?? priceBounds.min;
  $("#f-price-max").value = f.priceMax ?? priceBounds.max;
  renderPriceRange();
  $("#f-mains").checked = f.mainsOnly;
  $("#f-veg").checked = f.vegetarian;
  $("#f-today").checked = f.today;
  $("#f-prefs").checked = f.usePrefs;
}

function renderPriceRange() {
  const lo = Number($("#f-price-min").value);
  const hi = Number($("#f-price-max").value);
  const span = priceBounds.max - priceBounds.min || 1;
  $("#price-fill").style.left = `${((lo - priceBounds.min) / span) * 100}%`;
  $("#price-fill").style.right = `${100 - ((hi - priceBounds.min) / span) * 100}%`;
  $("#price-label").textContent = priceText();
}

// Two thumbs on one track; they can't cross. At the ends of the track there is no limit.
function onPriceInput(which) {
  const minInput = $("#f-price-min");
  const maxInput = $("#f-price-max");
  let lo = Number(minInput.value);
  let hi = Number(maxInput.value);
  if (lo > hi) {
    if (which === "min") lo = hi;
    else hi = lo;
    minInput.value = lo;
    maxInput.value = hi;
  }
  state.filters.priceMin = lo <= priceBounds.min ? null : lo;
  state.filters.priceMax = hi >= priceBounds.max ? null : hi;
  renderPriceRange();
  renderMenu();
}

function setFilter(key, value) {
  state.filters[key] = value;
  if (key === "search" || key === "stall") state.collapsed.clear();
  renderMenu();
}

// ---------- Dish details: what the menu says, what the team checked, what is estimated ----------

function photoCredit(photo) {
  const license = photo.licenseUrl
    ? `<a href="${escapeHtml(photo.licenseUrl)}" target="_blank" rel="noopener">${escapeHtml(photo.license)}</a>`
    : escapeHtml(photo.license);
  return `Illustrative photo of this kind of dish, not from this stall · ${escapeHtml(photo.author)} · ${license} · <a href="${escapeHtml(photo.source)}" target="_blank" rel="noopener">Wikimedia Commons</a>`;
}

function factRow(label, value, sub = "") {
  return `<div class="fact"><dt>${escapeHtml(label)}</dt><dd>${value}${sub ? `<small>${sub}</small>` : ""}</dd></div>`;
}

function openDish(id) {
  const dish = state.byId.get(id);
  if (!dish) return;
  state.openDish = dish;
  const stall = stallOf(dish);
  const diet = dish.vegan === true ? "Vegan (confirmed)"
    : dish.vegetarian === true ? "Vegetarian by its name; vegan not confirmed"
    : dish.vegetarian === false ? "Contains meat or fish (by its name)" : "Not known";
  const allergens = dish.allergens == null ? "Unknown - please ask the stall"
    : dish.allergens.length ? escapeHtml(dish.allergens.join(", ")) : "None in our estimate (this does not mean allergen-free)";
  const stallInfo = [stall?.brand, stall?.hours && `Open ${stall.hours} (printed)`, stall?.payment && `Pay: ${stall.payment.join(", ")}`].filter(Boolean).join(" · ");
  const board = [
    factRow("Price", `<b class="big-price">${escapeHtml(dish.priceText)}</b>`, escapeHtml([dish.priceNote, dish.priceCondition].filter(Boolean).join(" "))),
    factRow("Counter", escapeHtml(dish.cuisine), escapeHtml(stallInfo)),
    factRow("Section", escapeHtml(dish.category)),
    dish.includes?.length ? factRow("Comes with", escapeHtml(dish.includes.join(", "))) : "",
    dish.includesNote ? factRow("Pictured", escapeHtml(dish.includesNote)) : "",
    dish.days ? factRow("Days", escapeHtml(dish.days.join(", "))) : "",
    dish.notes?.length ? factRow("Notes", escapeHtml(dish.notes.join(" "))) : "",
  ].join("");
  const team = [
    factRow("Halal", "Yes", escapeHtml(state.meta.halalNote ?? "All listed outlets serve halal food.")),
    dish.origin === "team" ? factRow("Source", "Added by the APEats team", "This item is not on the photographed menu board.") : "",
  ].join("");
  const estimate = [
    factRow("What it is", escapeHtml(dish.blurb ?? dish.description ?? "No description yet")),
    dish.description && dish.blurb ? factRow("Typical recipe", escapeHtml(dish.description)) : "",
    factRow("Type", escapeHtml(ROLE_LABELS[dish.role] ?? "Not sure"), escapeHtml(dish.roleBasis ?? "")),
    dish.base ? factRow("Base", escapeHtml(BASE_LABELS[dish.base])) : "",
    factRow("Spice", escapeHtml(spiceLabel(dish))),
    factRow("Diet", escapeHtml(diet)),
    factRow("Likely allergens", allergens),
  ].join("");
  $("#dish-detail").innerHTML = `
    ${dish.photo
      ? `<figure class="hero"><img src="${escapeHtml(dish.photo.src)}" alt="${escapeHtml(dish.name)} (illustrative photo)"><figcaption>${photoCredit(dish.photo)}</figcaption></figure>`
      : `<div class="hero placeholder">${icon(dish.role === "drink" ? "cup" : "bowl")}<span>No photo yet</span></div>`}
    <h2 id="dish-title">${escapeHtml(dish.name)}</h2>
    <div class="item-sub">${escapeHtml(dish.cuisine)} · ${escapeHtml(ROLE_LABELS[dish.role] ?? dish.category)}</div>
    <section class="fact-group"><h3>${icon("store")}From the menu board</h3><dl>${board}</dl></section>
    <section class="fact-group"><h3>${icon("check")}Checked by the APEats team</h3><dl>${team}</dl></section>
    <section class="fact-group estimate"><h3>${icon("spark")}Estimate of the usual recipe (AI-assisted, not checked with the stall)</h3><dl>${estimate}</dl></section>
    <p class="unknown-note">${icon("info")}<span>Portion size, calories and the exact sauce or ingredients are not in our data. Ask at the counter.</span></p>`;
  $("#dish-dialog").showModal();
  $("#dish-dialog").scrollTop = 0;
}

// ---------- Vote ----------

function renderPoll() {
  const p = state.poll;
  const total = p.favoriteVotes;
  $("#fav-list").innerHTML = state.stalls
    .map((s) => {
      const votes = p.favorites[s.id] ?? 0;
      const pct = total ? Math.round((votes / total) * 100) : 0;
      return `
        <button class="poll-row${p.mine.favorite === s.id ? " mine" : ""}" data-fav="${escapeHtml(s.id)}" aria-pressed="${p.mine.favorite === s.id}">
          <span class="bar" style="width:${pct}%"></span>
          <span class="label">${escapeHtml(s.name)}${s.brand ? ` <small class="muted">${escapeHtml(s.brand)}</small>` : ""}</span>
          <span class="pct">${pct}% · ${votes}</span>
        </button>`;
    })
    .join("");
  $("#fav-total").textContent = total
    ? `${total} ${total === 1 ? "browser has" : "browsers have"} voted${p.mine.favorite ? " - thanks for your vote!" : "."}`
    : "No votes yet.";

  $("#rate-list").innerHTML = state.stalls
    .map((s) => {
      const mine = p.mine.ratings[s.id] ?? 0;
      const buttons = [1, 2, 3, 4, 5]
        .map((n) => `<button class="${n <= mine ? "on" : ""}" data-rate="${escapeHtml(s.id)}" data-stars="${n}" aria-label="${n} star${n > 1 ? "s" : ""} for ${escapeHtml(s.name)}" aria-pressed="${n === mine}">${icon("star")}</button>`)
        .join("");
      return `
        <div class="rate-row">
          <span class="who"><b>${escapeHtml(s.name)}</b>${starsHtml(s.id)}</span>
          <span class="star-buttons">${buttons}</span>
        </div>`;
    })
    .join("");
}

async function refreshPoll() {
  if (state.voting) return;
  try {
    const poll = await api(`/api/poll?voter=${encodeURIComponent(voterId)}`);
    if (state.voting) return;
    if (JSON.stringify(poll) === JSON.stringify(state.poll)) return;
    state.poll = poll;
    renderPoll();
    renderMenu();
    $("#poll-error").hidden = true;
  } catch (error) {
    $("#poll-error").textContent = "Ratings could not be refreshed. Please try again shortly.";
    $("#poll-error").hidden = false;
  }
}

async function sendVote(path, body) {
  if (state.voting) return;
  state.voting = true;
  document.querySelectorAll('[data-fav], [data-rate]').forEach(b=>b.disabled=true);
  $("#poll-error").hidden = true;
  try {
    state.poll = await postJson(path, { voter: voterId, ...body });
    renderPoll();
    renderMenu();
  } catch (error) {
    $("#poll-error").textContent = error.message;
    $("#poll-error").hidden = false;
  } finally {
    state.voting = false;
    document.querySelectorAll('[data-fav], [data-rate]').forEach(b=>b.disabled=false);
  }
}

// ---------- Ask ----------

function addBubble(role, html) {
  const bubble = document.createElement("div");
  bubble.className = `bubble ${role}`;
  bubble.innerHTML = html;
  $("#chat").append(bubble);
  bubble.scrollIntoView({ behavior: "smooth", block: "end" });
  return bubble;
}

// Says who produced the answer and what kind of answer it is. An empty list of dishes is not "nothing matches".
function chatSource(result) {
  const ai = result.source === "enterprise" ? "Gemini Enterprise" : result.source === "gemini" ? "Gemini" : null;
  if (result.warning === "unsafe_text") return "AI text was not shown because it made a claim we can't check. Facts from the menu data.";
  if (result.warning) return "AI unavailable. Answer built from the menu data by rules.";
  if (result.kind === "clarify") return "APEats needs one detail before suggesting food";
  if (result.kind === "no_match") return "No matching options. Checked by rules against the menu data.";
  if (result.kind === "unknown") return "Not enough menu information to answer";
  if (result.kind === "lunch") {
    return ai ? `Dish explanation by ${ai} (usual recipe, not checked with the stall). Items, prices and totals computed by APEats.`
      : result.explained ? "Built from the menu data (AI off). Items, prices and totals computed by APEats."
        : "Items, prices and totals computed by APEats from the menu data";
  }
  if (result.kind === "explanation") return ai ? `${ai} explanation of the usual recipe; fit checked by APEats` : "Built from our menu notes (AI off); fit checked by APEats";
  if (result.kind === "info") return ai ? `${ai} answer in general terms; no menu item was selected` : "Checked against the menu data";
  if (ai) return `${ai} chose from dishes APEats had already checked`;
  if (result.source === "rules") return "Checked against the menu data";
  return "Rules-based menu matches (AI off)";
}

const asks = createLatest();
let pendingBubble = null;
let lastQuestion = null;

function setAsking(busy) {
  state.asking = busy;
  $("#ask-form .send").disabled = busy;
  $("#ask-input").disabled = busy;
  document.querySelectorAll("#suggestions button, .retry-ask").forEach((b) => (b.disabled = busy));
  $("#chat").setAttribute("aria-busy", String(busy));
}

// Drops a question that is still waiting: its late answer must not land in a newer conversation.
function cancelAsk() {
  asks.cancel();
  if (pendingBubble) pendingBubble.remove();
  pendingBubble = null;
  setAsking(false);
}

// What the conversation is about: a selected lunch ({type:"lunch", payload, view}), one dish ({type:"dish", dishId, name, cuisine}) or nothing.
function startFocus(focus) {
  cancelAsk();
  state.focus = focus;
  if (focus.type === "lunch") {
    // A new selection starts from its own choices: earlier chat messages must not change them.
    state.history = [];
    state.conversationConstraints = null;
  }
  renderAskContext();
  renderAskConstraints();
}

function leaveFocus() {
  if (!state.focus) return;
  const what = state.focus.type === "lunch" ? "that lunch" : "that dish";
  cancelAsk();
  state.focus = null;
  renderAskContext();
  renderAskConstraints();
  addBubble("bot", `Stopped discussing ${what}. ${state.conversationConstraints ? "The choices listed above the chat still apply to new answers; remove any you no longer want." : "Ask about any dish or tell me your budget."}`);
  $("#ask-input").focus();
}

function renderAskContext() {
  const box = $("#ask-context");
  const focus = state.focus;
  box.hidden = !focus;
  if (!focus) {
    box.innerHTML = "";
    return;
  }
  const head = (title) => `<div class="ctx-head"><h2 id="ask-context-title">${title}</h2><button type="button" class="btn text" id="leave-focus">Stop discussing</button></div>`;
  if (focus.type === "dish") {
    box.innerHTML = `${head("Discussing this dish")}
      <p class="ctx-dish"><b>${escapeHtml(focus.name)}</b> · ${escapeHtml(focus.cuisine)} counter</p>`;
    return;
  }
  const v = focus.view;
  const meta = [v.spice === "not-spicy" ? "not spicy" : "any spice",
    v.usePrefs === false ? "saved preferences not used" : prefsText(v.prefs) || "no diet or allergy saved"];
  box.innerHTML = `${head("Discussing this lunch")}
    <ul class="ctx-items">${v.items.map((i) => `
      <li><span class="role-chip ${i.role}">${i.role === "drink" ? "Drink" : "Main dish"}</span>
        <span class="ctx-name">${escapeHtml(i.name)}<small>${escapeHtml(i.stallName)} counter</small></span>
        <span class="ctx-price">${formatSen(i.priceSen)}</span></li>`).join("")}</ul>
    ${v.mainOnly ? `<p class="ctx-note">${v.withDrink ?? v.drinkRequested ? "Main dish only: no drink fits this lunch." : "Main dish only, as chosen."}</p>` : ""}
    <p class="ctx-total"><b>Total ${formatSen(v.totalSen)}</b><span>${v.remainingSen >= 0 ? `${formatSen(v.remainingSen)} left of ${formatSen(v.budgetSen)}` : `${formatSen(-v.remainingSen)} over ${formatSen(v.budgetSen)}`}</span></p>
    <p class="ctx-meta">${escapeHtml(meta.join(" · "))}</p>
    ${(v.issues ?? []).map((x) => `<p class="ctx-note warn">${icon("alert")}<span>${escapeHtml(`${x.name ? `${x.name}: ` : ""}${x.reason}`)}</span></p>`).join("")}
    ${v.menuChanged ? `<p class="ctx-note warn">${icon("alert")}<span>The menu was updated after this lunch was suggested. Prices here are the current ones.</span></p>` : ""}`;
}

// The restrictions APEats is applying to chat answers, so a misunderstanding is visible and can be removed.
function renderAskConstraints() {
  const c = state.conversationConstraints;
  const row = $("#ask-constraints");
  const saved = state.focus?.type === "lunch" ? state.focus.payload.prefs : state.prefs;
  const rank = { any: 0, vegetarian: 1, vegan: 2 };
  const dietName = { vegetarian: "Vegetarian", vegan: "Vegan (confirmed only)" };
  const chips = [];
  const removable = (label, key) => chips.push(`<li class="ac-chip">${escapeHtml(label)}<button type="button" data-remove-constraint="${escapeHtml(key)}" aria-label="Remove: ${escapeHtml(label)}">×</button></li>`);
  const fixed = (label) => chips.push(`<li class="ac-chip saved">${escapeHtml(label)} <small>saved</small></li>`);
  if (c?.budget != null) removable(`Budget ${money(c.budget)}`, "budget");
  if (c?.spice === "not-spicy") removable("Not spicy", "spice");
  if (c?.spice === "spicy") removable("Spicy", "spice");
  if (saved.diet !== "any") fixed(dietName[saved.diet]);
  if (c && rank[c.chatDiet ?? "any"] > rank[saved.diet]) removable(dietName[c.chatDiet], "diet");
  for (const a of saved.avoidAllergens) fixed(`Avoid ${a}`);
  for (const a of (c?.chatAllergens ?? []).filter((x) => !saved.avoidAllergens.includes(x))) removable(`Avoid ${a}`, `allergen:${a}`);
  if (c?.unknownAllergy) removable("Allergy mentioned: ingredient not named yet", "unknown");
  row.hidden = !chips.length;
  row.innerHTML = chips.length
    ? `<span class="ac-label" id="ac-label">Applied to answers</span><ul aria-labelledby="ac-label">${chips.join("")}</ul>
       ${saved.diet !== "any" || saved.avoidAllergens.length ? `<a href="#me" data-goto="prefs" class="ac-link">Change saved</a>` : ""}`
    : "";
}

function removeConstraint(key) {
  const c = state.conversationConstraints;
  if (!c || state.asking) return;
  if (key === "budget") c.budget = null;
  else if (key === "spice") c.spice = "any";
  else if (key === "diet") c.chatDiet = "any";
  else if (key === "unknown") c.unknownAllergy = false;
  else if (key.startsWith("allergen:")) c.chatAllergens = (c.chatAllergens ?? []).filter((a) => a !== key.slice(9));
  // Effective values are recomputed by the server from the saved preferences and what is left here.
  delete c.diet;
  delete c.avoidAllergens;
  renderAskConstraints();
}

async function ask(message) {
  message = message.trim();
  if (!message || state.asking) return;
  const ticket = asks.begin();
  lastQuestion = { message };
  setAsking(true);
  addBubble("user", escapeHtml(message));
  $("#suggestions").hidden = true;
  const pending = addBubble("bot", `<span class="typing">Checking the menu…</span>`);
  pendingBubble = pending;
  const focus = state.focus;
  const body = { message, prefs: state.prefs, history: state.history, conversationConstraints: state.conversationConstraints };
  if (focus?.type === "lunch") body.lunch = focus.payload;
  if (focus?.type === "dish") Object.assign(body, { dishId: focus.dishId, dishSticky: focus.asked === true });
  try {
    const result = await postJson("/api/ask", body, ticket.signal);
    if (!ticket.isCurrent()) return;
    state.conversationConstraints = result.conversationConstraints;
    if (focus?.type === "dish") focus.asked = true;
    if (focus?.type === "lunch" && state.focus === focus) {
      if (result.lunch) focus.view = result.lunch; // names, prices and totals as the server rebuilt them
      else if (result.lunchError) state.focus = null;
    }
    renderAskContext();
    renderAskConstraints();
    // The selected lunch is already shown in the card above the chat.
    const picks = result.kind === "lunch" ? [] : result.dishIds.map((id) => state.byId.get(id)).filter(Boolean);
    // Bubbles keep line breaks (pre-wrap), so the parts are joined without template whitespace.
    pending.innerHTML = [
      escapeHtml(result.reply),
      picks.length ? `<div class="picks">${picks.map((d) => dishCard(d, { showCuisine: true })).join("")}</div>` : "",
      `<span class="source" data-kind="${escapeHtml(result.kind ?? "")}" data-source="${escapeHtml(result.source ?? "")}">${escapeHtml(chatSource(result))}</span>`,
    ].join("");
    state.history.push({ role: "user", text: message }, { role: "model", text: result.reply });
    state.history = state.history.slice(-8);
  } catch (error) {
    if (!ticket.isCurrent()) return;
    pending.innerHTML = `${escapeHtml(error.message)} <button type="button" class="btn text retry-ask">Try again</button>`;
    pending.classList.add("error");
  } finally {
    if (ticket.isCurrent()) {
      pendingBubble = null;
      setAsking(false);
    }
  }
}

function newConversation() {
  cancelAsk();
  state.history = [];
  state.conversationConstraints = null;
  state.focus = null;
  lastQuestion = null;
  $("#chat").replaceChildren();
  $("#suggestions").hidden = false;
  renderAskContext();
  renderAskConstraints();
  addBubble("bot", "New conversation. Nothing from the earlier chat or the selected lunch is kept. Your saved food preferences still apply.");
}

// ---------- Preferences ----------

function renderPrefsForm() {
  const labels = { any: "No restriction", vegetarian: "Vegetarian", vegan: "Vegan (confirmed only)" };
  $("#diet-options").innerHTML = DIETS.map(
    (d) => `<label><input type="radio" name="diet" value="${d}"${state.prefs.diet === d ? " checked" : ""}>${labels[d] ?? d}</label>`,
  ).join("");
  $("#allergen-options").innerHTML = ALLERGENS.map(
    (a) => `<label><input type="checkbox" value="${escapeHtml(a)}"${state.prefs.avoidAllergens.includes(a) ? " checked" : ""}>${escapeHtml(a)}</label>`,
  ).join("");
}

function readPrefsForm() {
  state.prefs = {
    diet: document.querySelector('input[name="diet"]:checked')?.value ?? "any",
    avoidAllergens: [...document.querySelectorAll("#allergen-options input:checked")].map((i) => i.value),
  };
  storageSet(PREFS_KEY, JSON.stringify(state.prefs));
}

// ---------- Shell ----------

function renderAbout() {
  const m = state.meta;
  const withPhoto = state.dishes.filter((d) => d.photo).length;
  const mains = state.dishes.filter((d) => d.role === "main").length;
  const ai = state.provider === "enterprise" ? "Gemini Enterprise agent selected (live connection still to be verified)"
    : state.provider === "gemini" && state.gemini ? "Gemini API (Google AI developer API)" : "AI off: menu matching only";
  $("#about-body").innerHTML = `
    <p>APEats helps new and international students choose a campus lunch: budget in, up to three checked lunch ideas out, with plain-English explanations of unfamiliar dishes.</p>
    <p class="muted">Independent student prototype for the APU Cloud Innovation Hackathon 2026 (Smart Campus &amp; Student Experience). It is a proposed feature for APSpace, not an official APU or APSpace service, and has no connection to APSpace.</p>
    <dl class="about-facts">
      ${factRow("Menu", `${state.stalls.length} counters · ${state.dishes.length} items (${mains} main dishes)`, escapeHtml(`Typed from photos of the menu boards${m.sourceCompiledOn ? `, compiled ${dateText(m.sourceCompiledOn)}` : ""}. Last data update ${dateText(m.generatedAt)}. Prices can change.`))}
      ${factRow("Halal", "All listed outlets serve halal food", "Checked in person by the APEats team.")}
      ${factRow("Estimates", "Descriptions, spice, allergens, ~prices", escapeHtml(m.disclaimer ?? ""))}
      ${factRow("Photos", `${withPhoto} of ${state.dishes.length} items`, "Illustrative photos of each kind of dish from Wikimedia Commons under free licences, credited on every dish. Not photos of the stall's food. Items without a photo still appear.")}
      ${factRow("AI", escapeHtml(ai), "AI only explains and chooses among options that code has already checked. Budget, diet, allergens, spice and days are checked by code.")}
      ${factRow("Poll", "Anonymous, one vote per browser", "An informal poll, not a verified rating.")}
    </dl>`;
}

function showTab(name) {
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.dataset.view !== name));
  document.querySelectorAll(".segments button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
    if(b.dataset.tab === name) b.setAttribute('aria-current','page');
    else b.removeAttribute('aria-current');
  });
  window.scrollTo({ top: 0 });
  if (name === "ask") $("#ask-input").focus();
  if (name === "prefs") refreshPoll();
  if (name === "lunch") refreshLunchStale(); // saved preferences may have changed in Me
}

function wireEvents() {
  $(".segments").onclick = (e) => {
    const tab = e.target.closest("button")?.dataset.tab;
    if (tab) showTab(tab);
  };
  $("#about-btn").onclick = () => {
    renderAbout();
    $("#about-dialog").showModal();
  };

  document.addEventListener("click", (e) => {
    const go = e.target.closest("[data-goto]");
    if (go) {
      e.preventDefault();
      return showTab(go.dataset.goto);
    }
    const card = e.target.closest("[data-dish]");
    if (card) return openDish(card.dataset.dish);
    const details = e.target.closest("[data-details]");
    if (details) return openDish(lunch.state.options[Number(details.dataset.details)]?.items[0].dishId);
    const swap = e.target.closest("[data-swap]");
    if (swap) return swapOption(Number(swap.dataset.swap));
    const askOption = e.target.closest("[data-ask-option]");
    if (askOption) return askAboutOption(Number(askOption.dataset.askOption));
    const tryBudget = e.target.closest("[data-try-budget]");
    if (tryBudget) {
      const rm = Number(tryBudget.dataset.tryBudget) / 100;
      document.querySelector('input[name="budget"][value="other"]').checked = true;
      $("#budget-other").hidden = false;
      $("#budget-input").value = rm.toFixed(2);
      return findLunch();
    }
    if (e.target.closest("#lunch-retry")) return findLunch(lunch.state.body ?? readLunchForm());
    if (e.target.closest("#lunch-update")) return findLunch();
    if (e.target.closest(".retry-ask") && lastQuestion) return ask(lastQuestion.message);
    if (e.target.closest("#leave-focus")) return leaveFocus();
    const removal = e.target.closest("[data-remove-constraint]");
    if (removal) return removeConstraint(removal.dataset.removeConstraint);
    const head = e.target.closest(".cuisine-head");
    if (head) {
      const id = head.closest(".cuisine").dataset.cuisine;
      const set = autoOpen() ? state.collapsed : state.expanded;
      if (set.has(id)) set.delete(id);
      else set.add(id);
      renderMenu();
      return;
    }
    const fav = e.target.closest("[data-fav]");
    if (fav) return sendVote("/api/poll/favorite", { stallId: fav.dataset.fav });
    const star = e.target.closest("[data-rate]");
    if (star) return sendVote("/api/poll/rate", { stallId: star.dataset.rate, stars: Number(star.dataset.stars) });
  });

  // Lunch form
  $("#budget-choices").onchange = (e) => {
    const other = e.target.value === "other";
    $("#budget-other").hidden = !other;
    $("#budget-error").hidden = true;
    if (other) $("#budget-input").focus();
  };
  $("#lunch-form").onsubmit = (e) => {
    e.preventDefault();
    findLunch();
  };
  // Any change of budget, spice, composition, preferences switch or day may make the shown results outdated.
  $("#lunch-form").addEventListener("input", refreshLunchStale);
  $("#lunch-form").addEventListener("change", refreshLunchStale);

  $("#filters-toggle").onclick = () => {
    const open = $("#filters-body").hidden;
    $("#filters-body").hidden = !open;
    $("#filters-toggle").setAttribute("aria-expanded", String(open));
  };
  $("#search").oninput = (e) => setFilter("search", e.target.value);
  // Chips and segmented buttons: one handler per group, value in data-value.
  for (const [id, key] of [["#f-stall", "stall"], ["#f-category", "category"], ["#f-spicy", "spicy"], ["#f-sort", "sort"]]) {
    $(id).onclick = (e) => {
      const button = e.target.closest("[data-value]");
      if (!button) return;
      setFilter(key, button.dataset.value);
      for (const b of $(id).querySelectorAll("[data-value]")) {
        const on = b === button;
        b.classList.toggle("active", on);
        b.setAttribute("aria-checked", String(on));
      }
    };
  }
  $("#f-price-min").oninput = () => onPriceInput("min");
  $("#f-price-max").oninput = () => onPriceInput("max");
  $("#f-mains").onchange = (e) => setFilter("mainsOnly", e.target.checked);
  $("#f-veg").onchange = (e) => setFilter("vegetarian", e.target.checked);
  $("#f-today").onchange = (e) => setFilter("today", e.target.checked);
  $("#f-prefs").onchange = (e) => setFilter("usePrefs", e.target.checked);
  $("#f-reset").onclick = () => {
    state.filters = { ...DEFAULT_FILTERS };
    syncFilterInputs();
    renderMenu();
  };

  $("#ask-about").onclick = () => {
    const dish = state.openDish;
    $("#dish-dialog").close();
    if (!dish) return;
    startFocus({ type: "dish", dishId: dish.id, name: dish.name, cuisine: dish.cuisine });
    showTab("ask");
    ask(`What is ${dish.name} from the ${dish.cuisine} counter? Is it a good choice for me?`);
  };

  $("#suggestions").innerHTML = SUGGESTIONS.map((s) => `<button data-q="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join("");
  $("#suggestions").onclick = (e) => {
    const chip = e.target.closest("button");
    if (chip) ask(chip.dataset.q);
  };
  $("#new-chat").onclick = newConversation;
  $("#ask-form").onsubmit = (e) => {
    e.preventDefault();
    const input = $("#ask-input");
    if(state.asking)return;
    ask(input.value);
    input.value = "";
  };

  $("#prefs-form").onsubmit = (e) => {
    e.preventDefault();
    readPrefsForm();
    renderMenu();
    refreshLunchStale();
    renderAskConstraints();
    // Lunch results made with the old preferences are marked outdated; say so here as well.
    const stale = lunch.isStale(currentChoices());
    $("#prefs-saved").innerHTML = stale
      ? `Saved. Your lunch results are now out of date. <button type="button" class="btn text" data-goto="lunch">Go to Lunch</button>`
      : "Saved";
    if (!stale) setTimeout(() => ($("#prefs-saved").textContent = ""), 2000);
  };
}

async function init() {
  wireEvents();
  try {
    const [menu, status] = await Promise.all([api("/api/menu"), api("/api/status")]);
    state.stalls = menu.stalls;
    state.dishes = menu.dishes;
    state.byId = new Map(menu.dishes.map((d) => [d.id, d]));
    state.meta = menu.meta ?? {};
    state.gemini = status.gemini;
    state.provider = status.provider;
    state.clock = status.clock;
  } catch (error) {
    const message = `<div class="card state-card error" role="alert"><h3>${icon("alert")}The menu could not be loaded</h3><p>${escapeHtml(error.message)}</p><button type="button" class="btn primary" onclick="location.reload()">Try again</button></div>`;
    $("#lunch-out").innerHTML = message;
    $("#cuisine-list").innerHTML = message;
    $("#lunch-submit").disabled = true;
    return;
  }
  const m = state.meta;
  $("#lunch-fine-print").textContent = `Independent student prototype for the APU Cloud Innovation Hackathon 2026. Not an official APU or APSpace service. Prices come from photos of the menu boards${m.sourceCompiledOn ? ` (compiled ${dateText(m.sourceCompiledOn)})` : ""} and can change; please check at the counter.`;
  addBubble("bot", "Hi! Ask me about any dish on the campus menu, or tell me your budget and what you like. I explain unfamiliar food in plain words.");
  renderLunchForm();
  pickCovers();
  fillFilterOptions();
  syncFilterInputs();
  renderPrefsForm();
  renderMenu();
  await refreshPoll();
  // Other students' votes arrive live: refresh the poll while the app is open.
  setInterval(() => {
    if (document.visibilityState === "visible") refreshPoll();
  }, 15_000);
}

init();
