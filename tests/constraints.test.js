// Chat constraints: negation, scope of each phrase, questions versus statements, and precedence.
import test from "node:test";
import assert from "node:assert/strict";
import { constraintsFor, interpretMessage, dishNameIndex } from "../lib/constraints.js";

const pick = (c) => ({ diet: c.diet, spice: c.spice, budget: c.budget, avoid: c.avoidAllergens, unknown: c.unknownAllergy });
const NONE = { diet: "any", spice: "any", budget: null, avoid: [], unknown: false };
const read = (message, prefs = {}, history = [], previous = {}, options = {}) => pick(constraintsFor(message, prefs, history, previous, options));

test("the four audited mistakes are fixed", () => {
  assert.deepEqual(read("I want chicken without chilli"), { ...NONE, spice: "not-spicy" });
  assert.deepEqual(read("I am not vegan"), NONE);
  assert.deepEqual(read("I have no allergies"), NONE);
  // A new context (budget 12) is not overwritten by an old message that said RM5.
  assert.equal(read("something else", {}, [{ role: "user", text: "I have RM5" }], { budget: 12 }).budget, 12);
});

test("negation applies to the word it stands next to, in English and Russian", () => {
  const cases = [
    ["I am not vegan", NONE], ["I'm not a vegetarian", NONE], ["non-vegetarian food please", NONE],
    ["Я не веган", NONE], ["я не вегетарианец", NONE],
    ["not vegan but vegetarian", { ...NONE, diet: "vegetarian" }],
    ["I am vegan", { ...NONE, diet: "vegan" }], ["Я вегетарианец", { ...NONE, diet: "vegetarian" }],
    ["chicken without chilli", { ...NONE, spice: "not-spicy" }], ["курица без чили", { ...NONE, spice: "not-spicy" }],
    ["no chili please", { ...NONE, spice: "not-spicy" }], ["I don't like spicy food", { ...NONE, spice: "not-spicy" }],
    ["не люблю острое", { ...NONE, spice: "not-spicy" }], ["не очень острое", { ...NONE, spice: "not-spicy" }],
    ["I like spicy food", { ...NONE, spice: "spicy" }], ["хочу острое", { ...NONE, spice: "spicy" }],
    ["I have no allergies", NONE], ["I don't have any allergies", NONE], ["I am not allergic to anything", NONE],
    ["у меня нет аллергии", NONE], ["аллергии нет", NONE],
    ["no peanuts please", { ...NONE, avoid: ["peanuts"] }], ["без арахиса", { ...NONE, avoid: ["peanuts"] }],
    ["я не ем рыбу", { ...NONE, avoid: ["fish"] }], ["без молока и яиц", { ...NONE, avoid: ["milk", "egg"] }],
    ["peanut allergy, but egg is fine", { ...NONE, avoid: ["peanuts"] }],
    ["allergic to peanuts, eggs and milk", { ...NONE, avoid: ["peanuts", "egg", "milk"] }],
    ["у меня аллергия на арахис, но яйца можно", { ...NONE, avoid: ["peanuts"] }],
    ["gluten-free please", { ...NONE, avoid: ["wheat/gluten"] }],
  ];
  for (const [message, expected] of cases) assert.deepEqual(read(message), expected, message);
});

test("a question about a dish or a dish name does not change the constraints", () => {
  const dishNames = dishNameIndex([{ name: "Vegetarian Fried Rice" }, { name: "Chilli Pan Mee" }, { name: "Egg Fried Rice" }, { name: "Milk" }]);
  for (const message of [
    "Is this vegan?", "Is nasi lemak vegetarian?", "Это веганское?", "Is it spicy?", "How spicy is it?", "это острое?",
    "Does it contain peanuts?", "есть ли там арахис?", "Is it gluten-free?", "What allergens does it have?",
    "What is nasi lemak with egg?", "What is Vegetarian Fried Rice?", "Why is it RM8?",
    "Which drink was included, and how much is the whole set?", "How much is left?",
  ]) assert.deepEqual(read(message, {}, [], {}, { dishNames }), NONE, message);
  // A dish name is not a statement about the student...
  assert.deepEqual(read("I want the Vegetarian Fried Rice", {}, [], {}, { dishNames }), NONE);
  assert.deepEqual(read("I want the Chilli Pan Mee", {}, [], {}, { dishNames }), NONE);
  // ...but asking for food with a restriction is, and a named allergy is always kept (the safe reading).
  assert.equal(read("Vegetarian lunch ideas?").diet, "vegetarian");
  assert.equal(read("Is there anything vegan?").diet, "vegan");
  assert.equal(read("What should I eat for RM10, not spicy?").budget, 10);
  assert.deepEqual(read("Is it OK with a peanut allergy?").avoid, ["peanuts"]);
  assert.deepEqual(read("Do you have anything without nuts?").avoid, ["peanuts", "tree nuts"]);
});

