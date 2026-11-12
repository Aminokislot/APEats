// The cross-screen journey: Lunch -> Me -> Lunch -> Ask. The page logic under test is the same module the
// browser runs (public/shared/journey.js); the server is the real one, started on a test port with AI off.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  choicesKey, createLatest, createLunchSession, describeChanges, provenance, requestParts, selectedLunchPayload,
} from "../public/shared/journey.js";
import { findLunch } from "../lib/lunch-ai.js";
import { normalizeLunchRequest } from "../lib/lunch.js";
import { recommend } from "../lib/recommend.js";
import { formatSen } from "../public/shared/filters.js";

// ---------- helpers ----------

const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const option = (main, by = "rules") => ({ id: main, selectedBy: by, items: [{ dishId: main, role: "main" }], totalSen: 800 });
const answer = (mains, request, extra = {}) => ({ options: mains.map((m) => option(m, extra.by)), request, source: extra.source ?? "rules", menuVersion: "v1", ...extra });
const REQ = { budgetSen: 1000, spice: "any", withDrink: true, usePrefs: true, prefs: { diet: "any", avoidAllergens: [] }, weekday: 4 };
const FORM = { budget: 10, spice: "any", withDrink: true, usePrefs: true, prefs: { diet: "any", avoidAllergens: [] }, weekday: 4 };

