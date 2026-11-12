// "Find my lunch": budget, roles, constraints and AI verification.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLunchRequest, planLunch, buildCandidates, whyNot } from "../lib/lunch.js";
import { findLunch, validateLunchAnswer, lunchContext } from "../lib/lunch-ai.js";
import { constraintsFor } from "../lib/constraints.js";
import { offlineRecommend, recommend } from "../lib/recommend.js";
import { parseEnterpriseResponse, askEnterpriseJson, isLunchAnswer } from "../lib/enterprise.js";
import { budgetPriceSen } from "../public/shared/filters.js";

const base = {
  stallId: "a", cuisine: "A", role: "main", category: "Rice", subcategory: "rice", base: "rice",
  price: 8, priceMax: 8, priceText: "RM8.00", priceEstimated: false, spicy: 0, vegetarian: true, vegan: false,
  allergens: [], available: true, days: null, availableAfter: null, blurb: "A test dish.",
};
const dish = (id, over = {}) => ({ ...base, id: `${over.stallId ?? "a"}--${id}`, name: id, ...over });
const drink = (id, price, over = {}) => dish(id, { role: "drink", category: "Drinks", base: null, price, priceMax: price, priceText: `RM${price.toFixed(2)}`, ...over });
const stalls = [{ id: "a", name: "Counter A" }, { id: "b", name: "Counter B" }];
const MONDAY_NOON = { weekday: 1, hour: 12, minute: 0 };
const request = (over = {}, clock = MONDAY_NOON) =>
  normalizeLunchRequest({ budget: 10, spice: "any", withDrink: true, prefs: { diet: "any", avoidAllergens: [] }, ...over }, clock);
const plan = (dishes, over, clock) => planLunch({ dishes, stalls }, request(over, clock));
const ids = (option) => option.items.map((i) => i.dishId);
const allItems = (result) => result.options.flatMap((o) => o.items);

function checkBudget(result, budgetSen) {
  for (const o of result.options) {
    const sum = o.items.reduce((s, i) => s + i.priceSen, 0);
    assert.equal(o.totalSen, sum, "total is the sum of the items");
    assert(o.totalSen <= budgetSen, `total ${o.totalSen} within ${budgetSen}`);
    assert.equal(o.remainingSen, budgetSen - o.totalSen);
    assert.equal(new Set(ids(o)).size, ids(o).length, "no item twice");
  }
}

test("1. a main dish and a drink that together fit the budget are offered with exact sen", () => {
  const r = plan([dish("katsu", { price: 7.9, priceMax: 7.9, priceText: "RM7.90" }), drink("tea", 2.1)]);
  assert.equal(r.options.length, 1);
  assert.deepEqual(ids(r.options[0]), ["a--katsu", "a--tea"]);
  assert.equal(r.options[0].totalSen, 1000); // 7.90 + 2.10 is exactly RM10.00, no floating point error
  assert.equal(r.options[0].remainingSen, 0);
  assert.equal(r.options[0].singleStall, true);
  checkBudget(r, 1000);
});

test("2. a dish and a drink that fit alone but not together are never offered as a set", () => {
  const r = plan([dish("rice", { price: 8, priceMax: 8 }), drink("juice", 2.5)]);
  assert.equal(r.options.length, 1);
  assert.deepEqual(ids(r.options[0]), ["a--rice"], "drink dropped instead of exceeding the budget");
  assert.match(r.options[0].drinkNote, /cheapest suitable drink costs RM2\.50.*RM2\.00 is left/);
  checkBudget(r, 1000);
});

test("3. ranges and two board prices use the highest price; estimated or missing prices never pass a budget", () => {
  const range = dish("range", { price: 8.5, priceMax: 11, priceText: "RM8.50–11.00" });
  const two = dish("two", { price: 4, priceMax: 6, priceText: "RM4.00 / RM6.00" });
  const estimate = dish("estimate", { price: 5, priceMax: 5, priceText: "~RM5.00", priceEstimated: true });
  const missing = dish("missing", { price: null, priceMax: null, priceText: "Price not listed" });
  const legacy = dish("legacy", { priceMax: undefined, price: 8, priceText: "RM8–12" }); // old data without priceMax
  const r = plan([range, two, estimate, missing, legacy], { withDrink: false });
  assert.deepEqual(r.options.map((o) => o.items[0].dishId), ["a--two"]);
  assert.equal(r.options[0].totalSen, 600);
  assert.match(r.options[0].items[0].notes.join(" "), /higher price is counted/);
  assert.equal(budgetPriceSen(legacy), 1200);
  const r11 = plan([range], { withDrink: false, budget: 11 });
  assert.equal(r11.options[0].totalSen, 1100);
  assert.equal(whyNot(estimate, request()), "price is only an estimate");
});

