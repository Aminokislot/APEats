// "What should I eat?" chat - Gemini with an offline fallback.
// Gemini never invents food: we send it the real, already filtered menu and it may only pick dish ids
// from that list (checked again below). Questions about one dish carry its id, so the answer is about
// exactly that dish; questions about a selected lunch carry the set (lib/lunch-context.js), and its items,
// prices and totals are written by code. The fit with the student's choices is computed by code too.
//
// Every answer says what it is (`kind`) and who produced it (`source`), so the page never has to guess
// from an empty dishIds list:
//   kind:   selection | explanation | lunch | info | no_match | clarify | unknown
//   source: gemini | enterprise (AI answered) · rules (code only) · offline (AI off or failed; see `warning`)
import { constraintsFor, eligible, isQuestionOnly } from "./constraints.js";
import { askEnterprise } from "./enterprise.js";
import { generateJson, hasGeminiKey } from "./gemini.js";
import { lunchFacts, lunchIntent, refersToSelection, LUNCH_ERRORS } from "./lunch-context.js";
import { safeProse } from "./prose.js";
import { BASE_LABELS, ROLE_LABELS, avoidsAllergens, fitsBudget, fitsDiet, formatSen, isNotSpicy, spiceLabel, toSen } from "../public/shared/filters.js";

export { DEFAULT_MODEL } from "./gemini.js";

const SYSTEM_PROMPT = `You are APEats, a friendly food guide for new and international students at APU (Malaysia).
You help them choose what to eat. You are an independent student prototype, not an official university service.

All food outlets on campus serve halal food. Food is ready at the counter or cooked in a few minutes.

The MENU is a list of lines: id | name | cuisine | price | spicy | veg | allergens | role | days | about
- price: RM; "~" marks a price estimated from similar items (say it is an estimate).
- spicy: 0-1 not spicy, 2-3 a little spicy, 4-5 very spicy (estimated, not official).
- veg: Y vegetarian, N contains meat/fish, ? unknown.
- allergens: likely allergens from usual recipes (estimated). "?" means unknown.
- role: main dish, side, drink, dessert or add-on. Never call a side, add-on or drink a full meal.
- days: only served on these days (empty = any day).
CUISINE RATINGS are averages from an anonymous in-app poll (one vote per browser), not verified reviews.

Rules:
- Recommend ONLY dishes from the MENU. Never invent dishes, prices or cuisines.
- Respect the student's preferences (vegetarian, allergens to avoid) and never relax restrictions to produce a recommendation.
- "not spicy" means spicy 0-1. Describe spiciness only as "not spicy", "a little spicy" or "very spicy".
- For a vegetarian student recommend only veg = Y. Never present veg "?" items as vegetarian.
- Allergens are estimates: for a student with an allergy, avoid items listing it and remind them to
  confirm with the stall. Never promise an item is allergen-free or safe.
- A budget the student mentions is a hard limit. If nothing fits, say so honestly and return no dish IDs.
- Do not state prices, totals or what a set contains: the app shows them from the menu data.
- Do not invent portion sizes, calories, protein or exact sauce ingredients.
- Explain local dishes simply for newcomers (what it is, what it tastes like, a tip for ordering).
- Keep the reply short: 2-5 sentences, no markdown.
- Answer in the language the student writes in.
- dishIds: up to 3 ids from the menu that you recommend, best first. Empty if none fit.`;

const DISH_PROMPT = `You are APEats, a food guide for new and international students at APU (Malaysia).
The student asks about ONE dish, given as DISH. Explain that exact dish in plain words for someone who has never
eaten it: what it is, its base (rice, noodles, bread...), the usual main ingredients of the typical recipe, the
expected taste, and a short ordering tip. Say clearly that ingredients are the usual recipe, not checked with the stall.
Do not mention prices, portion sizes, calories or protein. Never say the dish is allergen-free, safe or guaranteed.
If the question is about something else, answer briefly about this dish only.
Answer in the language of the student's message. 2-5 short sentences, no markdown.
dishIds: [] or exactly the DISH id.`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    reply: { type: "STRING" },
    dishIds: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["reply", "dishIds"],
};

const WEEKDAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const fmt = (v) => (v == null ? "?" : v);
const timeOf = (clock) => (clock && Number.isInteger(clock.hour) ? `${String(clock.hour).padStart(2, "0")}:${String(clock.minute ?? 0).padStart(2, "0")}` : null);
// A selected lunch keeps its own menu day. Today's clock is used only when the day is today.
const dayOf = (args) => (args.lunch
  ? { weekday: args.lunch.weekday, time: args.lunch.isToday ? timeOf(args.clock) : null, selected: true }
  : { weekday: args.clock.weekday, time: timeOf(args.clock), selected: false });
const RATING_QUESTION = /rate|rating|best cuisine|рейтинг|лучш.*кухн/i;

// Older data without roles: fall back to the menu category.
const MEALS = ["Rice", "Noodles", "Soup", "Mains", "Burgers & Wraps", "Sushi & Bento", "Roti & Breakfast"];
const roleOf = (d) => d.role ?? (d.category === "Drinks" ? "drink" : d.category === "Desserts" ? "dessert" : d.category === "Add-ons" ? "addon" : MEALS.includes(d.category) ? "main" : "side");

function menuLines(dishes, cuisineOf) {
  return dishes
    .map((d) =>
      [
        d.id,
        d.name,
        cuisineOf[d.stallId],
        d.price == null ? "?" : d.priceText.replace(/RM/g, ""),
        fmt(d.spicy),
        d.vegetarian === true ? "Y" : d.vegetarian === false ? "N" : "?",
        d.allergens == null ? "?" : d.allergens.map((a) => a.replace("wheat/gluten", "gluten")).join(",") || "-",
        roleOf(d),
        (d.days ?? []).map((x) => x.slice(0, 3)).join("/"),
        (d.blurb ?? d.description ?? "").slice(0, 70),
      ].join(" | "),
    )
    .join("\n");
}

function candidates(args, c) {
  const message = args.message.toLowerCase();
  const drink = /\b(drink|coffee|tea|juice|water|kopi|teh)\b|напит|кофе|чай|сок|вод[ау]/i.test(message);
  const dessert = /dessert|sweet|cake|mochi|десерт|сладк/i.test(message);
  const snack = /\b(snack|side)\b|закуск|перекус/i.test(message);
  const wanted = drink ? "drink" : dessert ? "dessert" : snack ? "side" : "main";
  const day = dayOf(args);
  return args.dishes.filter((d) => eligible(d, c, WEEKDAY_NAMES[day.weekday], day.time) && roleOf(d) === wanted);
}
function buildContext(args, c, menu) {
  const cuisineOf = Object.fromEntries(args.stalls.map((s) => [s.id, s.name]));
  const day = dayOf(args);
  const hard = { diet: c.diet, avoidAllergens: c.avoidAllergens, budget: c.budget, spice: c.spice };
  return `${day.selected ? "MENU DAY CHOSEN BY THE STUDENT" : "TODAY"}: ${WEEKDAY_NAMES[day.weekday]}
HARD CONSTRAINTS: ${JSON.stringify(hard)}
CUISINE RATINGS: ${JSON.stringify(args.ratings ?? {})}
MENU:
${menuLines(menu, cuisineOf)}`;
}

async function askGemini({ message, history, context, system = SYSTEM_PROMPT }) {
  const contents = [
    ...history.slice(-6).map((turn) => ({
      role: turn.role === "user" ? "user" : "model",
      parts: [{ text: String(turn.text).slice(0, 1000) }],
    })),
    { role: "user", parts: [{ text: `${context}\n\nSTUDENT: ${message}` }] },
  ];
  const { data, model } = await generateJson({ system, contents, schema: RESPONSE_SCHEMA });
  return {
    reply: String(data.reply ?? ""),
    dishIds: Array.isArray(data.dishIds) ? data.dishIds.map(String) : [],
    model,
  };
}

// Both the live provider and the fallback use the same deterministic constraints.
function describe(args, c, options) {
  if (c.clarify) return { reply: c.clarify, dishIds: [], kind: "clarify" };
  if (!options.length) return { kind: "no_match", reply:c.diet === 'vegan'
    ? (c.ru ? 'В меню пока нет блюд с подтверждённой отметкой vegan. Уточните состав у продавца; vegetarian не означает vegan.' : 'There are no confirmed vegan items matching your request. Please ask the stall about ingredients; vegetarian does not mean vegan.')
    : (c.ru ? 'Не нашёл вариантов, соответствующих всем ограничениям. Неизвестные и приблизительные цены исключены при заданном бюджете.' : 'No items match all your constraints. Unknown and estimated prices are excluded when a budget is specified.'), dishIds:[] };
  const names=Object.fromEntries(args.stalls.map(s=>[s.id,s.name]));
  const details=options.map(d=>`${d.name} (${names[d.stallId]}) — ${d.priceText}. ${c.ru ? (d.descriptionRu || '') : (d.blurb || d.description || '')}`);
  const allergy=c.avoidAllergens.length ? (c.ru ? ' Сведения об аллергенах приблизительные: подтвердите состав у продавца.' : ' Allergen information is estimated: confirm ingredients with the stall.') : '';
  return { kind: "selection", reply:(c.ru ? 'По данным меню подходят: ' : 'Matching menu options: ')+details.join(' ')+allergy,dishIds:options.map(d=>d.id) };
}