async function withServer(port, fn) {
  const dir = mkdtempSync(join(tmpdir(), "apeats-journey-"));
  const child = spawn(process.execPath, ["server.js"], { cwd: new URL("../", import.meta.url),
    env: { ...process.env, PORT: String(port), AI_PROVIDER: "offline", GEMINI_API_KEY: "", VOTE_STORAGE: "local", VOTES_FILE: join(dir, "votes.json"), DEMO_CLOCK: "12:15", DEMO_WEEKDAY: "4" },
    stdio: ["ignore", "pipe", "pipe"] });
  const base = `http://localhost:${port}`;
  const post = async (path, body, signal) => {
    const response = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Server startup timeout")), 10000);
      child.stdout.on("data", (x) => { if (String(x).includes("APEats running")) { clearTimeout(timer); resolve(); } });
      child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}`)); });
    });
    const menu = await (await fetch(`${base}/api/menu`)).json();
    return await fn({ post, menu, byId: new Map(menu.dishes.map((d) => [d.id, d])) });
  } finally {
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- which choices produced the results ----------

test("results know the choices that produced them, including 'Use my saved preferences'", () => {
  assert.equal(choicesKey(FORM), choicesKey(REQ), "form choices and the server echo compare equal");
  assert.deepEqual(describeChanges(REQ, FORM), []);
  assert.deepEqual(describeChanges(REQ, { ...FORM, budget: 12 }), ["budget is now RM12.00"]);
  assert.deepEqual(describeChanges(REQ, { ...FORM, spice: "not-spicy", withDrink: false, weekday: 5 }),
    ["spice is now Not spicy", "now Main dish only", "today is now Friday"]);
  assert.deepEqual(describeChanges(REQ, { ...FORM, prefs: { diet: "vegan", avoidAllergens: [] } }), ["preferences are now: vegan (confirmed only)"]);
  // Saved preferences that are switched off change nothing; switching them off after they applied does.
  assert.deepEqual(describeChanges(REQ, { ...FORM, usePrefs: false, prefs: { diet: "vegan", avoidAllergens: ["egg"] } }), []);
  const vegReq = { ...REQ, prefs: { diet: "vegetarian", avoidAllergens: ["peanuts"] } };
  assert.deepEqual(describeChanges(vegReq, { ...FORM, usePrefs: false, prefs: vegReq.prefs }), ["saved preferences are switched off"]);
  assert.deepEqual(describeChanges(REQ, { ...FORM, budget: null }), ["budget changed"], "an unfinished budget also makes results outdated");
  assert.deepEqual(requestParts({ ...vegReq, spice: "not-spicy" }),
    ["Budget RM10.00", "Not spicy", "Main dish + drink", "Preferences: vegetarian · avoid peanuts"]);
  assert.equal(requestParts({ ...REQ, usePrefs: false }).at(-1), "Saved preferences not used");
});

// ---------- concurrent and out-of-order requests ----------

test("a late answer from an earlier search never overwrites newer results", async () => {
  const calls = [];
  const session = createLunchSession({ post: (path, body, signal) => { const d = deferred(); calls.push({ body, signal, ...d }); return d.promise; } });
  const first = session.find({ budget: 13 });
  const second = session.find({ budget: 9 });
  assert.equal(calls[0].signal.aborted, true, "the earlier request is cancelled");
  calls[1].resolve(answer(["newer"], { ...REQ, budgetSen: 900 }));
  assert.equal(await second, "ok");
  calls[0].resolve(answer(["older"], { ...REQ, budgetSen: 1300 })); // arrives last
  assert.equal(await first, "superseded");
  assert.deepEqual(session.state.options.map((o) => o.id), ["newer"]);
  assert.equal(session.state.result.request.budgetSen, 900);
  // The same for a failure that arrives late: no error card over good results.
  const third = session.find({ budget: 12 });
  const fourth = session.find({ budget: 11 });
  calls[3].resolve(answer(["latest"], { ...REQ, budgetSen: 1100 }));
  await fourth;
  calls[2].reject(new Error("network down"));
  assert.equal(await third, "superseded");
  assert.equal(session.state.status, "ready");
  assert.deepEqual(session.state.options.map((o) => o.id), ["latest"]);
});

test("a late swap never lands in results from a newer search, and two swaps cannot run at once", async () => {
  const calls = [];
  const session = createLunchSession({ post: (path, body, signal) => { const d = deferred(); calls.push({ body, signal, ...d }); return d.promise; } });
  const found = session.find({ budget: 10 });
  calls[0].resolve(answer(["a", "b", "c"], REQ));
  await found;
  const swap = session.swap(0, FORM);
  assert.deepEqual(await session.swap(1, FORM), { ok: false, reason: "busy" });
  assert.deepEqual(calls[1].body.exclude, ["a", "b", "c"]);
  const newer = session.find({ budget: 12 }); // the student searches again while the swap is in flight
  calls[2].resolve(answer(["x", "y", "z"], { ...REQ, budgetSen: 1200 }));
  await newer;
  calls[1].resolve(answer(["late-swap"], REQ)); // the old swap answers last
  assert.deepEqual(await swap, { ok: false, reason: "superseded" });
  assert.deepEqual(session.state.options.map((o) => o.id), ["x", "y", "z"]);
  assert.equal(session.state.swappingIndex, null, "the new results are not left locked");
  assert.equal(session.state.swapped, false);
});

test("latest-wins guard", () => {
  const latest = createLatest();
  const a = latest.begin();
  const b = latest.begin();
  assert.equal(a.isCurrent(), false);
  assert.equal(a.signal.aborted, true);
  assert.equal(b.isCurrent(), true);
  latest.cancel();
  assert.equal(b.isCurrent(), false);
});

// ---------- provenance ----------

test("provenance is tracked per option and stays correct after swaps", async () => {
  const stalls = [{ id: "a", name: "Counter A" }];
  const base = { stallId: "a", cuisine: "A", role: "main", base: "rice", priceEstimated: false, spicy: 0, vegetarian: true, vegan: false, allergens: [], available: true, days: null, availableAfter: null, blurb: "Test." };
  const dish = (id, price) => ({ ...base, id, name: id, price, priceMax: price, priceText: `RM${price.toFixed(2)}` });
  const menu = { dishes: [dish("one", 8), dish("two", 7), dish("three", 6), dish("four", 5)], stalls };
  const req = (over = {}) => normalizeLunchRequest({ budget: 10, withDrink: false, prefs: {}, ...over }, { weekday: 1, hour: 12, minute: 0 });
  const env = { ...process.env };
  const realFetch = globalThis.fetch;
  Object.assign(process.env, { AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", GEMINI_FALLBACK_MODELS: "" });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ intro: "Three picks.", options: [
    { mainId: "one", drinkId: "", totalRm: 8, why: "Nice." }, { mainId: "two", drinkId: "", totalRm: 7, why: "Nice." }, { mainId: "three", drinkId: "", totalRm: 6, why: "Nice." }] }) }] } }] }) });
  try {
    const full = await findLunch({ menu, req: req() });
    assert.equal(full.source, "gemini");
    assert.deepEqual(full.options.map((o) => o.selectedBy), ["gemini", "gemini", "gemini"]);
    assert.equal(provenance(full.options, full).kind, "ai");
    const swap = await findLunch({ menu, req: req({ limit: 1, exclude: ["one", "two", "three"] }), mode: "swap" });
    assert.equal(swap.source, "rules");
    assert.deepEqual(swap.options.map((o) => [o.items[0].dishId, o.selectedBy]), [["four", "rules"]]);
    const mixed = [full.options[0], swap.options[0], full.options[2]];
    const label = provenance(mixed, full);
    assert.equal(label.kind, "mixed");
    assert.match(label.text, /Options 1 and 3 were chosen by Gemini; option 2 is a rules-based menu match/);
    const allSwapped = provenance([swap.options[0], swap.options[0], swap.options[0]], full);
    assert.equal(allSwapped.kind, "rules");
    assert.doesNotMatch(allSwapped.text, /Chosen by Gemini/);
  } finally { globalThis.fetch = realFetch; process.env = env; }
  assert.equal(provenance([option("a")], { source: "rules", warning: "ai_unavailable" }).kind, "fallback");
  assert.equal(provenance([option("a")], { source: "rules", warning: "ai_rejected" }).kind, "rejected");
  assert.equal(provenance([option("a")], { source: "offline" }).kind, "offline");
  assert.match(provenance([option("a", "enterprise")], { source: "enterprise" }).text, /Gemini Enterprise agent/);
});

// ---------- answers say what they are ----------

test("an empty list of dishes is not reported as 'nothing matches'", async () => {
  const stalls = [{ id: "s", name: "Stall" }];
  const base = { stallId: "s", cuisine: "S", role: "main", category: "Rice", available: true, days: null, spicy: 0, price: 8, priceText: "RM8.00", allergens: [], vegetarian: true, blurb: "Coconut rice with sambal." };
  const dishes = [{ ...base, id: "nasi", name: "Nasi Lemak" }, { ...base, id: "soup", name: "Soup", price: 3, priceText: "RM3.00" }];
  const args = (message, extra = {}) => ({ message, prefs: {}, history: [], dishes, stalls, ratings: {}, clock: { weekday: 1, hour: 12, minute: 0 }, ...extra });
  const env = { ...process.env };
  const realFetch = globalThis.fetch;
  const model = (reply, dishIds = []) => { globalThis.fetch = async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ reply, dishIds }) }] } }] }) }); };
  try {
    process.env.AI_PROVIDER = "offline";
    // A dish name under a budget that excludes it: explained, with the fit, not "no items match".
    const named = await recommend(args("What is nasi lemak?", { conversationConstraints: { budget: 5 } }));
    assert.equal(named.kind, "explanation");
    assert.deepEqual(named.dishIds, ["nasi"]);
    assert.match(named.reply, /Does not fit: ✗ budget RM5/);
    assert.equal((await recommend(args("lunch under RM1"))).kind, "no_match");
    assert.equal((await recommend(args("I have an allergy"))).kind, "clarify");
    const lost = await recommend(args("How much is the whole set?"));
    assert.equal(lost.kind, "unknown", "nothing is selected, so the question cannot be answered");
    assert.deepEqual(lost.dishIds, []);
    assert.equal((await recommend(args("something for lunch"))).kind, "selection");

    Object.assign(process.env, { AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", GEMINI_FALLBACK_MODELS: "" });
    model("Malaysian food often balances sweet, sour and spicy tastes.");
    const info = await recommend(args("Tell me about local food culture today"));
    assert.equal(info.kind, "info");
    assert.equal(info.source, "gemini");
    assert.deepEqual(info.dishIds, []);
    // Prices or set contents that exist only in model prose are not shown.
    model("The Soup set is only RM2 with a free drink!", ["soup"]);
    const priced = await recommend(args("something for lunch"));
    assert.equal(priced.kind, "selection");
    assert.doesNotMatch(priced.reply, /RM2\b|free drink/);
    assert.match(priced.reply, /RM3\.00/, "the price comes from the menu data");
  } finally { globalThis.fetch = realFetch; process.env = env; }
});

// ---------- the real journey over HTTP ----------

test("journey: preferences changed after results are shown; swaps and updates follow the current choices", async () => {
  await withServer(18084, async ({ post, byId }) => {
    const session = createLunchSession({ post });
    const prefs = { current: { diet: "any", avoidAllergens: [] } };
    const form = { budget: 12, spice: "any", withDrink: true, usePrefs: true, day: "today" };
    const choices = () => ({ ...form, prefs: prefs.current, weekday: 4 });
    const body = () => ({ budget: form.budget, spice: form.spice, withDrink: form.withDrink, usePrefs: form.usePrefs, prefs: prefs.current, day: form.day });
    const mains = () => session.state.options.map((o) => byId.get(o.items[0].dishId));

    // 1. Find lunch with no dietary restriction.
    assert.equal(await session.find(body()), "ok");
    assert.equal(session.state.options.length, 3);
    assert(mains().some((d) => d.vegetarian !== true), "without a diet, meat dishes are offered");
    assert.equal(session.isStale(choices()), false);
    const shown = session.state.options.map((o) => o.id);

    // 2. Open Me, select Vegan, save. 3. Back on Lunch the old results are marked outdated...
    prefs.current = { diet: "vegan", avoidAllergens: [] };
    assert.equal(session.isStale(choices()), true);
    assert.deepEqual(session.changes(choices()), ["preferences are now: vegan (confirmed only)"]);
    // 4-5. ...and "Show another" cannot add a dish chosen under the old preferences.
    assert.deepEqual(await session.swap(0, choices()), { ok: false, reason: "stale" });
    assert.deepEqual(session.state.options.map((o) => o.id), shown, "nothing was replaced");

    // "Use my saved preferences" off: the saved diet does not apply, so the results are current again.
    form.usePrefs = false;
    assert.equal(session.isStale(choices()), false);
    form.usePrefs = true;

    // Update results: the vegan choice is applied by the server (no confirmed vegan data, so nothing is offered).
    assert.equal(await session.find(body()), "ok");
    assert.equal(session.state.result.request.prefs.diet, "vegan");
    assert.equal(session.state.options.length, 0);
    assert.match(session.state.result.empty.hints.join(" "), /confirmed vegan/);
    assert.equal(session.isStale(choices()), false);

    // Vegetarian + lower budget: every option and every swap respects the new diet and the new budget.
    prefs.current = { diet: "vegetarian", avoidAllergens: ["peanuts"] };
    form.budget = 9;
    assert.equal(session.isStale(choices()), true);
    assert.equal(await session.find(body()), "ok");
    const check = () => {
      for (const o of session.state.options) {
        assert(o.totalSen <= 900, `total ${o.totalSen} within RM9`);
        assert.equal(o.totalSen, o.items.reduce((sum, i) => sum + i.priceSen, 0));
        for (const item of o.items) {
          const d = byId.get(item.dishId);
          assert.equal(d.vegetarian, true, `${d.name} is vegetarian`);
          assert(!d.allergens.includes("peanuts"));
        }
      }
    };
    check();
    const before = session.state.options[1].id;
    assert.deepEqual(await session.swap(1, choices()), { ok: true });
    assert.notEqual(session.state.options[1].id, before);
    assert.equal(session.state.options[1].selectedBy, "rules");
    check();
    // A budget change after the swap makes the mixed results outdated too.
    form.budget = 6;
    assert.deepEqual(await session.swap(0, choices()), { ok: false, reason: "stale" });
    assert.equal(await session.find(body()), "ok");
    assert(session.state.options.every((o) => o.totalSen <= 600));
  });
});

test("journey: Ask keeps the whole selected lunch - main, drink, day, budget - and code answers about the set", async () => {
  await withServer(18085, async ({ post, byId }) => {
    const session = createLunchSession({ post });
    // A future menu day (the test clock is Thursday), not spicy, RM10, main + drink, saved preferences switched off.
    const saved = { diet: "vegan", avoidAllergens: ["egg"] };
    assert.equal(await session.find({ budget: 10, spice: "not-spicy", withDrink: true, usePrefs: false, prefs: saved, day: 5 }), "ok");
    const { result } = session.state;
    const chosen = session.state.options.find((o) => o.items.length === 2);
    assert(chosen, "a main dish with a drink is offered");
    const [main, drink] = chosen.items;
    const lunch = selectedLunchPayload(chosen, result.request, result.menuVersion);
    assert.deepEqual(Object.keys(lunch).sort(), ["budget", "drinkId", "mainId", "menuVersion", "prefs", "spice", "usePrefs", "weekday", "withDrink"], "IDs and choices only: no names, no prices");
    assert.equal(lunch.weekday, 5);
    assert.equal(lunch.usePrefs, false);

    let state = null;
    const ask = async (message, extra = {}) => {
      const r = await post("/api/ask", { message, prefs: saved, history: [], conversationConstraints: state, lunch, ...extra });
      state = r.conversationConstraints;
      return r;
    };
    const total = formatSen(chosen.totalSen);

    const first = await ask(`What is ${main.name}? Is this lunch a good choice for me?`);
    assert.equal(first.kind, "lunch");
    assert.deepEqual(first.dishIds, [main.dishId, drink.dishId], "main dish and drink are both kept");
    assert.equal(first.lunch.weekday, 5, "the selected future day is not replaced with today");
    assert.equal(first.lunch.dayName, "Friday");
    assert.equal(first.lunch.totalSen, byId.get(main.dishId).price * 100 + byId.get(drink.dishId).price * 100);
    assert.match(first.reply, /Your selected lunch: /);
    assert.equal(state.budget, 10);
    assert.equal(state.spice, "not-spicy");
    assert.equal(state.diet, "any", "'Use my saved preferences' was off for this lunch, so the saved diet is not applied in Ask");

    // Follow-up questions keep the set. Composition and arithmetic are code, not AI.
    const follow = await ask("Which drink was included, and how much is the whole set?");
    assert.equal(follow.kind, "lunch");
    assert.equal(follow.source, "rules");
    assert(follow.reply.includes(drink.name) && follow.reply.includes(`Total ${total}`), follow.reply);
    const left = await ask("How much is left?");
    assert.match(left.reply, new RegExp(`${formatSen(1000 - chosen.totalSen).replace(".", "\\.")} left`));
    const what = await ask("What is this?");
    assert.equal(what.kind, "lunch");
    assert(what.reply.includes(main.name));
    const ru = await ask("Сколько стоит весь набор?");
    assert.equal(ru.kind, "lunch");
    assert(ru.reply.includes(`Итого ${total}`), ru.reply);

    // Prices from the browser are never used; unknown IDs are refused instead of guessed.
    const tampered = await ask("How much altogether?", { lunch: { ...lunch, totalSen: 1, items: [{ dishId: main.dishId, priceSen: 1 }], price: 0.01 } });
    assert.equal(tampered.lunch.totalSen, chosen.totalSen);
    assert(tampered.reply.includes(`Total ${total}`));
    const unknown = await ask("How much altogether?", { lunch: { ...lunch, drinkId: "no-such-drink" } });
    assert.equal(unknown.kind, "unknown");
    assert.equal(unknown.lunchError, "drink_not_found");
    assert.equal(unknown.lunch, null);
    const noDay = await ask("How much altogether?", { lunch: { ...lunch, weekday: undefined } });
    assert.equal(noDay.lunchError, "bad_day", "a missing day is an error, never silently today");

    // New constraints win over stale history: the form said RM10, an old message said RM5.
    const stale = await post("/api/ask", { message: "another idea please", prefs: {}, lunch, conversationConstraints: null, history: [{ role: "user", text: "I have RM5 and I want it spicy" }] });
    assert.equal(stale.conversationConstraints.budget, 10);
    assert.equal(stale.conversationConstraints.spice, "not-spicy");
    for (const id of stale.dishIds) assert(byId.get(id).price <= 10 && byId.get(id).spicy <= 1);

    // "New conversation": the page stops sending the lunch and the chat state. Nothing of the set leaks through.
    const fresh = await post("/api/ask", { message: "How much is the whole set?", prefs: {}, history: [], conversationConstraints: null });
    assert.equal(fresh.kind, "unknown");
    assert.equal(fresh.lunch, null);
    assert.equal(fresh.conversationConstraints.budget, null);
    assert.deepEqual(fresh.dishIds, []);
  });
});
