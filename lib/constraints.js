// Chat constraints: what the student told us (English or Russian) about budget, diet, allergens and spice.
//
// Precedence, strongest first:
//   1. Saved preferences (the Me tab) are a floor. Chat text can add restrictions, never remove a saved
//      diet or a saved allergen exclusion. When text seems to relax one, it stays and a note says so.
//   2. The current message. An explicit new budget, spice or diet choice replaces the earlier chat value.
//   3. The conversation state the page sends back (`previous`): the result of earlier turns, or the choices of
//      the lunch form when the student pressed "Ask about it".
//   4. Old messages (`history`) are read only when there is no conversation state at all. They never
//      override a newer form selection or a newer state.
//
// A keyword alone is not intent. "not vegan", "no allergies", "without chilli", "is it vegan?" and
// "What is Vegetarian Fried Rice?" each mean something different, so every sentence is classified
// (statement or request / question about a dish / question about a name) and negation is checked next to
// the word it applies to. When the meaning is unclear, nothing changes and one short question is asked.
//
// This module only interprets text. Whether an item may be shown is still decided by eligible() and by
// lib/lunch.js on the server.
import { ALLERGENS, fitsPrefs, fitsBudget } from '../public/shared/filters.js';

const RU_WORD = 'а-яё';
const ALLERGEN_ALIASES = {
  peanuts: `peanuts?|\\bnuts?\\b|арахис[${RU_WORD}]*|орех[${RU_WORD}]*`,
  'tree nuts': `\\bnuts?\\b|almonds?|cashews?|walnuts?|hazelnuts?|pistachios?|миндал[${RU_WORD}]*|кешью|грецк[${RU_WORD}]*|фундук[${RU_WORD}]*|фисташ[${RU_WORD}]*|орех[${RU_WORD}]*`,
  milk: `milk|dairy|lactose|cheese|молок[${RU_WORD}]*|молоч[${RU_WORD}]*|лактоз[${RU_WORD}]*|сыр(?:а|ом|ы|у)?(?![${RU_WORD}])`,
  egg: `\\beggs?\\b|яйц[${RU_WORD}]*|яиц`,
  'wheat/gluten': `wheat|gluten|пшениц[${RU_WORD}]*|глютен[${RU_WORD}]*`,
  soy: `\\bsoy\\b|\\bsoya\\b|(?<![${RU_WORD}])со[яюией](?![${RU_WORD}])|соев[${RU_WORD}]*`,
  fish: `\\bfish\\b|(?<![${RU_WORD}])рыб[${RU_WORD}]*`,
  shellfish: `shellfish|shrimps?|prawns?|seafood|crab|кревет[${RU_WORD}]*|моллюск[${RU_WORD}]*|морепродукт[${RU_WORD}]*|краб[${RU_WORD}]*`,
  sesame: `sesame|кунжут[${RU_WORD}]*`,
};
const ALLERGEN_RE = Object.fromEntries(Object.entries(ALLERGEN_ALIASES).map(([name, src]) => [name, new RegExp(src, 'i')]));
const ANY_ALLERGEN = new RegExp(Object.values(ALLERGEN_ALIASES).join('|'), 'gi');
const allergensIn = (text) => Object.entries(ALLERGEN_RE).filter(([, re]) => re.test(text)).map(([name]) => name);

const DIET_RANK = { any: 0, vegetarian: 1, vegan: 2 };
const stricter = (a, b) => (DIET_RANK[a] >= DIET_RANK[b] ? a : b);

export function normalizePrefs(value) {
  const p = value && typeof value === 'object' ? value : {};
  return { diet: ['vegetarian', 'vegan'].includes(p.diet) ? p.diet : 'any',
    avoidAllergens: Array.isArray(p.avoidAllergens) ? [...new Set(p.avoidAllergens.filter(x => ALLERGENS.includes(x)))] : [] };
}

// ---------- Sentence classification ----------

