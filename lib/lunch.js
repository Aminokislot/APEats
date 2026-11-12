// "Find my lunch": deterministic lunch sets (main dish + optional drink) under a hard budget.
// Everything that decides whether a set is allowed is plain code here: money in whole sen, the upper end
// of every price, roles, availability, diet, allergens and spice. The AI layer (lib/lunch-ai.js) may only
// choose among the sets this module builds, and its choice is checked again.
import {
  BASE_LABELS, avoidsAllergens, budgetPriceSen, fitsDiet, formatSen, isNotSpicy, spiceLabel, toSen,
} from "../public/shared/filters.js";
import { normalizePrefs } from "./constraints.js";

export const WEEKDAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const MIN_BUDGET_SEN = 100;
export const MAX_BUDGET_SEN = 10000;
export const MAX_OPTIONS = 3;

export class RequestError extends Error {}

// Turns the browser request into checked constraints. Throws RequestError with a user-facing message.
export function normalizeLunchRequest(body, clock) {
  const budgetSen = toSen(body?.budget);
  if (!Number.isInteger(budgetSen) || budgetSen < MIN_BUDGET_SEN || budgetSen > MAX_BUDGET_SEN) {
    throw new RequestError(`Enter a budget between ${formatSen(MIN_BUDGET_SEN)} and ${formatSen(MAX_BUDGET_SEN)}.`);
  }
  const day = body?.day === "today" || body?.day == null ? clock.weekday : Number(body.day);
  if (!Number.isInteger(day) || day < 1 || day > 7) throw new RequestError("Choose a day of the week.");
  const exclude = Array.isArray(body?.exclude) ? body.exclude.filter((x) => typeof x === "string").slice(0, 60) : [];
  return {
    budgetSen,
    spice: body?.spice === "not-spicy" ? "not-spicy" : "any",
    withDrink: body?.withDrink === true,
    // "Use my saved preferences" off: the saved diet and allergens are not applied, and the answer says so.
    usePrefs: body?.usePrefs !== false,
    prefs: body?.usePrefs === false ? normalizePrefs(null) : normalizePrefs(body?.prefs),
    weekday: day,
    // Time-limited items ("after 15:00") are only checked against the clock for today; another day stays unknown.
    time: day === clock.weekday ? `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}` : null,
    exclude: new Set(exclude),
    limit: Number.isInteger(body?.limit) && body.limit >= 1 && body.limit <= MAX_OPTIONS ? body.limit : MAX_OPTIONS,
  };
}

// null = the item may be used; otherwise the reason it may not. Applied to every item of a set.
export function whyNot(dish, req) {
  if (dish.available === false) return "marked as not available";
  if (dish.available == null) return "availability not confirmed";
  if (dish.days?.length && !dish.days.includes(WEEKDAY_NAMES[req.weekday])) return `sold only on ${dish.days.join(", ")}`;
  if (dish.availableAfter && !(req.time && req.time >= dish.availableAfter)) return `printed menu says after ${dish.availableAfter}`;
  if (budgetPriceSen(dish) == null) return dish.priceEstimated ? "price is only an estimate" : "no price on the board";
  if (!fitsDiet(dish, req.prefs.diet)) return req.prefs.diet === "vegan" ? "not confirmed vegan" : "not confirmed vegetarian";
  if (!avoidsAllergens(dish, req.prefs.avoidAllergens)) {
    return dish.allergens == null ? "allergens unknown" : `may contain ${dish.allergens.filter((a) => req.prefs.avoidAllergens.includes(a)).join(", ")}`;
  }
  if (req.spice === "not-spicy" && !isNotSpicy(dish)) return dish.spicy == null ? "spice level unknown" : "spicy";
  return null;
}

const usable = (dish, role, req) => dish.role === role && whyNot(dish, req) === null;

function chooseDrink(main, drinks, remainingSen) {
  const fitting = drinks.filter((d) => budgetPriceSen(d) <= remainingSen);
  fitting.sort((a, b) => (a.stallId === main.stallId ? 0 : 1) - (b.stallId === main.stallId ? 0 : 1)
    || budgetPriceSen(a) - budgetPriceSen(b) || a.name.localeCompare(b.name));
  return fitting[0] ?? null;
}