// Things the text asked for that were not applied (a saved preference stayed) are said out loud.
const withNotes = (result, c) => (c.notes?.length ? { ...result, reply: `${result.reply}\n\n${c.notes.join(" ")}` } : result);

// ---------- One specific dish ----------

const RU_SPICE = { "Not spicy": "не острое", "A little spicy": "слегка острое", "Very spicy": "очень острое", "Spice unknown": "острота неизвестна" };
const RU_ROLE = { main: "основное блюдо", side: "гарнир или закуска", drink: "напиток", dessert: "десерт", addon: "добавка", unknown: "неясно, полноценное ли это блюдо" };

// Code-made check of one dish against the conversation's constraints.
export function dishFit(dish, c, weekday, time) {
  const ok = [];
  const no = [];
  const unsure = [];
  const ru = c.ru;
  if (dish.available === false) no.push(ru ? "отмечено как недоступное" : "marked as not available");
  if (dish.available == null) unsure.push(ru ? "доступность не подтверждена" : "availability not confirmed");
  if (dish.days?.length && !dish.days.includes(WEEKDAY_NAMES[weekday])) no.push(ru ? `продаётся только: ${dish.days.join(", ")}` : `sold only on ${dish.days.join(", ")}`);
  if (dish.availableAfter && !(time && time >= dish.availableAfter)) unsure.push(ru ? `по печатному меню — после ${dish.availableAfter}` : `printed menu says after ${dish.availableAfter}`);
  if (c.budget != null) (fitsBudget(dish, c.budget) ? ok : dish.priceEstimated || dish.price == null ? unsure : no)
    .push(ru ? `бюджет RM${c.budget}` : `budget RM${c.budget}`);
  if (c.diet !== "any") (fitsDiet(dish, c.diet) ? ok : dish.vegetarian == null ? unsure : no).push(c.diet);
  if (c.avoidAllergens.length) {
    if (dish.allergens == null) unsure.push(ru ? "аллергены неизвестны" : "allergens unknown");
    else if (avoidsAllergens(dish, c.avoidAllergens)) ok.push(ru ? `исключённые аллергены не указаны в нашей оценке (${c.avoidAllergens.join(", ")})` : `your excluded allergens are not in our estimate (${c.avoidAllergens.join(", ")})`);
    else no.push(ru ? `может содержать: ${dish.allergens.filter((a) => c.avoidAllergens.includes(a)).join(", ")}` : `may contain ${dish.allergens.filter((a) => c.avoidAllergens.includes(a)).join(", ")}`);
  }
  if (c.spice === "not-spicy") (isNotSpicy(dish) ? ok : dish.spicy == null ? unsure : no).push(ru ? "неострое" : "not spicy");
  if (c.spice === "spicy") ((dish.spicy ?? 0) >= 2 ? ok : unsure).push(ru ? "острое" : "spicy");
  const verdict = no.length ? "no" : unsure.length ? "unsure" : "yes";
  return { verdict, ok, no, unsure };
}

// The same check for a whole selected lunch: the total against the budget, every item against the rest.
export function lunchFit(lunch, byId, c, time) {
  const ok = [];
  const no = [];
  const unsure = [];
  if (c.budget != null) {
    const budgetSen = toSen(c.budget);
    (lunch.totalSen <= budgetSen ? ok : no).push(c.ru
      ? `итого ${formatSen(lunch.totalSen)} при бюджете ${formatSen(budgetSen)}`
      : `total ${formatSen(lunch.totalSen)} ${lunch.totalSen <= budgetSen ? "within" : "over"} budget ${formatSen(budgetSen)}`);
  }
  const perItem = lunch.items.map((item) => ({ item, fit: dishFit(byId.get(item.dishId), { ...c, budget: null }, lunch.weekday, time) }));
  for (const { item, fit } of perItem) {
    no.push(...fit.no.map((x) => `${item.name}: ${x}`));
    unsure.push(...fit.unsure.map((x) => `${item.name}: ${x}`));
  }
  // A constraint is ticked only when every item of the set passes it.
  for (const label of new Set(perItem.flatMap((p) => p.fit.ok))) if (perItem.every((p) => p.fit.ok.includes(label))) ok.push(label);
  return { verdict: no.length ? "no" : unsure.length ? "unsure" : "yes", ok, no, unsure };
}