const FILLER = /^(?:and|so|ok|okay|hi|hello|hey|please|well|also|but|а|и|ну|так|привет|пожалуйста|ещё|еще)[\s,]+/i;
const REQUEST = new RegExp([
  'should i', 'can i (?:get|eat|have|buy|order)', 'could i', 'recommend', 'suggest', 'ideas?', 'options?', 'anything',
  'something', 'looking for', 'i want', 'i need', "i'd like", 'i would like', 'find me', 'show me', 'give me',
  'what (?:can|should|could) i', 'what to eat', 'lunch', 'dinner', 'breakfast', 'meals?', 'here', 'on the menu',
  'today', 'available', 'cheap\\w*', 'another', 'other',
].map((x) => `\\b${x}\\b`).join('|') + `|посоветуй|порекомендуй|что[-\\s]нибудь|хочу|нужн[${RU_WORD}]+|найди|покажи|вариант|иде[яи]|что (?:мне )?(?:съесть|поесть|взять|выбрать)|обед|поесть|друго[ейгм]`, 'i');
const REQUEST_START = /^(?:is there|are there|do you (?:have|sell|serve)|does (?:the|this) (?:menu|canteen|food court) have|can you|could you|can i (?:get|have|order|buy)|есть ли (?:у вас |здесь |тут )?(?:что|какие))/i;
const INFO_START = new RegExp(`^(?:what(?:'s|’s| is| are| does|s)?\\b|tell me (?:about|more)|explain|describe|how (?:spicy|hot|sweet|big|much|many|is|are|does|do)\\b|which\\b|why\\b|where\\b|who\\b|что(?![${RU_WORD}])|как(?:ой|ая|ое|ие|ую)?(?![${RU_WORD}])|расскажи|объясни|опиши|почему|где|сколько|из чего)`, 'i');
const YESNO_START = /^(?:is|are|does|do|did|can|could|will|would|has|have|was|were)\b/i;
const DEICTIC_AFTER = /^(?:is|are|does|do|did|can|could|will|would|has|have|was|were)\s+(?:it|this|that|these|those|they|the\b|my\b|mine\b)/i;
const RU_QUESTION_START = new RegExp(`^(?:это|оно|он|она|они|там|тут|в\\s+(?:нём|нем|ней|них|этом|составе)|есть ли|содержит|входит)(?![${RU_WORD}])`, 'i');
const FIRST_PERSON = new RegExp(`\\b(?:i am|i'm|i’m|im|i have|i've|i eat|i only eat|i do not|i don't|i can't|i cannot|we are|we're|as a)\\b|(?<![${RU_WORD}])(?:я|мне|у меня|для меня)(?![${RU_WORD}])`, 'i');