test("a keyword alone is not intent: unclear text asks one question and changes nothing", () => {
  const chilli = constraintsFor("chilli", {});
  assert.equal(chilli.spice, "any");
  assert.match(chilli.clarify, /spicy food, or food without chilli/);
  assert.match(constraintsFor("чили", {}).clarify, /острое блюдо или блюдо без чили/);
  const allergy = constraintsFor("I have a food allergy", {});
  assert.equal(allergy.unknownAllergy, true);
  assert.match(allergy.clarify, /Which ingredient or allergen/);
  // The next message answers the question: a name is an exclusion, "none" clears it.
  assert.deepEqual(read("gluten", {}, [], allergy).avoid, ["wheat/gluten"]);
  assert.equal(read("gluten", {}, [], allergy).unknown, false);
  assert.deepEqual(read("none", {}, [], allergy), NONE);
  assert.equal(constraintsFor("What is nasi lemak?", {}, [], allergy).unknownAllergy, true, "still waiting for the detail");
});

test("precedence: newer statements replace older chat values; history never beats the current state", () => {
  const form = { budget: 10, spice: "not-spicy", diet: "any", avoidAllergens: [] }; // set by "Ask about it"
  const history = [{ role: "user", text: "I have RM5 and I am vegan, allergic to egg" }];
  assert.deepEqual(read("What is this?", {}, history, form), { ...NONE, budget: 10, spice: "not-spicy" });
  // An explicit new budget in the current message does apply.
  assert.equal(read("actually I have RM15", {}, history, form).budget, 15);
  assert.equal(read("у меня 7 ринггит", {}, history, form).budget, 7);
  assert.equal(read("any spice is fine", {}, [], form).spice, "any");
  assert.equal(read("no budget", {}, [], form).budget, null);
  // Without any state (first turn of a restored chat) the old messages are read, oldest first.
  assert.deepEqual(read("under RM10", {}, history, null), { ...NONE, diet: "vegan", budget: 10, avoid: ["egg"] });
  // Explicitly changing an earlier chat restriction.
  const vegan = constraintsFor("I am vegan", {});
  assert.equal(read("I am not vegan", {}, [], vegan).diet, "any");
  const egg = constraintsFor("no egg please", {});
  assert.deepEqual(read("I am not allergic to egg", {}, [], egg).avoid, []);
});

test("saved preferences are never removed by chat text, and the student is told", () => {
  const saved = { diet: "vegan", avoidAllergens: ["peanuts"] };
  const notVegan = constraintsFor("I am not vegan", saved);
  assert.equal(notVegan.diet, "vegan");
  assert.match(notVegan.notes.join(" "), /saved diet \(vegan\) still applies/);
  const noAllergies = constraintsFor("I have no allergies", saved, [], { chatAllergens: ["egg"] });
  assert.deepEqual(noAllergies.avoidAllergens, ["peanuts"], "the chat exclusion goes, the saved one stays");
  assert.match(noAllergies.notes.join(" "), /saved exclusion \(peanuts\) still applies/);
  assert.deepEqual(constraintsFor("I am not allergic to peanuts", saved).avoidAllergens, ["peanuts"]);
  assert.match(constraintsFor("у меня нет аллергии", saved).notes.join(" "), /остаётся в силе/);
  // The page gets the chat part separately, so removing a chat chip cannot remove a saved preference.
  const c = constraintsFor("no egg, vegetarian please", { diet: "any", avoidAllergens: ["milk"] });
  assert.deepEqual(c.chatAllergens, ["egg"]);
  assert.equal(c.chatDiet, "vegetarian");
  assert.deepEqual(c.avoidAllergens, ["milk", "egg"]);
});

test("one message is read sentence by sentence", () => {
  const said = interpretMessage("What is nasi lemak? I'm allergic to peanuts. RM8 at most.");
  assert.deepEqual(said.addAllergens, ["peanuts"]);
  assert.equal(said.budget, 8);
  assert.equal(said.diet, undefined);
  assert.doesNotThrow(() => constraintsFor(null, null, null, null));
});