function fitLine(fit, c) {
  if (!fit.ok.length && !fit.no.length && !fit.unsure.length) return "";
  if (c.ru) {
    const head = fit.verdict === "yes" ? "Подходит под ваши условия" : fit.verdict === "no" ? "Не подходит" : "Нужно уточнить";
    return `${head}: ${[...fit.no.map((x) => `✗ ${x}`), ...fit.unsure.map((x) => `? ${x}`), ...fit.ok.map((x) => `✓ ${x}`)].join("; ")}. Проверено кодом APEats по данным меню.`;
  }
  const head = fit.verdict === "yes" ? "Fits your choices" : fit.verdict === "no" ? "Does not fit" : "Needs checking";
  return `${head}: ${[...fit.no.map((x) => `✗ ${x}`), ...fit.unsure.map((x) => `? ${x}`), ...fit.ok.map((x) => `✓ ${x}`)].join("; ")}. Checked by APEats code against the menu data.`;
}

function dishFactsReply(dish, stallName, c) {
  const spice = spiceLabel(dish);
  const allergens = dish.allergens == null ? null : dish.allergens.join(", ");
  if (c.ru) {
    return [
      `${dish.name} (${stallName}) — ${dish.priceText}. ${RU_ROLE[dish.role] ? `Это ${RU_ROLE[dish.role]}.` : ""}`,
      dish.descriptionRu || dish.description || "",
      `Острота: ${RU_SPICE[spice]}${Number.isFinite(dish.spicy) ? " (оценка)" : ""}.`,
      allergens == null ? "Аллергены неизвестны — уточните у продавца." : `Возможные аллергены (оценка по типичному рецепту): ${allergens || "в оценке не указаны"}. Это не гарантия; уточните у продавца.`,
    ].filter(Boolean).join(" ");
  }
  const base = BASE_LABELS[dish.base];
  return [
    `${dish.name} (${stallName}) — ${dish.priceText}. ${ROLE_LABELS[dish.role] ?? ""}${base ? `, ${base.toLowerCase()} based` : ""}.`,
    dish.blurb || dish.description || "",
    `${spice}${Number.isFinite(dish.spicy) ? " (our estimate)" : ""}.`,
    allergens == null ? "Allergens are unknown: please ask the stall." : `Likely allergens in a typical recipe: ${allergens || "none in our estimate"}. This is not a guarantee; please ask the stall.`,
  ].filter(Boolean).join(" ");
}

// Plain-words explanation of one dish: AI prose when it is available and passes the wording check, else menu facts.
async function dishProse(args, c, dish, provider) {
  const stallName = args.stalls.find((s) => s.id === dish.stallId)?.name ?? dish.cuisine;
  const facts = dishFactsReply(dish, stallName, c);
  if (provider === "offline" || (provider === "gemini" && !hasGeminiKey())) return { text: facts, source: "offline" };
  try {
    const cuisineOf = Object.fromEntries(args.stalls.map((s) => [s.id, s.name]));
    const context = `DISH:\n${menuLines([dish], cuisineOf)}\nDESCRIPTION FROM OUR DATA (not checked with the stall): ${dish.description ?? ""}`;
    const result = provider === "enterprise"
      ? await askEnterprise({ message: args.message, context: `${DISH_PROMPT}\n${context}`, history: args.history ?? [] })
      : await askGemini({ message: args.message, history: args.history ?? [], context, system: DISH_PROMPT });
    if (!Array.isArray(result.dishIds) || result.dishIds.some((id) => id !== dish.id)) throw new Error("invalid_recommendation");
    const prose = safeProse(result.reply, { max: 900 });
    if (!prose) return { text: facts, source: "rules", warning: "unsafe_text" };
    return { text: prose, source: provider, model: result.model };
  } catch {
    return { text: facts, source: "offline", warning: provider === "enterprise" ? "Enterprise unavailable" : "AI unavailable" };
  }
}