// "What is nasi lemak?" asks about a name; "What's a good vegetarian lunch?" asks for a pick.
const NAME_QUESTION = /^(?:what(?:'s|’s|s| is| are)\b|what does\b|что такое|что это|tell me about|explain|describe|расскажи|объясни|опиши)/i;
const ASKS_FOR_PICK = /^what(?:'s|’s|s| is| are)\s+(?:(?:a|an|the|some|your)\s+)?(?:good|nice|best|great|cheap\w*|popular|tasty|recommended|filling|healthy)\b/i;
// "request": states or asks for something to eat - constraints in it apply.
// "question": asks about a dish, the selected lunch or a name - nothing in it changes the constraints.
function sentenceKind(sentence) {
  let s = sentence.trim();
  while (FILLER.test(s)) s = s.replace(FILLER, '');
  const asks = /\?\s*$/.test(s);
  if (DEICTIC_AFTER.test(s)) return 'question';
  if (REQUEST_START.test(s)) return 'request';
  const wantsFood = REQUEST.test(s);
  if (ASKS_FOR_PICK.test(s)) return 'request';
  if (INFO_START.test(s)) return wantsFood && !NAME_QUESTION.test(s) ? 'request' : 'question';
  if (YESNO_START.test(s) || RU_QUESTION_START.test(s)) return wantsFood ? 'request' : 'question';
  if (asks && !wantsFood && !FIRST_PERSON.test(s)) return 'question';
  return 'request';
}

const splitSentences = (text) => String(text ?? '').split(/(?<=[!?;\n])\s*|(?<=\.)(?!\d)\s*/).map((s) => s.trim()).filter(Boolean);

// True when the whole message only asks about something ("How much is the whole set?") and requests no food.
export const isQuestionOnly = (text) => {
  const sentences = splitSentences(text);
  return sentences.length > 0 && sentences.every((s) => sentenceKind(s) === 'question');
};

// Dish names in the message ("Vegetarian Fried Rice", "Chilli Pan Mee") are not statements about the student.
function maskDishNames(text, dishNames) {
  let out = text;
  for (const name of dishNames ?? []) {
    let at = out.toLowerCase().indexOf(name);
    while (at >= 0) {
      out = out.slice(0, at) + ' '.repeat(name.length) + out.slice(at + name.length);
      at = out.toLowerCase().indexOf(name, at + name.length);
    }
  }
  return out;
}

// Multi-word menu names, longest first, for maskDishNames.
export function dishNameIndex(dishes) {
  return [...new Set(dishes.map((d) => String(d.name ?? '').toLowerCase().replace(/\s*[—–(].*$/, '').trim()).filter((n) => /\s/.test(n)))]
    .sort((a, b) => b.length - a.length);
}

// ---------- Budget ----------

const AMOUNT = new RegExp(`\\brm\\s*(\\d+(?:[.,]\\d{1,2})?)|(\\d+(?:[.,]\\d{1,2})?)\\s*(?:rm\\b|ringgit|myr\\b|ринг[${RU_WORD}]*)`, 'gi');
const CUE_AMOUNT = new RegExp(`(?:under|below|budget(?:\\s+(?:is|of))?|less than|up to|at most|max(?:imum)?|within|no more than|(?<![${RU_WORD}])до|бюджет[${RU_WORD}]*|не больше|не дороже|максимум|в пределах)\\s*(?:rm\\s*)?(\\d+(?:[.,]\\d{1,2})?)(?!\\s*(?:%|pm|am|:\\d))`, 'gi');
const BUDGET_CUE = new RegExp(`\\b(?:i have|i've got|i got|only have|budget|under|below|less than|up to|at most|max(?:imum)?|within|no more than|spend)\\b|у меня|бюджет|(?<![${RU_WORD}])до(?![${RU_WORD}])|не больше|не дороже|максимум|в пределах`, 'i');
const NO_BUDGET = /\bno budget\b|\bany price\b|price does(?:n'?t| not) matter|budget does(?:n'?t| not) matter|без бюджета|любая цена|цена не важна|бюджет не важен/i;

function budgetIn(sentence, kind) {
  if (NO_BUDGET.test(sentence)) return { cleared: true };
  if (kind === 'question' && !BUDGET_CUE.test(sentence)) return null; // "Why is it RM8?" is about a price, not a budget
  const found = [];
  for (const re of [AMOUNT, CUE_AMOUNT]) {
    re.lastIndex = 0;
    for (let m = re.exec(sentence); m; m = re.exec(sentence)) found.push({ at: m.index, value: Number((m[1] ?? m[2]).replace(',', '.')) });
  }
  const valid = found.filter((f) => Number.isFinite(f.value) && f.value > 0 && f.value <= 1000).sort((a, b) => a.at - b.at);
  return valid.length ? { value: valid.at(-1).value } : null;
}

// ---------- Diet ----------

const DIET_WORD = new RegExp(`\\b(vegan|vegetarian|veggie)s?\\b|(веган[${RU_WORD}]*|вегетариан[${RU_WORD}]*)`, 'gi');
const NEGATION_BEFORE = new RegExp(`(?:\\bnot\\b|\\bno longer\\b|\\bnon[\\s-]*|n['’]?t\\b|\\bnever\\b|\\bno need (?:for|to be)\\b|(?<![${RU_WORD}])(?:не|нет|больше не)(?![${RU_WORD}]))\\s*(?:(?:a|an|the|really|strictly|actually|fully|exactly|necessarily|even|being|need|want|have to be|need to be|обязательно|совсем|вообще|строго|строгий|нужно|надо)\\s+){0,3}$`, 'i');
const EATS_MEAT = new RegExp(`\\bi (?:do )?eat (?:meat|chicken|beef|fish|everything|anything)\\b|\\bmeat is (?:fine|ok|okay)\\b|(?<![${RU_WORD}])(?:я )?ем (?:мясо|курицу|рыбу|вс[её])(?![${RU_WORD}])`, 'i');
const DIET_ASSERT = new RegExp(`\\b(?:i am|i'm|i’m|im|we are|we're|as a|i eat|i only eat)\\b[^,.;]{0,24}\\b(?:vegan|vegetarian|veggie)|(?<![${RU_WORD}])я\\s[^,.;]{0,16}(?:веган|вегетариан)`, 'i');

// {set: 'vegan'|'vegetarian'} | {cleared: true} | null
function dietIn(sentence, kind) {
  let result = EATS_MEAT.test(sentence) ? { cleared: true } : null;
  DIET_WORD.lastIndex = 0;
  for (let m = DIET_WORD.exec(sentence); m; m = DIET_WORD.exec(sentence)) {
    const word = m[0].toLowerCase();
    const diet = /^(?:vegan|веган)/.test(word) ? 'vegan' : 'vegetarian';
    if (NEGATION_BEFORE.test(sentence.slice(0, m.index))) { result = result?.set ? result : { cleared: true }; continue; }
    if (kind === 'question' && !DIET_ASSERT.test(sentence)) continue; // "Is it vegan?" asks, it does not state
    result = { set: result?.set ? stricter(result.set, diet) : diet };
  }
  return result;
}

// ---------- Spice ----------

const SPICE_SOFT = '(?:(?:too|very|so|that|any|anything|much|really|the|extra|added|food|meals?|dish(?:es)?|something)\\s+){0,3}';
const NOT_SPICY = new RegExp([
  `(?:\\bno\\b|\\bnot\\b|\\bnon\\b|\\bnon-|\\bnothing\\b|\\bwithout\\b|\\bless\\b|\\bisn['’]?t\\b|\\bavoid\\b|\\bhold the\\b|\\bskip the\\b|(?:do\\s?n['’]?t|do not|can['’]?t|cannot|can not)\\s+(?:like|want|eat|handle|take|tolerate|stand))\\s*${SPICE_SOFT}(?:spic\\w*|chill?i\\w*|hot\\b|heat\\b|pepper\\b)`,
  '\\bmild\\b', '\\bunspicy\\b',
  `(?<![${RU_WORD}])не\\s*(?:очень\\s+|слишком\\s+|сильно\\s+)?остр`, 'неостр',
  `(?<![${RU_WORD}])без\\s+(?:остр|перца|чили|специй)`,
  `(?<![${RU_WORD}])не\\s+(?:люблю|ем|хочу|переношу|могу)\\s+(?:есть\\s+)?(?:остр|чили|перец)`, 'ничего\\s+остр',
].join('|'), 'gi');
const SPICY = new RegExp(`\\bspic(?:y|ier|iest)\\b|\\bextra hot\\b|(?:\\blike|\\blove|\\bwant|\\bwith|\\bextra|\\bmore|\\badd)\\s+(?:(?:some|the|a|lots of|more|extra)\\s+)*chill?i|поостр|(?<![${RU_WORD}])остр(?:ое|ого|ую|ая|ый|ые|еньк)|(?<![${RU_WORD}])с\\s+чили`, 'i');
const ANY_SPICE = /\bany spice\b|spic\w* (?:does(?:n'?t| not) matter|is fine|is ok)|любая острота|острота не важна/i;
const BARE_CHILLI = new RegExp(`^\\W*(?:chill?i(?:es)?(?:\\s+(?:sauce|padi))?|чили|перец)\\W*$`, 'i');

// 'not-spicy' | 'spicy' | 'any' | 'unclear' | null
function spiceIn(sentence, kind) {
  if (ANY_SPICE.test(sentence)) return 'any';
  NOT_SPICY.lastIndex = 0;
  const rest = sentence.replace(NOT_SPICY, ' ');
  if (kind === 'question' && !FIRST_PERSON.test(sentence)) return null; // "Is it spicy?" / "Is it not spicy?"
  if (rest !== sentence) return 'not-spicy';
  if (SPICY.test(rest)) return 'spicy';
  if (BARE_CHILLI.test(sentence)) return 'unclear';
  return null;
}

// ---------- Allergens ----------

const ALLERGY_WORD = new RegExp(`allerg\\w*|intoleran\\w*|аллерг[${RU_WORD}]*|неперенос[${RU_WORD}]*`, 'i');
const NOT_ALLERGIC_TO = new RegExp(`(?:\\bnot\\b|\\bno longer\\b|n['’]?t\\b|\\bnever been\\b)\\s+(?:actually\\s+|really\\s+)?allergic\\s+to\\b|\\bno (?:more )?allergy to\\b|(?<![${RU_WORD}])(?:нет|больше нет)\\s+аллерги[${RU_WORD}]*\\s+на(?![${RU_WORD}])|(?<![${RU_WORD}])не\\s+аллерги[${RU_WORD}]*\\s+на(?![${RU_WORD}])`, 'i');
const NO_ALLERGY = new RegExp([
  `\\b(?:no|not any|zero|without(?: any)?)\\s+(?:known\\s+|food\\s+)?(?:allerg\\w*|intoleran\\w*)`,
  `(?:do\\s?n['’]?t|do not|does\\s?n['’]?t)\\s+have\\s+(?:any\\s+|a\\s+)?(?:known\\s+|food\\s+)?(?:allerg\\w*|intoleran\\w*)`,
  `\\bnot allergic\\b`, `\\bno(?:thing| food) i(?:'m| am) allergic\\b`, `\\bnone\\b`,
  `(?<![${RU_WORD}])нет\\s+(?:у меня\\s+)?(?:пищевой\\s+|пищевых\\s+|никакой\\s+|никаких\\s+)?аллерги`,
  `аллерги[${RU_WORD}]*\\s+(?:у меня\\s+)?нет(?![${RU_WORD}])`, `(?<![${RU_WORD}])без\\s+аллерги`, `(?<![${RU_WORD}])не\\s+аллерги`,
].join('|'), 'i');
const SCAN = new RegExp([
  `(?<free>(?:${Object.values(ALLERGEN_ALIASES).join('|')})(?=[\\s-]*free\\b|\\s+(?:allerg|intoleran)))`,
  `(?<exclude>allerg\\w*|intoleran\\w*|\\bavoid\\w*|\\bwithout\\b|\\bexclud\\w*|\\bexcept\\b|can['’]?t\\s+(?:eat|have)|cannot\\s+(?:eat|have)|do\\s?n['’]?t\\s+eat|do not eat|free\\s+(?:of|from)|\\bno\\b(?!\\s*,)|аллерг[${RU_WORD}]*|неперенос[${RU_WORD}]*|(?<![${RU_WORD}])без(?![${RU_WORD}])|нельзя|исключ[${RU_WORD}]*|(?<![${RU_WORD}])не\\s+(?:ем|могу есть|употребляю)(?![${RU_WORD}])|кроме)`,
  `(?<allow>\\bbut\\b|\\bhowever\\b|\\bthough\\b|\\binstead\\b|\\bi\\s+(?:want|like|love|eat)\\b|\\bi['’]?d like\\b|\\bwith\\b|\\bplus\\b|\\b(?:is|are)\\s+(?:fine|ok|okay)\\b|(?<![${RU_WORD}])(?:но|зато|хочу|люблю|можно|со?)(?![${RU_WORD}]))`,
  `(?<allergen>${Object.values(ALLERGEN_ALIASES).join('|')})`,
].join('|'), 'gi');

// What one sentence says about allergens. startExcluding: the student is answering "which allergen?".
function allergensInSentence(sentence, kind, startExcluding) {
  const out = { add: [], remove: [], none: false, unknown: false };
  const removal = NOT_ALLERGIC_TO.exec(sentence);
  if (removal) {
    const named = allergensIn(sentence.slice(removal.index + removal[0].length));
    if (named.length) out.remove = named;
    else out.none = true;
    return out;
  }
  const hasAllergyWord = ALLERGY_WORD.test(sentence);
  if (NO_ALLERGY.test(sentence) && (hasAllergyWord || startExcluding)) { out.none = true; return out; }
  // "Does it contain peanuts?" asks. "Is it OK with a peanut allergy?" names an allergy, so it is kept (the safe reading).
  if (kind === 'question' && !hasAllergyWord) return out;
  // "peanut allergy": the allergy word comes after the name, so the whole sentence starts in exclude mode.
  let excluding = hasAllergyWord || startExcluding;
  SCAN.lastIndex = 0;
  for (let m = SCAN.exec(sentence); m; m = SCAN.exec(sentence)) {
    if (m.groups.free) out.add.push(...allergensIn(m.groups.free));
    else if (m.groups.exclude) excluding = true;
    else if (m.groups.allow) excluding = false;
    else if (m.groups.allergen && excluding) out.add.push(...allergensIn(m.groups.allergen));
  }
  // "What allergens does it have?" is a question about a dish, not a statement that the student has an allergy.
  if (hasAllergyWord && !out.add.length && (kind !== 'question' || FIRST_PERSON.test(sentence))) out.unknown = true;
  return out;
}

// ---------- One message ----------

// Reads one student message. Pure: returns what the message says, not the resulting state.
export function interpretMessage(text, { answeringAllergy = false, dishNames = [] } = {}) {
  const said = { budget: undefined, diet: undefined, spice: undefined, addAllergens: [], removeAllergens: [], noAllergy: false, unknownAllergy: false, unclearSpice: false };
  for (const sentence of splitSentences(text)) {
    const kind = sentenceKind(sentence);
    const masked = maskDishNames(sentence, dishNames);
    const budget = budgetIn(sentence, kind);
    if (budget) said.budget = budget.cleared ? null : budget.value;
    const diet = dietIn(masked, kind);
    if (diet) said.diet = diet.set ?? 'any';
    const spice = spiceIn(masked, kind);
    if (spice === 'unclear') said.unclearSpice = true;
    else if (spice) { said.spice = spice; said.unclearSpice = false; }
    // Allergen names inside a dish name still count: excluding too much is the safe mistake.
    const a = allergensInSentence(sentence, kind, answeringAllergy);
    said.addAllergens.push(...a.add);
    said.removeAllergens.push(...a.remove);
    if (a.none) { said.noAllergy = true; said.unknownAllergy = false; }
    if (a.unknown && !said.noAllergy) said.unknownAllergy = true;
  }
  said.addAllergens = [...new Set(said.addAllergens)];
  said.removeAllergens = [...new Set(said.removeAllergens)].filter((x) => !said.addAllergens.includes(x));
  if (said.addAllergens.length) said.unknownAllergy = false;
  return said;
}

export const hasState = (previous) => Boolean(previous && typeof previous === 'object'
  && ['budget', 'spice', 'diet', 'avoidAllergens', 'chatDiet', 'chatAllergens', 'unknownAllergy'].some((k) => k in previous));

function startState(previous) {
  const prior = normalizePrefs(previous);
  const chatPrior = normalizePrefs({ diet: previous?.chatDiet ?? previous?.diet, avoidAllergens: previous?.chatAllergens ?? previous?.avoidAllergens });
  return {
    budget: typeof previous?.budget === 'number' && Number.isFinite(previous.budget) && previous.budget > 0 ? previous.budget : null,
    spice: ['spicy', 'not-spicy'].includes(previous?.spice) ? previous.spice : 'any',
    chatDiet: 'chatDiet' in (previous ?? {}) ? chatPrior.diet : prior.diet,
    chatAllergens: 'chatAllergens' in (previous ?? {}) ? chatPrior.avoidAllergens : prior.avoidAllergens,
    unknownAllergy: previous?.unknownAllergy === true,
  };
}

function apply(state, said) {
  if (said.budget !== undefined) state.budget = said.budget;
  if (said.diet !== undefined) state.chatDiet = said.diet;
  if (said.spice !== undefined) state.spice = said.spice;
  if (said.noAllergy) { state.chatAllergens = []; state.unknownAllergy = false; }
  if (said.removeAllergens.length) state.chatAllergens = state.chatAllergens.filter((x) => !said.removeAllergens.includes(x));
  if (said.addAllergens.length) { state.chatAllergens = [...new Set([...state.chatAllergens, ...said.addAllergens])]; state.unknownAllergy = false; }
  if (said.unknownAllergy) state.unknownAllergy = true;
}

// options.dishNames: from dishNameIndex(), so dish names are not read as statements.
export function constraintsFor(message, prefs, history = [], previous = {}, options = {}) {
  const saved = normalizePrefs(prefs);
  const state = startState(previous);
  const ru = /[а-яё]/i.test(String(message ?? ''));
  // Old messages matter only when the page sent no conversation state (first turn of a restored chat).
  if (!hasState(previous)) {
    for (const turn of (Array.isArray(history) ? history : []).filter((x) => x?.role === 'user').slice(-6)) {
      apply(state, interpretMessage(String(turn.text ?? ''), { answeringAllergy: state.unknownAllergy, dishNames: options.dishNames }));
    }
  }
  const said = interpretMessage(String(message ?? ''), { answeringAllergy: state.unknownAllergy, dishNames: options.dishNames });
  apply(state, said);

  // Saved preferences stay, whatever the text said. Tell the student instead of silently ignoring them.
  const notes = [];
  const keptAllergens = saved.avoidAllergens.filter((x) => said.removeAllergens.includes(x) || said.noAllergy);
  if (keptAllergens.length) notes.push(ru
    ? `Сохранённое исключение (${keptAllergens.join(', ')}) остаётся в силе. Изменить его можно на вкладке Me.`
    : `Your saved exclusion (${keptAllergens.join(', ')}) still applies. You can change it in the Me tab.`);
  if (said.diet !== undefined && DIET_RANK[saved.diet] > DIET_RANK[said.diet]) notes.push(ru
    ? `Сохранённая диета (${saved.diet}) остаётся в силе. Изменить её можно на вкладке Me.`
    : `Your saved diet (${saved.diet}) still applies. You can change it in the Me tab.`);

  let clarify = null;
  if (state.unknownAllergy) clarify = ru
    ? 'Уточните, какой продукт или аллерген нужно исключить. До уточнения я не буду подбирать блюда.'
    : 'Which ingredient or allergen must be excluded? I will wait for that detail before suggesting food.';
  else if (said.unclearSpice) clarify = ru
    ? 'Вы хотите острое блюдо или блюдо без чили?'
    : 'Do you want spicy food, or food without chilli?';

  const c = {
    diet: stricter(saved.diet, state.chatDiet),
    avoidAllergens: [...new Set([...saved.avoidAllergens, ...state.chatAllergens])],
    budget: state.budget,
    spice: state.spice,
    unknownAllergy: state.unknownAllergy,
    chatDiet: state.chatDiet,
    chatAllergens: state.chatAllergens,
    saved,
    notes,
    clarify,
    ru,
  };
  c.restricted = c.diet !== 'any' || c.avoidAllergens.length > 0 || c.budget !== null || c.spice !== 'any';
  return c;
}

// weekday: English day name. time: "HH:MM" on that day, or null when unknown (then "available after 15:00" items are left out).
export function eligible(dish, c, weekday, time = null) {
  if (c.unknownAllergy || dish.available === false || dish.available === null || (dish.days?.length && !dish.days.includes(weekday))) return false;
  if (dish.availableAfter && !(time && time >= dish.availableAfter)) return false;
  if (!fitsPrefs(dish, c) || !fitsBudget(dish, c.budget)) return false;
  if (c.spice !== 'any' && !Number.isFinite(dish.spicy)) return false;
  if (c.spice === 'not-spicy' && dish.spicy > 1) return false;
  if (c.spice === 'spicy' && dish.spicy < 2) return false;
  return true;
}