// Every allowed set, one per main dish, best first. Used by the rules answer and as the AI's choice list.
export function buildCandidates(dishes, req) {
  const mains = dishes.filter((d) => usable(d, "main", req) && !req.exclude.has(d.id) && budgetPriceSen(d) <= req.budgetSen);
  const drinks = req.withDrink ? dishes.filter((d) => usable(d, "drink", req)) : [];
  const cheapestDrink = drinks.length ? Math.min(...drinks.map(budgetPriceSen)) : null;
  const combos = mains.map((main) => {
    const mainSen = budgetPriceSen(main);
    const drink = req.withDrink ? chooseDrink(main, drinks, req.budgetSen - mainSen) : null;
    let drinkNote = null;
    if (req.withDrink && !drink) {
      drinkNote = cheapestDrink == null
        ? "No drink on the menu matches your preferences, so this is the main dish only."
        : `No drink added: the cheapest suitable drink costs ${formatSen(cheapestDrink)}, but only ${formatSen(req.budgetSen - mainSen)} is left after the dish.`;
    }
    return { main, drink, drinkNote, totalSen: mainSen + (drink ? budgetPriceSen(drink) : 0) };
  });
  // Order: has the requested drink → one counter → closest to the budget → name (stable).
  const hasDrink = (c) => (c.drink ? 1 : 0);
  const oneCounter = (c) => (!c.drink || c.drink.stallId === c.main.stallId ? 1 : 0);
  combos.sort((a, b) => (req.withDrink ? hasDrink(b) - hasDrink(a) : 0)
    || oneCounter(b) - oneCounter(a)
    || b.totalSen - a.totalSen
    || a.main.name.localeCompare(b.main.name));
  return { combos, drinks, mains };
}

// Variety: first one set per stall (and never two dishes with the same name), then fill up.
export function pickDiverse(combos, limit) {
  const out = [];
  const stalls = new Set();
  const names = new Set();
  const key = (c) => c.main.name.toLowerCase();
  for (const c of combos) {
    if (out.length >= limit) break;
    if (stalls.has(c.main.stallId) || names.has(key(c))) continue;
    out.push(c);
    stalls.add(c.main.stallId);
    names.add(key(c));
  }
  for (const c of combos) {
    if (out.length >= limit) break;
    if (out.includes(c) || names.has(key(c))) continue;
    out.push(c);
    names.add(key(c));
  }
  return out;
}

function priceNotes(dish) {
  const notes = [];
  if (dish.priceCondition) notes.push(dish.priceCondition);
  if (Number.isFinite(dish.priceMax) && dish.priceMax !== dish.price) notes.push(`${dish.priceText} on the board; the higher price is counted.`);
  return notes;
}

export function itemOut(dish, role, stallName) {
  return {
    dishId: dish.id,
    role,
    name: dish.name,
    // Plain-words note for a newcomer ("Ais Kosong" = iced water). An estimate from our menu notes, labelled in the page.
    about: dish.blurb ?? dish.description ?? null,
    stallId: dish.stallId,
    stallName,
    priceSen: budgetPriceSen(dish),
    priceText: dish.priceText,
    notes: priceNotes(dish),
  };
}

// Short explanation built only from menu data and labelled estimates.
export function factsWhy(combo, req) {
  const { main, drink } = combo;
  const base = BASE_LABELS[main.base];
  const parts = [];
  // The description itself is shown next to the item ("about"), so it is not repeated here.
  if (!main.blurb && !main.description) parts.push(`${base ? `${base} dish` : "Main dish"} from the ${main.cuisine} counter.`);
  const spice = spiceLabel(main);
  parts.push(`${spice}${Number.isFinite(main.spicy) ? " (our estimate)" : ""}.`);
  if (main.includes?.length) parts.push(`The board says it comes with ${main.includes.join(", ")}.`);
  if (drink) parts.push(drink.stallId === main.stallId ? `${drink.name} is sold at the same counter.` : `${drink.name} is from another counter (${drink.cuisine}).`);
  return parts.join(" ");
}