async function explainDish(args, c, dish, provider) {
  const day = dayOf(args);
  const fit = dishFit(dish, c, day.weekday, day.time);
  const prose = await dishProse(args, c, dish, provider);
  return {
    reply: [prose.text, fitLine(fit, c)].filter(Boolean).join("\n\n"),
    dishIds: [dish.id], dishId: dish.id, fit: fit.verdict, kind: "explanation", source: prose.source,
    ...(prose.model ? { model: prose.model } : {}), ...(prose.warning ? { warning: prose.warning } : {}),
  };
}

// ---------- The selected lunch ----------

// Items, prices, total and money left come from code (lunchFacts). AI is asked only to explain a dish.
async function answerAboutLunch(args, c, intent, provider) {
  const lunch = args.lunch;
  const byId = new Map(args.dishes.map((d) => [d.id, d]));
  const fit = lunchFit(lunch, byId, c, dayOf(args).time);
  let prose = null;
  if (intent.explain) prose = await dishProse(args, c, byId.get(lunch.items[intent.target === "drink" ? 1 : 0].dishId), provider);
  return {
    reply: [prose?.text, lunchFacts(lunch, intent, c.ru), fitLine(fit, c)].filter(Boolean).join("\n\n"),
    dishIds: lunch.items.map((i) => i.dishId), fit: fit.verdict, kind: "lunch",
    source: prose?.source ?? "rules", explained: Boolean(prose),
    ...(prose?.model ? { model: prose.model } : {}), ...(prose?.warning ? { warning: prose.warning } : {}),
  };
}

// ---------- A dish named in the question ----------

