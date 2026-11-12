// The lunch journey as plain state, shared by the page (public/app.js) and the tests (tests/journey.test.js).
// It answers three questions the page must never get wrong:
//   1. Which choices produced the results on screen, and do they still match the form and saved preferences?
//   2. Which response is the newest? A late answer from an earlier search or swap is dropped.
//   3. Who selected each option on screen (AI or rules), also after "Show another"?
// No DOM here, so the same code runs in Node.
import { formatSen, toSen } from "./filters.js";

export const WEEKDAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const NO_PREFS = Object.freeze({ diet: "any", avoidAllergens: Object.freeze([]) });

const cleanPrefs = (prefs) => ({
  diet: ["vegetarian", "vegan"].includes(prefs?.diet) ? prefs.diet : "any",
  avoidAllergens: Array.isArray(prefs?.avoidAllergens) ? [...new Set(prefs.avoidAllergens)].sort() : [],
});

// Budget in sen. An empty or unfinished budget field is NaN, never RM0.
const senOf = (c) => (Number.isInteger(c?.budgetSen) ? c.budgetSen : c?.budget == null || c.budget === "" ? NaN : toSen(c.budget));

// Saved preferences count only while "Use my saved preferences" is on.
export const effectivePrefs = (choices) => (choices?.usePrefs === false ? cleanPrefs(null) : cleanPrefs(choices?.prefs));

// Choices as the form holds them: { budget (RM) | budgetSen, spice, withDrink, usePrefs, prefs, weekday (1-7) }.
// Two sets of choices with the same key give the same lunch results.
export function choicesKey(choices) {
  const prefs = effectivePrefs(choices);
  const budgetSen = senOf(choices);
  return JSON.stringify([Number.isFinite(budgetSen) ? budgetSen : null, choices?.spice === "not-spicy" ? "not-spicy" : "any",
    choices?.withDrink === true, prefs.diet, prefs.avoidAllergens, Number(choices?.weekday) || null]);
}

export function prefsText(prefs) {
  const p = cleanPrefs(prefs);
  const parts = [];
  if (p.diet !== "any") parts.push(p.diet === "vegan" ? "vegan (confirmed only)" : "vegetarian");
  if (p.avoidAllergens.length) parts.push(`avoid ${p.avoidAllergens.join(", ")}`);
  return parts.join(" · ");
}

// The choices that produced a result, as the server echoed them (`result.request`).
export function requestParts(request) {
  const prefs = prefsText(request.prefs);
  return [
    `Budget ${formatSen(request.budgetSen)}`,
    request.spice === "not-spicy" ? "Not spicy" : "Any spice",
    request.withDrink ? "Main dish + drink" : "Main dish only",
    request.usePrefs === false ? "Saved preferences not used" : prefs ? `Preferences: ${prefs}` : "No diet or allergy saved",
  ];
}

// What differs between the choices behind the results and the choices now. Empty = results are current.
export function describeChanges(applied, current) {
  if (choicesKey(applied) === choicesKey(current)) return [];
  const changes = [];
  if (senOf(applied) !== senOf(current)) changes.push(Number.isFinite(senOf(current)) ? `budget is now ${formatSen(senOf(current))}` : "budget changed");
  if ((applied.spice === "not-spicy") !== (current.spice === "not-spicy")) changes.push(current.spice === "not-spicy" ? "spice is now Not spicy" : "spice is now Any spice");
  if ((applied.withDrink === true) !== (current.withDrink === true)) changes.push(current.withDrink ? "now Main dish + drink" : "now Main dish only");
  if (Number(applied.weekday) !== Number(current.weekday)) changes.push(`today is now ${WEEKDAYS[Number(current.weekday)] ?? "another day"}`);
  const before = effectivePrefs(applied);
  const now = effectivePrefs(current);
  if (JSON.stringify(before) !== JSON.stringify(now)) {
    changes.push(current.usePrefs === false ? "saved preferences are switched off" : `preferences are now: ${prefsText(now) || "no diet or allergy"}`);
  }
  return changes;
}

// Latest-wins guard: begin() cancels the previous request; a ticket knows whether it is still the newest.
export function createLatest() {
  let id = 0;
  let controller = null;
  return {
    begin() {
      controller?.abort();
      controller = typeof AbortController === "function" ? new AbortController() : null;
      const mine = ++id;
      return { signal: controller?.signal, isCurrent: () => mine === id };
    },
    cancel() {
      controller?.abort();
      controller = null;
      id += 1;
    },
  };
}

const AI_NAMES = { gemini: "Gemini", enterprise: "the Gemini Enterprise agent" };
const isAi = (option) => option.selectedBy in AI_NAMES;
const listNumbers = (numbers) => (numbers.length === 1 ? `Option ${numbers[0]}` : `Options ${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`);

