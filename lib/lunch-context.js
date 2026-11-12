// The lunch a student selected in "Find my lunch" and is now asking about in Ask.
//
// The browser sends only IDs and the choices that produced the set (day, budget, spice, drink mode,
// preferences, menu version). Everything shown or said about the set is rebuilt here from the server's
// menu: names, counters, prices, total and money left. Prices sent by a browser are never read.
// Composition and arithmetic are code; the AI is only asked to explain what a dish is.
import { formatSen, toSen } from "../public/shared/filters.js";
import { normalizePrefs } from "./constraints.js";
import { buildCandidates, itemOut, whyNot, MIN_BUDGET_SEN, MAX_BUDGET_SEN, WEEKDAY_NAMES } from "./lunch.js";

const RU = "а-яё";

// raw: body.lunch from the browser. Returns null (no lunch selected), {ok:false, error} or {ok:true, lunch}.
export function normalizeSelectedLunch(raw, { dishes, stalls }, clock, menuVersion) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const byId = new Map(dishes.map((d) => [d.id, d]));
  const main = typeof raw.mainId === "string" ? byId.get(raw.mainId.slice(0, 80)) : null;
  if (!main || main.role !== "main") return { ok: false, error: "main_not_found" };
  const wantsDrinkId = typeof raw.drinkId === "string" && raw.drinkId !== "";
  const drink = wantsDrinkId ? byId.get(raw.drinkId.slice(0, 80)) : null;
  if (wantsDrinkId && (!drink || drink.role !== "drink")) return { ok: false, error: "drink_not_found" };
  // The selected menu day is part of the selection. It is never replaced with today.
  const weekday = Number(raw.weekday);
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) return { ok: false, error: "bad_day" };
  const budgetSen = toSen(raw.budget);
  if (!Number.isInteger(budgetSen) || budgetSen < MIN_BUDGET_SEN || budgetSen > MAX_BUDGET_SEN) return { ok: false, error: "bad_budget" };

  const usePrefs = raw.usePrefs !== false;
  const req = {
    budgetSen,
    spice: raw.spice === "not-spicy" ? "not-spicy" : "any",
    withDrink: raw.withDrink === true,
    usePrefs,
    prefs: usePrefs ? normalizePrefs(raw.prefs) : normalizePrefs(null),
    weekday,
    time: weekday === clock.weekday ? `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}` : null,
    exclude: new Set(),
    limit: 1,
  };
  const stallName = (d) => stalls.find((s) => s.id === d.stallId)?.name ?? d.cuisine;
  const items = [itemOut(main, "main", stallName(main))];
  if (drink) items.push(itemOut(drink, "drink", stallName(drink)));
  if (items.some((i) => i.priceSen == null)) return { ok: false, error: "price_unknown" };
  const totalSen = items.reduce((sum, i) => sum + i.priceSen, 0);
  const stallIds = [...new Set(items.map((i) => i.stallId))];

  // Re-check today's data: the menu may have changed since the set was suggested.
  const issues = [];
  for (const dish of [main, drink].filter(Boolean)) {
    const reason = whyNot(dish, req);
    if (reason) issues.push({ dishId: dish.id, name: dish.name, reason });
  }
  if (totalSen > budgetSen) issues.push({ dishId: null, name: null, reason: `total ${formatSen(totalSen)} is over the budget of ${formatSen(budgetSen)}` });

  let drinkNote = null;
  if (!drink && req.withDrink) {
    drinkNote = buildCandidates(dishes, req).combos.find((c) => c.main.id === main.id)?.drinkNote
      ?? "A drink was requested, but no suitable drink fits this set.";
  }
  return {
    ok: true,
    req,
    lunch: {
      mainId: main.id,
      drinkId: drink?.id ?? null,
      items,
      totalSen,
      budgetSen,
      remainingSen: budgetSen - totalSen,
      weekday,
      dayName: WEEKDAY_NAMES[weekday],
      isToday: weekday === clock.weekday,
      withDrink: req.withDrink,
      mainOnly: !drink,
      drinkNote,
      spice: req.spice,
      usePrefs,
      prefs: req.prefs,
      stallIds,
      singleStall: stallIds.length === 1,
      issues,
      menuVersion,
      menuChanged: typeof raw.menuVersion === "string" && raw.menuVersion !== menuVersion,
    },
  };
}