// selectedBy: who chose this set from the checked list - "rules" (plain code) or the AI provider's name.
export function optionOut(combo, req, stallsById, why = null, selectedBy = "rules") {
  const items = [itemOut(combo.main, "main", stallsById[combo.main.stallId]?.name ?? combo.main.cuisine)];
  if (combo.drink) items.push(itemOut(combo.drink, "drink", stallsById[combo.drink.stallId]?.name ?? combo.drink.cuisine));
  const stallIds = [...new Set(items.map((i) => i.stallId))];
  const totalSen = items.reduce((sum, i) => sum + i.priceSen, 0);
  return {
    id: `${combo.main.id}+${combo.drink?.id ?? "none"}`,
    items,
    totalSen,
    budgetSen: req.budgetSen,
    remainingSen: req.budgetSen - totalSen,
    stallIds,
    singleStall: stallIds.length === 1,
    // A drink was asked for but none fits: this is a main dish only, never presented as a complete set.
    mainOnly: !combo.drink,
    drinkRequested: req.withDrink === true,
    drinkNote: combo.drinkNote,
    selectedBy,
    why: why ?? factsWhy(combo, req),
    whySource: why ? "ai" : "menu",
  };
}

// Explains an empty result without relaxing anything.
export function emptyHints(dishes, req) {
  const hints = [];
  const all = { ...req, exclude: new Set() };
  const inBudget = (d, r) => usable(d, "main", r) && budgetPriceSen(d) <= r.budgetSen;
  if (req.exclude.size && dishes.some((d) => inBudget(d, all))) {
    hints.push("You have already seen every main dish that matches these choices.");
    return hints;
  }
  const mainsAnyPrice = dishes.filter((d) => usable(d, "main", all));
  if (mainsAnyPrice.length) {
    const cheapest = Math.min(...mainsAnyPrice.map(budgetPriceSen));
    if (cheapest > req.budgetSen) hints.push(`The cheapest main dish that matches your other choices costs ${formatSen(cheapest)}.`);
  }
  if (req.spice === "not-spicy") {
    const withAnySpice = dishes.filter((d) => inBudget(d, { ...all, spice: "any" })).length;
    if (withAnySpice) hints.push(`${withAnySpice} main dish${withAnySpice > 1 ? "es" : ""} would fit with "Any spice" (their spice is higher or unknown).`);
  }
  if (req.prefs.diet === "vegan") hints.push("No item in the menu data is confirmed vegan yet. Vegetarian does not mean vegan, so please ask at the counter.");
  if (req.prefs.diet !== "any" || req.prefs.avoidAllergens.length) hints.push("Your saved diet and allergy choices are never relaxed automatically.");
  return hints;
}

// The complete rules-only answer.
export function planLunch({ dishes, stalls }, req) {
  const stallsById = Object.fromEntries(stalls.map((s) => [s.id, s]));
  const { combos } = buildCandidates(dishes, req);
  const picked = pickDiverse(combos, req.limit);
  let empty = null;
  if (!picked.length) {
    const prices = dishes.filter((d) => usable(d, "main", { ...req, exclude: new Set() })).map(budgetPriceSen);
    const cheapest = prices.length ? Math.min(...prices) : null;
    empty = {
      message: "No lunch matches all of your choices.",
      hints: emptyHints(dishes, req),
      // Lets the page offer "Try RMx" - the student decides; nothing is relaxed automatically.
      cheapestSen: cheapest != null && cheapest > req.budgetSen ? cheapest : null,
    };
  }
  return { options: picked.map((c) => optionOut(c, req, stallsById)), candidates: combos, empty };
}

// Quick budget buttons from the real menu: quartiles of the main-dish prices, rounded up to whole RM.
export function budgetPresets(dishes) {
  const prices = dishes.filter((d) => d.role === "main" && d.available === true).map(budgetPriceSen).filter((p) => p != null).sort((a, b) => a - b);
  if (!prices.length) return { presets: [], typicalFromSen: null, typicalToSen: null };
  const q = (p) => prices[Math.min(prices.length - 1, Math.floor(p * (prices.length - 1)))];
  const presets = [...new Set([0.25, 0.5, 0.75, 0.9].map((p) => Math.ceil(q(p) / 100)))];
  return { presets, typicalFromSen: q(0.25), typicalToSen: q(0.75), mainCount: prices.length };
}