// One honest label for the options on screen. kind: ai | mixed | rules | offline | fallback | rejected.
export function provenance(options, result) {
  const checked = "Prices, totals and food rules are checked by code.";
  if (result?.warning === "ai_unavailable") {
    return { kind: "fallback", text: "The AI helper is unavailable right now. These are rules-based menu matches checked by APEats, with the same budget and food rules." };
  }
  if (result?.warning === "ai_rejected") {
    return { kind: "rejected", text: "The AI answer did not pass our checks, so it was not used. These are rules-based menu matches checked by APEats." };
  }
  const ai = options.map((o, i) => (isAi(o) ? i + 1 : 0)).filter(Boolean);
  const rules = options.map((o, i) => (isAi(o) ? 0 : i + 1)).filter(Boolean);
  if (ai.length && !rules.length) {
    return { kind: "ai", text: `Chosen by ${AI_NAMES[options[0].selectedBy]} from options APEats had already checked. ${checked}` };
  }
  if (ai.length) {
    const name = AI_NAMES[options[ai[0] - 1].selectedBy];
    return { kind: "mixed", text: `${listNumbers(ai)} ${ai.length === 1 ? "was" : "were"} chosen by ${name}; ${listNumbers(rules).toLowerCase()} ${rules.length === 1 ? "is a rules-based menu match" : "are rules-based menu matches"} from Show another. ${checked}` };
  }
  if (result?.source in AI_NAMES) return { kind: "rules", text: `After Show another, every option is a rules-based menu match checked by APEats (not chosen by AI).` };
  if (result?.source === "offline") return { kind: "offline", text: "Rules-based menu matches checked by APEats. AI is switched off on this server." };
  return { kind: "rules", text: "Rules-based menu matches checked by APEats." };
}

export const optionLabel = (option) => (isAi(option) ? `Picked by ${AI_NAMES[option.selectedBy] === "Gemini" ? "Gemini" : "Gemini Enterprise"}` : "Rules-based match");

// What the page sends to /api/ask for a selected lunch: IDs and the choices that produced it. Never prices.
export function selectedLunchPayload(option, request, menuVersion) {
  return {
    mainId: option.items[0].dishId,
    drinkId: option.items.find((i) => i.role === "drink")?.dishId ?? null,
    weekday: request.weekday,
    budget: request.budgetSen / 100,
    spice: request.spice,
    withDrink: request.withDrink,
    usePrefs: request.usePrefs !== false,
    prefs: cleanPrefs(request.prefs),
    menuVersion,
  };
}

// The lunch results on screen. post(path, body, signal) -> Promise<json>.
export function createLunchSession({ post, onChange = () => {} }) {
  const state = { status: "idle", body: null, result: null, options: [], seen: new Set(), error: null, swappingIndex: null, version: 0, swapped: false };
  const finds = createLatest();
  const swaps = createLatest();
  const applied = () => (state.result ? { ...state.result.request } : null);

  // Starts a new search. An earlier search or swap still in flight is cancelled and its answer ignored.
  async function find(body) {
    swaps.cancel();
    const ticket = finds.begin();
    state.version += 1;
    Object.assign(state, { status: "loading", body, error: null, swappingIndex: null });
    onChange();
    try {
      const result = await post("/api/lunch", body, ticket.signal);
      if (!ticket.isCurrent()) return "superseded";
      Object.assign(state, { status: "ready", result, options: [...result.options], seen: new Set(result.options.map((o) => o.items[0].dishId)), swapped: false });
      onChange();
      return "ok";
    } catch (error) {
      if (!ticket.isCurrent()) return "superseded";
      Object.assign(state, { status: "error", error: error.message });
      onChange();
      return "error";
    }
  }

  const isStale = (current) => state.status === "ready" && choicesKey(applied()) !== choicesKey(current);
  const changes = (current) => (state.status === "ready" ? describeChanges(applied(), current) : []);

  // Replaces one option with another checked match for the SAME choices that produced the results.
  // Refused while the choices on the form no longer match those results.
  async function swap(index, current) {
    if (state.status !== "ready" || !state.options[index]) return { ok: false, reason: "not_ready" };
    if (state.swappingIndex != null) return { ok: false, reason: "busy" };
    if (current && isStale(current)) return { ok: false, reason: "stale" };
    const ticket = swaps.begin();
    const version = state.version;
    const fresh = () => ticket.isCurrent() && version === state.version;
    state.swappingIndex = index;
    onChange();
    try {
      const result = await post("/api/lunch", { ...state.body, mode: "swap", limit: 1, exclude: [...state.seen] }, ticket.signal);
      if (!fresh()) return { ok: false, reason: "superseded" };
      const next = result.options[0];
      if (!next) return { ok: false, reason: "none" };
      state.seen.add(next.items[0].dishId);
      state.options[index] = next;
      state.swapped = true;
      return { ok: true };
    } catch (error) {
      return fresh() ? { ok: false, reason: "error", message: error.message } : { ok: false, reason: "superseded" };
    } finally {
      if (fresh()) {
        state.swappingIndex = null;
        onChange();
      }
    }
  }

  return { state, find, swap, isStale, changes, applied };
}