test("4. sides, add-ons, desserts and unclear items are never offered as the main dish", () => {
  const items = [dish("side", { role: "side", price: 3 }), dish("rice-addon", { role: "addon", price: 2 }),
    dish("cake", { role: "dessert", price: 4 }), dish("counter-chicken", { role: "unknown", price: 6 }), drink("water", 1)];
  const r = plan(items);
  assert.equal(r.options.length, 0);
  assert.match(r.empty.message, /No lunch/);
  const withMain = plan([...items, dish("meal", { price: 7 })]);
  assert.deepEqual(withMain.options.map((o) => o.items[0].dishId), ["a--meal"]);
  assert(allItems(withMain).every((i) => !["a--side", "a--rice-addon", "a--cake", "a--counter-chicken"].includes(i.dishId)));
});

test("5. an allergen in the drink excludes that drink from every set", () => {
  const milkTea = drink("milk-tea", 2, { allergens: ["milk"] });
  const unknownDrink = drink("syrup", 1, { allergens: null });
  const r = plan([dish("rice"), milkTea, unknownDrink], { prefs: { diet: "any", avoidAllergens: ["milk"] } });
  assert.equal(r.options.length, 1);
  assert.deepEqual(ids(r.options[0]), ["a--rice"], "milk tea and the unknown-allergen drink are both excluded");
  assert.match(r.options[0].drinkNote, /No drink on the menu matches your preferences/);
  const okDrink = plan([dish("rice"), milkTea, drink("water", 1)], { prefs: { diet: "any", avoidAllergens: ["milk"] } });
  assert.deepEqual(ids(okDrink.options[0]), ["a--rice", "a--water"]);
  // Unknown allergens in the main dish exclude it as well.
  assert.equal(plan([dish("mystery", { allergens: null })], { prefs: { diet: "any", avoidAllergens: ["egg"] } }).options.length, 0);
});

test("6. vegan needs an explicit vegan flag; vegetarian is not enough, for the drink too", () => {
  const vegetarianOnly = dish("veg-rice", { vegetarian: true, vegan: false });
  const veganMain = dish("vegan-rice", { vegetarian: true, vegan: true });
  const vegetarianDrink = drink("tea", 2, { vegetarian: true, vegan: false });
  const veganDrink = drink("water", 1, { vegetarian: true, vegan: true });
  const vegan = { prefs: { diet: "vegan", avoidAllergens: [] } };
  assert.equal(plan([vegetarianOnly, vegetarianDrink], vegan).options.length, 0);
  const r = plan([vegetarianOnly, veganMain, vegetarianDrink, veganDrink], vegan);
  assert.deepEqual(ids(r.options[0]), ["a--vegan-rice", "a--water"]);
  assert.match(plan([vegetarianOnly], vegan).empty.hints.join(" "), /confirmed vegan/);
});

test("7. not spicy excludes unknown and high spice, for both dish and drink", () => {
  const items = [dish("mild", { spicy: 1 }), dish("hot", { spicy: 3 }), dish("unknown-spice", { spicy: null }),
    drink("plain", 1, { spicy: 0 }), drink("mystery-drink", 0.5, { spicy: null })];
  const r = plan(items, { spice: "not-spicy" });
  assert.deepEqual(r.options.map(ids), [["a--mild", "a--plain"]]);
  const any = plan(items, { spice: "any" });
  assert.equal(any.options.length, 3);
});

test("8. constraints survive swapping an option and continuing the conversation", () => {
  const allowed = ["a--two", "a--four", "a--five", "a--six"];
  const items = [dish("one", { allergens: ["peanuts"] }), dish("two"), dish("three", { spicy: 4 }), dish("four"), dish("five"), dish("six"), drink("water", 1)];
  const req = { prefs: { diet: "any", avoidAllergens: ["peanuts"] }, spice: "not-spicy" };
  const first = plan(items, req);
  const shown = first.options.map((o) => o.items[0].dishId);
  assert.equal(shown.length, 3);
  const swapped = plan(items, { ...req, limit: 1, exclude: shown });
  assert.deepEqual(swapped.options.map((o) => o.items[0].dishId), allowed.filter((id) => !shown.includes(id)));
  assert(!allItems(swapped).some((i) => ["a--one", "a--three"].includes(i.dishId)), "swap keeps allergy and spice rules");
  const none = plan(items, { ...req, limit: 1, exclude: allowed });
  assert.equal(none.options.length, 0);
  assert.match(none.empty.hints.join(" "), /already seen every main dish/);
  // "Ask about it" carries the lunch constraints into the chat.
  const lunchConstraints = { budget: 10, spice: "not-spicy", diet: "vegetarian", avoidAllergens: ["peanuts"] };
  const c = constraintsFor("another idea please", {}, [], lunchConstraints);
  assert.equal(c.budget, 10);
  assert.equal(c.spice, "not-spicy");
  assert.equal(c.diet, "vegetarian");
  assert.deepEqual(c.avoidAllergens, ["peanuts"]);
  const answer = offlineRecommend({ message: "another idea please", prefs: {}, history: [], conversationConstraints: lunchConstraints, dishes: items, stalls, clock: MONDAY_NOON });
  assert(!answer.dishIds.includes("a--one"));
  assert(!answer.dishIds.includes("a--three"));
});

