# APEats demo walkthrough and test checklist

*APEats helps a new student understand an unfamiliar campus menu and choose lunch within budget. Code validates prices
and constraints; Gemini helps explain dishes and select from eligible options.*

## Before you start

- `npm start`, then open the app in a phone-sized window (or a phone on the same network).
- The server line must say `Gemini: …`. `Local menu matching` means AI is off (the demo still works, with rules-based labels).
- In **Me**, set Diet to "No restriction", untick all allergens, Save. In **Ask**, press **New conversation**.
- For step 7, start a second, isolated instance with a deliberately wrong key. It uses its own port and its own vote
  file, so the real configuration and the real poll are untouched:

  ```powershell
  $env:PORT='8093'; $env:AI_PROVIDER='gemini'; $env:GEMINI_API_KEY='invalid-key-for-demo'; $env:GEMINI_FALLBACK_MODELS=''; $env:VOTES_FILE="$env:TEMP\apeats-demo-votes.json"; node server.js
  ```

- Nothing in the demo is scripted in code: every answer comes from the current menu data, so dish names can differ
  from run to run.
- Rate limits: 20 lunch searches and 12 chat questions per minute per client.

## Walkthrough (about 4 minutes)

| # | Do | Say / point at |
|---|---|---|
| 1 | **Lunch**: RM10 · **Not spicy** · **Main dish + drink** → **Find my lunch** | "I'm new at APU, I have RM10 and I don't eat spicy food. Seven counters, dishes I've never heard of." |
| 2 | Read option 1 aloud | Chips under "Lunch ideas" show the choices that produced the results. Main dish and drink, each with a one-line description, the counter, each price, the **Total** and "left of your RM10.00". "One counter" badge. The banner says who chose (Gemini from options the code had already checked). |
| 3 | Point at a drink such as **Ais Kosong** | "I don't have to open the chat to learn it is iced water": the line under the name. Tap the dish name: details in three labelled blocks (menu board / checked by the team / estimate of the usual recipe). |
| 4 | **Show another** on option 2 | New set, same budget and rules. The card is marked "Rules-based match" and the banner changes to "Options 1 and 3 were chosen by Gemini; option 2 is a rules-based menu match". |
| 5 | **Ask about it** on option 1, then type **Which drink was included, and how much is the whole set?**, then **How much is left?** | The "Discussing this lunch" card shows both items and the total. The answers name the drink and the total: items and sums are computed by code, and the label under the answer says so. Gemini only explains the dish. |
| 6 | **Me** → **Vegan** → Save → **Lunch** | "Saved. Your lunch results are now out of date." On Lunch the old results are dimmed, **Show another** and **Ask about it** are switched off, and **Update results** is offered. Press it: no confirmed vegan item exists in our data, and the app says so instead of relaxing the diet. Set Me back to "No restriction" afterwards. |
| 7 | Switch to the tab with the isolated instance (port 8093) and run step 1 there | Amber banner: "The AI helper is unavailable right now. These are rules-based menu matches…", every card marked "Rules-based match". Same budget and food rules, honest label. |

Optional, 20 seconds each: type **I am not vegan** or **chicken without chilli** in Ask and show the "Applied to
answers" chips (nothing wrong is inferred; chat-made restrictions can be removed with ×).

## Test checklist (automated: `npm test`, 54 tests)

| # | Scenario | Test |
|---|---|---|
| 1 | Dish + drink within budget, exact total in sen | `lunch.test.js` 1 |
| 2 | Dish and drink fit alone but not together → dish alone, labelled, with the reason | `lunch.test.js` 2 |
| 3 | Price range / two prices use the top price; estimated or missing prices excluded | `lunch.test.js` 3 |
| 4 | Side, add-on, dessert or unclear item never offered as the main dish | `lunch.test.js` 4 |
| 5 | Allergen in the drink excludes the drink; unknown allergens exclude | `lunch.test.js` 5 |
| 6 | Vegan needs `vegan: true`; vegetarian is not enough | `lunch.test.js` 6 |
| 7 | Not spicy excludes unknown and high spice, for dish and drink | `lunch.test.js` 7 |
| 8 | Day-only, "after 15:00" and unconfirmed items excluded | `lunch.test.js` 9 |
| 9 | Unknown ID, changed pair or wrong total from the model → AI answer rejected | `lunch.test.js` 10, 10b |
| 10 | AI failure → labelled rules answer | `lunch.test.js` 11 |
| 11 | Preferences changed after results are shown: results outdated, swap refused, update applies the new choices | `journey.test.js` "preferences changed after results" |
| 12 | Swapping after a budget or diet change keeps the new budget and diet | same test |
| 13 | A late answer from an earlier search or swap never overwrites newer results | `journey.test.js` two "late" tests |
| 14 | Ask keeps main dish, drink and selected day; totals from code; browser prices ignored | `journey.test.js` "Ask keeps the whole selected lunch" |
| 15 | Follow-up questions about the selected set (EN and RU) | same test |
| 16 | New form choices win over stale chat history | same test, `constraints.test.js` "precedence" |
| 17 | English and Russian negation; questions do not change constraints; unclear text asks one question | `constraints.test.js` |
| 18 | Provenance per option, correct after swaps | `journey.test.js` "provenance" |
| 19 | New conversation: no selected lunch, no chat constraints | `journey.test.js` last block |
| 20 | An answer without dishes is labelled by kind (explanation, info, clarify, unknown), not "nothing matches" | `journey.test.js` "empty list" |
| 21 | Item without a photo stays in the menu, search and lunch finder | `http.test.js`, `menu-data.test.js` |
| 22 | Menu update: price change reaches the finder; bad source refused; rollback | `menu-data.test.js` |
| 23 | Poll and preferences still work (temporary vote file, never the real one) | `http.test.js`, `votes.test.js` |

Manual browser checks (Chromium): steps 1–7 above with the live Gemini API and the wrong-key instance; out-of-order
responses forced by delaying the first request; "Main dish only" label at RM3.20; dish dialog → Ask → follow-up →
Stop discussing; Russian request with chips; no horizontal overflow at 320, 390 and 768 px; no console errors.