// The conversation starts from the choices that produced the selected lunch.
export const lunchConstraints = (lunch) => ({
  budget: lunch.budgetSen / 100,
  spice: lunch.spice,
  diet: lunch.prefs.diet,
  avoidAllergens: lunch.prefs.avoidAllergens,
});

// ---------- What is the student asking about the set? ----------

const WANTS = {
  total: new RegExp(`how much|\\btotal\\b|altogether|in total|whole set|\\bcost|\\bprice|сколько (?:стоит|всего|вместе|это)|итого|(?<![${RU}])всего(?![${RU}])|вместе|цена|стоимость`, "i"),
  left: new RegExp(`\\bleft\\b|remain|change back|остан[${RU}]*|сдач[${RU}]*`, "i"),
  drink: new RegExp(`\\bdrinks?\\b|beverage|напит[${RU}]*|(?<![${RU}])пить(?![${RU}])`, "i"),
  items: new RegExp(`what(?:'s|’s| is| was) (?:in|included)|which (?:items|dishes|food)|what (?:do|did) i (?:pick|choose|select|get|have|order)|what(?:'s|’s| is) (?:in )?my (?:set|lunch|order)|что входит|что (?:я )?выбрал|(?<![${RU}])состав набора`, "i"),
  counter: new RegExp(`\\bwhere\\b|which counter|\\bcounters?\\b|\\bstalls?\\b|(?<![${RU}])где(?![${RU}])|стойк[${RU}]*|прилав[${RU}]*|куда идти`, "i"),
  day: new RegExp(`which day|what day|какой день|на какой день|в какой день`, "i"),
};
const DEICTIC = new RegExp(`\\b(?:this|it|its|that|these|they|them|both|the (?:whole |entire |full )?(?:set|lunch|meal|dish|drink|main|food|order|option)|my (?:set|lunch|meal|dish|drink|order|selection|choice)|selected|included)\\b|(?<![${RU}])(?:это|этот|эта|эти|этом|этого|оно|его|её|они|набор[${RU}]*|мой (?:обед|выбор|заказ)|выбранн[${RU}]*)(?![${RU}])`, "i");
const NEW_SEARCH = new RegExp(`\\b(?:another|other|else|different|instead|something|anything|recommend|suggest|ideas?|options?|cheaper|alternatives?)\\b|друго[${RU}]*|ещё|еще|что[-\\s]нибудь|посоветуй|вариант[${RU}]*|дешевле`, "i");
const EXPLAIN = new RegExp(`what(?:'s|’s| is| are)\\b|explain|tell me|describe|spic|taste|ingredient|contain|made of|vegan|vegetarian|halal|allerg|\\bgood\\b|что такое|что это|расскажи|объясни|остр[${RU}]*|вкус[${RU}]*|из чего|аллерг[${RU}]*|веган[${RU}]*|вегетариан[${RU}]*|халял[${RU}]*`, "i");

const nameTokens = (name) => String(name).toLowerCase().split(/[^a-z0-9а-яё]+/i).filter((t) => t.length >= 4 && !["with", "main", "dish", "rice", "from"].includes(t));
// Does the message point at the selection ("this", "it", "my lunch") or name one of its items?
export const refersToSelection = (message, items) => DEICTIC.test(message) || items.some((i) => mentions(message, i));
const mentions = (message, item) => nameTokens(item.name).some((t) => message.toLowerCase().includes(t));

// namesOtherDish: the message names a menu item that is not part of the set ("How much is nasi lemak?").
export function lunchIntent(message, lunch, { namesOtherDish = false } = {}) {
  const wants = Object.fromEntries(Object.entries(WANTS).map(([k, re]) => [k, re.test(message)]));
  const main = lunch.items[0];
  const drink = lunch.items[1] ?? null;
  const namesMain = mentions(message, main);
  const namesDrink = drink ? mentions(message, drink) : false;
  const pointsAtSet = DEICTIC.test(message) || namesMain || namesDrink;
  const factual = wants.total || wants.left || wants.items || wants.counter || wants.day;
  const asksDrinkOfSet = wants.drink && /which|what|included|is there|does|do i|какой|какая|есть|входит/i.test(message);
  let about = pointsAtSet || factual || asksDrinkOfSet;
  // "Something cheaper?" or "How much is nasi lemak?" starts a new search instead.
  if (!pointsAtSet && (namesOtherDish || NEW_SEARCH.test(message))) about = false;
  const target = (wants.drink || namesDrink) && !namesMain && drink ? "drink" : "main";
  const explain = about && (EXPLAIN.test(message) || !(factual || asksDrinkOfSet)) && !(wants.drink && !drink && !namesMain);
  return { about, wants, target, explain };
}