test("9. day restrictions, 'after 15:00' items and unconfirmed availability are respected", () => {
  const tuesday = dish("tuesday-special", { days: ["Tuesday"] });
  const evening = dish("value-set", { availableAfter: "15:00" });
  const poster = dish("poster", { available: null });
  const soldOut = dish("sold-out", { available: false });
  const items = [tuesday, evening, poster, soldOut];
  assert.equal(plan(items, { withDrink: false }).options.length, 0, "Monday noon: nothing");
  assert.deepEqual(plan(items, { withDrink: false, day: 2 }).options.map((o) => o.items[0].dishId), ["a--tuesday-special"]);
  assert.deepEqual(plan(items, { withDrink: false }, { weekday: 1, hour: 16, minute: 0 }).options.map((o) => o.items[0].dishId), ["a--value-set"]);
  assert.equal(whyNot(evening, request({ day: 3 })), "printed menu says after 15:00", "another day: time unknown, left out");
  assert.equal(whyNot(poster, request()), "availability not confirmed");
});

// ---------- AI answers are verified ----------

function mockGemini(answer) {
  const old = globalThis.fetch;
  globalThis.fetch = async () => (answer instanceof Error ? Promise.reject(answer)
    : { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }) });
  return () => { globalThis.fetch = old; };
}
async function withGemini(answer, fn) {
  const env = { ...process.env };
  Object.assign(process.env, { AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", GEMINI_FALLBACK_MODELS: "" });
  const restore = mockGemini(answer);
  try { return await fn(); } finally { restore(); process.env = env; }
}
const menu = { dishes: [dish("katsu", { price: 7.9, priceMax: 7.9, priceText: "RM7.90" }), dish("noodles", { stallId: "b", cuisine: "B", price: 9, priceMax: 9 }), drink("tea", 2.1), drink("water", 1, { stallId: "b" })], stalls };

test("10. unknown IDs, changed pairs or a wrong total make the server reject the AI answer", async () => {
  const req = request();
  for (const [answer, reason] of [
    [{ intro: "Hi", options: [{ mainId: "a--invented", drinkId: "", totalRm: 5, why: "Tasty" }] }, "unknown_id"],
    [{ intro: "Hi", options: [{ mainId: "a--katsu", drinkId: "b--water", totalRm: 8.9, why: "Tasty" }] }, "unknown_id"],
    [{ intro: "Hi", options: [{ mainId: "a--katsu", drinkId: "a--tea", totalRm: 9.5, why: "Tasty" }] }, "total_mismatch"],
    [{ intro: "Hi", options: [{ mainId: "a--katsu", drinkId: "", totalRm: 7.9, why: "Tasty" }] }, "drink_missing"],
  ]) {
    const r = await withGemini(answer, () => findLunch({ menu, req }));
    assert.equal(r.source, "rules");
    assert.equal(r.warning, "ai_rejected");
    assert.equal(r.aiProblem, reason);
    assert(r.options.length > 0, "the checked rules answer is shown instead");
    assert(r.options.every((o) => o.whySource === "menu"));
    checkBudget(r, 1000);
  }
});

test("10b. a valid AI choice is used, with prices from code and unsafe prose replaced", async () => {
  const req = request();
  const answer = { intro: "Two easy picks.", options: [
    { mainId: "b--noodles", drinkId: "b--water", totalRm: 10, why: "Soft noodles in a light broth." },
    { mainId: "a--katsu", drinkId: "a--tea", totalRm: 10.0, why: "Guaranteed allergen-free and only RM7!" },
  ] };
  const r = await withGemini(answer, () => findLunch({ menu, req }));
  assert.equal(r.source, "gemini");
  assert.deepEqual(r.options.map(ids), [["b--noodles", "b--water"], ["a--katsu", "a--tea"]]);
  assert.equal(r.options[0].why, "Soft noodles in a light broth.");
  assert.equal(r.options[0].whySource, "ai");
  assert.equal(r.options[1].whySource, "menu", "unsafe AI text is not shown");
  assert(!r.options[1].why.includes("Guaranteed"));
  checkBudget(r, 1000);
});

test("11. when the AI fails or is switched off, an honestly labelled rules answer is returned", async () => {
  const r = await withGemini(new Error("network down"), () => findLunch({ menu, req: request() }));
  assert.equal(r.source, "rules");
  assert.equal(r.warning, "ai_unavailable");
  assert(r.options.length > 0);
  const env = { ...process.env };
  try {
    process.env.AI_PROVIDER = "offline";
    const off = await findLunch({ menu, req: request() });
    assert.equal(off.source, "offline");
    assert.equal(off.warning, undefined);
  } finally { process.env = env; }
  const swap = await findLunch({ menu, req: request({ limit: 1 }), mode: "swap" });
  assert.equal(swap.source, "rules", "swaps never call the AI");
});

test("request validation rejects impossible budgets", () => {
  for (const budget of [0, -5, "abc", 1000, null]) assert.throws(() => request({ budget }), /between RM1\.00 and RM100\.00/);
  assert.equal(request({ budget: "9,90" }).budgetSen, 990);
});

test("AI context lists only checked sets, never excluded items", () => {
  const items = [dish("ok"), dish("nuts", { allergens: ["peanuts"] }), drink("water", 1)];
  const req = request({ prefs: { diet: "any", avoidAllergens: ["peanuts"] } });
  const { combos } = buildCandidates(items, req);
  const context = lunchContext(combos, req);
  assert.match(context, /a--ok/);
  assert.doesNotMatch(context, /a--nuts/);
  assert.equal(validateLunchAnswer({ options: [] }, combos).ok, false);
});

test("Enterprise adapter contract: lunch answers parsed from mocked StreamAssist responses", async () => {
  const body = [{ answer: { replies: [{ groundedContent: { content: { thought: true, text: "thinking" } } },
    { groundedContent: { content: { text: "```json\n{\"intro\":\"Hi\",\"options\":[{\"mainId\":\"a--katsu\",\"drinkId\":\"a--tea\",\"totalRm\":10,\"why\":\"Crispy.\"}]}\n```" } } }] } }];
  const parsed = parseEnterpriseResponse(body, isLunchAnswer);
  assert.equal(parsed.options[0].mainId, "a--katsu");
  assert.throws(() => parseEnterpriseResponse([{ answer: { replies: [{ groundedContent: { content: { text: "{\"reply\":\"x\",\"dishIds\":[]}" } } }] } }], isLunchAnswer));
  const env = { ...process.env };
  try {
    Object.assign(process.env, { GOOGLE_CLOUD_PROJECT: "apeats-test", ENTERPRISE_APP_ID: "apeats", ENTERPRISE_AGENT_ID: "123", ENTERPRISE_LOCATION: "global" });
    const answer = await askEnterpriseJson({ query: "q", isValid: isLunchAnswer, tokenProvider: async () => "t", fetcher: async (url, init) => {
      assert.equal(JSON.parse(init.body).agentsSpec.agentSpecs[0].agentId, "123");
      return { ok: true, json: async () => body };
    } });
    const { combos } = buildCandidates(menu.dishes, request());
    assert.equal(validateLunchAnswer(answer, combos).ok, true);
  } finally { process.env = env; }
});

test("dish questions answer about that exact dish and check the fit in code", async () => {
  const items = [dish("Nasi Lemak", { spicy: 3, allergens: ["peanuts"], blurb: "Coconut rice with sambal." }), dish("Nasi Goreng", { blurb: "Fried rice." })];
  const args = { message: "What is it?", dishId: "a--Nasi Lemak", prefs: { diet: "any", avoidAllergens: ["peanuts"] }, history: [], dishes: items, stalls, clock: MONDAY_NOON };
  const env = { ...process.env };
  try {
    process.env.AI_PROVIDER = "offline";
    const r = await recommend(args);
    assert.deepEqual(r.dishIds, ["a--Nasi Lemak"]);
    assert.match(r.reply, /Coconut rice with sambal/);
    assert.match(r.reply, /Does not fit: ✗ may contain peanuts/);
    assert.equal(r.fit, "no");
  } finally { process.env = env; }
  // A model that talks about another dish, or promises safety, is not trusted.
  const other = await withGemini({ reply: "Nasi Goreng is great", dishIds: ["a--Nasi Goreng"] }, () => recommend(args));
  assert.equal(other.source, "offline");
  assert.deepEqual(other.dishIds, ["a--Nasi Lemak"]);
  const unsafe = await withGemini({ reply: "It is completely safe and peanut-free.", dishIds: ["a--Nasi Lemak"] }, () => recommend(args));
  assert.equal(unsafe.warning, "unsafe_text");
  assert(!unsafe.reply.includes("peanut-free"));
});