const NAME_QUESTION = /^(?:what(?:'s|’s|s| is| are)|what does|tell me about|explain|describe|что такое|что это за|что это|расскажи (?:про|об|о)|объясни(?: что такое)?)\s+(.+)$/i;

// "What is nasi lemak?" -> a menu item with that name, looked up in the whole menu (not only what fits).
export function findNamedDish(message, dishes) {
  const m = NAME_QUESTION.exec(String(message).split(/[?!.\n]/)[0].trim());
  if (!m) return null;
  const q = m[1].toLowerCase().replace(/\b(?:a|an|the|mean|means|exactly|please|dish|called)\b/g, " ").replace(/["'«»“”,:;()]/g, " ").replace(/\s+/g, " ").trim();
  if (q.length < 3 || /^(?:this|it|that|these|those|in it|in this|in the|my|это|оно|в нём|в нем)(?:\s|$)/.test(q)) return null;
  const norm = (d) => d.name.toLowerCase().replace(/\s*[—–(].*$/, "").replace(/\s+/g, " ").trim();
  const scored = [];
  for (const d of dishes) {
    const name = norm(d);
    const score = name === q ? 4 : name.startsWith(q) ? 3 : name.includes(q) ? 2 : name.length >= 5 && q.includes(name) ? 1 + name.length / 100 : 0;
    if (score) scored.push({ d, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.d.role === "main" ? 0 : 1) - (b.d.role === "main" ? 0 : 1)
    || a.d.name.length - b.d.name.length || (a.d.price ?? Infinity) - (b.d.price ?? Infinity));
  return scored[0]?.d ?? null;
}

// ---------- Recommendations ----------

const constraintsOf = (args) => args.constraints ?? constraintsFor(args.message, args.prefs, args.history, args.conversationConstraints);

export function offlineRecommend(args) {
  const c = constraintsOf(args);
  if (RATING_QUESTION.test(args.message)) {
    const rated=args.stalls.filter(s=>args.ratings?.[s.id]?.count);
    if (!rated.length) return {reply:c.ru?'Оценок пока нет.':'There are no ratings yet.',dishIds:[],kind:'info'};
    const best=Math.max(...rated.map(s=>args.ratings[s.id].avg));
    const leaders=rated.filter(s=>args.ratings[s.id].avg===best).map(s=>`${s.name}: ${best}/5 (${args.ratings[s.id].count})`);
    return {reply:(c.ru?'Наивысшая оценка в анонимном опросе; число оценок в скобках: ':'Highest rating in the anonymous poll; number of ratings in parentheses: ')+leaders.join('; '),dishIds:[],kind:'info'};
  }
  const options=candidates(args,c).sort((a,b)=>(a.price??Infinity)-(b.price??Infinity)).slice(0,3);
  return withNotes(describe(args,c,options), c);
}

export async function recommend(args) {
  const c = constraintsOf(args);
  args = { ...args, constraints: c };
  const provider=process.env.AI_PROVIDER || (hasGeminiKey() ? 'gemini' : 'offline');
  const aiOff = provider==='offline' || (provider==='gemini' && !hasGeminiKey());

  // 1. Unclear text: one question, nothing is guessed.
  if (c.clarify) return { reply: c.clarify, dishIds: [], kind: "clarify", source: "rules" };

  // 2. A selected lunch that could not be verified against the current menu is never discussed from browser data.
  if (args.lunchError) {
    return { reply: `${LUNCH_ERRORS[args.lunchError] ?? "The selected lunch could not be verified."} Please go back to Lunch and search again.`, dishIds: [], kind: "unknown", source: "rules" };
  }

  // 3. Questions about the selected lunch ("Which drink is included?", "How much altogether?", "What is this?").
  const named = findNamedDish(args.message, args.dishes);
  if (args.lunch) {
    const inSet = named && args.lunch.items.some((i) => i.dishId === named.id);
    const intent = lunchIntent(args.message, args.lunch, { namesOtherDish: Boolean(named) && !inSet });
    if (intent.about) return withNotes(await answerAboutLunch(args, c, intent, provider), c);
  }

  // 4. A question about one dish: the dish opened by the student, or a dish named in the question.
  const dish = args.dishId ? args.dishes.find(d=>d.id===args.dishId) : null;
  if (dish && (!args.dishSticky || refersToSelection(args.message, [dish]))) return withNotes(await explainDish(args,c,dish,provider), c);
  if (named) return withNotes(await explainDish(args,c,named,provider), c);
  // "How much is the whole set?" or "Is it spicy?" with nothing selected: say so instead of guessing a dish.
  if (!args.lunch && !dish && isQuestionOnly(args.message) && refersToSelection(args.message, [])) {
    return { reply: c.ru
      ? 'Сейчас не выбран ни обед, ни блюдо, поэтому я не знаю, о чём вопрос. Выберите вариант на вкладке Lunch и нажмите «Ask about it» или назовите блюдо.'
      : 'No lunch or dish is selected right now, so I cannot tell what this refers to. Pick an option in Lunch and press "Ask about it", or name the dish.',
      dishIds: [], kind: "unknown", source: "rules" };
  }

  // 5. Poll ratings, then recommendations from the items that pass every constraint.
  if (RATING_QUESTION.test(args.message)) return {...offlineRecommend(args),source:'rules'};
  const menu=candidates(args,c);
  if (!menu.length) return {...offlineRecommend(args),source:'rules'};
  if (aiOff) return {...offlineRecommend(args),source:'offline'};
  try {
    const context=buildContext(args,c,menu);
    const result=provider==='enterprise'
      ? await askEnterprise({message:args.message,context,history:args.history ?? []})
      : await askGemini({message:args.message,history:args.history ?? [],context});
    const valid=new Map(menu.map(d=>[d.id,d]));
    if (!Array.isArray(result.dishIds) || result.dishIds.some(id=>!valid.has(id))) throw new Error('invalid_recommendation');
    const picks=[...new Set(result.dishIds)].slice(0,3).map(id=>valid.get(id));
    // Model prose is shown only without safety promises and without money amounts: prices come from the menu cards.
    const prose=safeProse(result.reply,{max:1500});
    if (!picks.length) {
      // No pick is not "nothing matches": items did match, the model answered in words (or had nothing to add).
      const reply = prose ?? (c.ru
        ? 'По данным меню я не могу ответить на этот вопрос. Спросите о блюде по названию или назовите бюджет и предпочтения.'
        : 'I do not have enough menu information to answer that. Ask about a dish by name, or tell me your budget and what you like.');
      return withNotes({reply,dishIds:[],kind:prose?'info':'unknown',model:result.model,source:prose?provider:'rules'}, c);
    }
    // Constrained answers are rebuilt from validated menu facts.
    const answer=prose && !c.restricted ? {reply:prose,dishIds:picks.map(d=>d.id),kind:'selection'} : describe(args,c,picks);
    return withNotes({...answer,model:result.model,source:provider}, c);
  } catch {
    return {...offlineRecommend(args),source:'offline',warning:provider==='enterprise'?'Enterprise unavailable':'AI unavailable'};
  }
}
