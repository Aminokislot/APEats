// Loading and validating the generated menu (data/dishes.json + data/stalls.json).
// The import checks its output with validateMenu() before writing; the server checks again at start,
// so a broken file is refused instead of being served.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ALLERGENS } from "../public/shared/filters.js";
import { ROLES } from "./roles.js";

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const ID = /^[a-z0-9-]+--[a-z0-9_-]+$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const money = (v) => typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1000;

export function validateMenu({ stalls, dishes }) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(stalls) || !stalls.length) errors.push("stalls: expected a non-empty array");
  if (!Array.isArray(dishes) || !dishes.length) errors.push("dishes: expected a non-empty array");
  if (errors.length) return { errors, warnings };

  const stallIds = new Set();
  for (const s of stalls) {
    if (!s?.id || !/^[a-z0-9-]+$/.test(s.id)) errors.push(`stall ${JSON.stringify(s?.id)}: bad id`);
    else if (stallIds.has(s.id)) errors.push(`stall ${s.id}: duplicate id`);
    stallIds.add(s?.id);
    if (!s?.name) errors.push(`stall ${s?.id}: missing name`);
  }

  const ids = new Set();
  for (const d of dishes) {
    const at = `dish ${d?.id ?? "(no id)"}`;
    if (!d || typeof d.id !== "string" || !ID.test(d.id)) { errors.push(`${at}: bad id`); continue; }
    if (ids.has(d.id)) errors.push(`${at}: duplicate id`);
    ids.add(d.id);
    if (!stallIds.has(d.stallId)) errors.push(`${at}: unknown stall ${d.stallId}`);
    if (typeof d.name !== "string" || !d.name.trim()) errors.push(`${at}: missing name`);
    if (!ROLES.includes(d.role)) errors.push(`${at}: role must be one of ${ROLES.join(", ")}`);
    if (d.price !== null && !money(d.price)) errors.push(`${at}: price must be a positive RM amount or null`);
    if (d.priceMax != null && (!money(d.priceMax) || d.priceMax < d.price)) errors.push(`${at}: priceMax must be >= price`);
    if (d.price != null && typeof d.priceText !== "string") errors.push(`${at}: missing priceText`);
    if (typeof d.priceEstimated !== "boolean") errors.push(`${at}: priceEstimated must be true/false`);
    if (![true, false, null].includes(d.available)) errors.push(`${at}: available must be true, false or null`);
    if (d.days != null && (!Array.isArray(d.days) || !d.days.length || d.days.some((x) => !WEEKDAYS.includes(x)))) {
      errors.push(`${at}: days must be weekday names`);
    }
    if (d.availableAfter != null && !TIME.test(d.availableAfter)) errors.push(`${at}: availableAfter must be HH:MM`);
    if (d.allergens != null && (!Array.isArray(d.allergens) || d.allergens.some((a) => !ALLERGENS.includes(a)))) {
      errors.push(`${at}: unknown allergen`);
    }
    if (d.spicy != null && !(Number.isInteger(d.spicy) && d.spicy >= 0 && d.spicy <= 5)) errors.push(`${at}: spicy must be 0-5 or null`);
    if (![true, false, null].includes(d.vegetarian)) errors.push(`${at}: vegetarian must be true, false or null`);
    if (d.vegan !== true && d.vegan !== false && d.vegan !== undefined) errors.push(`${at}: vegan must be true or false`);
    if (d.vegan === true && d.vegetarian !== true) errors.push(`${at}: vegan item must also be vegetarian`);
    if (d.price == null) warnings.push(`${at}: no price`);
  }
  return { errors, warnings };
}

const readJson = (path, fallback) => (fallback !== undefined && !existsSync(path) ? fallback : JSON.parse(readFileSync(path, "utf8")));

// Reads the generated menu, attaches illustrative photos and checks everything. Throws on invalid data.
export function loadMenu({ dataDir, publicDir }) {
  const stallsFile = readJson(join(dataDir, "stalls.json"));
  const dishesFile = readJson(join(dataDir, "dishes.json"));
  const campus = readJson(join(dataDir, "campus.json"), {});
  const photos = readJson(join(dataDir, "photos.json"), {});
  const stalls = stallsFile.stalls;
  const allDishes = dishesFile.dishes;
  const { errors } = validateMenu({ stalls, dishes: allDishes });
  if (errors.length) {
    const error = new Error(`Menu data is invalid (${errors.length} problems): ${errors.slice(0, 5).join("; ")}. Run "npm run menu:rollback" to restore the previous version.`);
    error.problems = errors;
    throw error;
  }
  for (const dish of allDishes) {
    const p = photos[dish.photoKey];
    dish.photo = p?.file && existsSync(join(publicDir, "photos", p.file))
      ? { src: `/photos/${p.file}`, author: p.author, license: p.license, licenseUrl: p.licenseUrl, source: p.source }
      : null;
  }
  // campus.json "hideItemsWithoutPhoto": optional; by default items without a photo stay visible with a placeholder.
  const dishes = campus.hideItemsWithoutPhoto ? allDishes.filter((d) => d.photo) : allDishes;
  const { generatedAt, sourceCompiledOn, disclaimer, sources, halalNote } = dishesFile;
  return {
    stalls,
    dishes,
    allDishes,
    campus,
    meta: {
      generatedAt,
      sourceCompiledOn: sourceCompiledOn ?? null,
      disclaimer,
      sources,
      halalNote,
      counts: { items: dishes.length, withPhoto: dishes.filter((d) => d.photo).length, sourceItems: allDishes.length },
    },
  };
}