// ---------- Code-made facts about the set ----------

export function lunchFacts(lunch, intent, ru = false) {
  const lines = [];
  const itemText = (i) => `${i.name} (${i.stallName}) ${formatSen(i.priceSen)}`;
  const drink = lunch.items[1] ?? null;
  if (ru) {
    lines.push(`Выбранный обед: ${lunch.items.map(itemText).join(" + ")}.`);
    if (drink && intent.wants.drink) lines.push(`Напиток в наборе: ${drink.name}, ${formatSen(drink.priceSen)}.${drink.about ? ` По нашим заметкам: ${drink.about}` : ""}`);
    if (!drink) lines.push(lunch.withDrink ? "В этом наборе нет напитка: подходящий напиток не уложился в бюджет или условия. Это только основное блюдо." : "Напитка в наборе нет: был выбран вариант «только основное блюдо».");
    lines.push(`Итого ${formatSen(lunch.totalSen)} при бюджете ${formatSen(lunch.budgetSen)}; ${lunch.remainingSen >= 0 ? `остаётся ${formatSen(lunch.remainingSen)}` : `превышение на ${formatSen(-lunch.remainingSen)}`}.`);
    if (lunch.items.length > 1) lines.push(lunch.singleStall ? `Оба пункта продаются на одной стойке: ${lunch.items[0].stallName}.` : `Две стойки: ${lunch.items.map((i) => i.stallName).join(" и ")}.`);
    for (const issue of lunch.issues) lines.push(`Проверьте: ${issue.name ? `${issue.name} — ` : ""}${issue.reason}.`);
    if (lunch.menuChanged) lines.push("Данные меню обновились после подбора этого обеда; цены выше — текущие.");
    lines.push("Состав и суммы посчитаны кодом APEats по данным меню.");
    return lines.join(" ");
  }
  lines.push(`Your selected lunch: ${lunch.items.map(itemText).join(" + ")}.`);
  if (drink && intent.wants.drink) lines.push(`The drink in this set is ${drink.name}, ${formatSen(drink.priceSen)}.${drink.about ? ` From our menu notes: ${drink.about}` : ""}`);
  if (!drink) lines.push(lunch.withDrink ? `This set has no drink. ${lunch.drinkNote ?? ""} It is a main dish only.`.replace(/\s+/g, " ") : "This set has no drink: you chose main dish only.");
  lines.push(`Total ${formatSen(lunch.totalSen)} of your ${formatSen(lunch.budgetSen)} budget; ${lunch.remainingSen >= 0 ? `${formatSen(lunch.remainingSen)} left` : `${formatSen(-lunch.remainingSen)} over`}.`);
  if (lunch.items.length > 1) lines.push(lunch.singleStall ? `Both items are sold at one counter: ${lunch.items[0].stallName}.` : `Two counters: ${lunch.items.map((i) => i.stallName).join(" and ")}.`);
  for (const issue of lunch.issues) lines.push(`Please check: ${issue.name ? `${issue.name} — ` : ""}${issue.reason}.`);
  if (lunch.menuChanged) lines.push("The menu data was updated after this lunch was suggested; the prices above are the current ones.");
  lines.push("Items and sums are computed by APEats code from the menu data.");
  return lines.join(" ");
}

export const LUNCH_ERRORS = {
  main_not_found: "The selected main dish is no longer in the menu data.",
  drink_not_found: "The selected drink is no longer in the menu data.",
  bad_day: "The menu day of the selected lunch is missing.",
  bad_budget: "The budget of the selected lunch is missing.",
  price_unknown: "An item of the selected lunch no longer has a confirmed price.",
};

