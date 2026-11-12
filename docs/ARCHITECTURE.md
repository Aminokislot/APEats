# APEats — how it works

**APEats helps a new student understand an unfamiliar campus menu and choose lunch within budget. Code validates
prices and constraints; Gemini helps explain dishes and select from eligible options.**

Challenge area: Smart Campus & Student Experience.

## Problem and solution

**Problem.** New and international students at APU face a food court full of dishes they have never heard of — nasi
lemak, kuey teow, tosai, ais kosong — spread over seven counters with separate boards. With RM10 they have to work out
what each dish is, whether it is spicy, whether it is a full meal, and whether a dish and a drink together stay within
budget. (This is our hypothesis from being students; we have not measured it yet.)

**Solution.** A phone-first web prototype with one main action, **Find my lunch**: budget → up to three options →
understandable explanations → calculated total → counter for each item. The student picks a budget, "any spice" or "not
spicy", and "main dish only" or "main dish + drink"; saved diet and allergy preferences apply when the student leaves
them switched on. Each option shows the main dish and the drink with a one-line description, each price, the total, the
money left and one or two counters. The student can swap an option, or ask about the selected lunch in plain words.
Plain code checks every rule and does all arithmetic. Gemini picks among options the code has already checked and
explains unfamiliar food; when it fails, the student gets rules-based options with an honest label.

APEats is an independent student prototype of a feature proposed for APSpace. It is not an official APU or APSpace
service. All listed outlets serve halal food: the team confirmed this in person; no certificate is claimed.

Out of scope on purpose: queues, waiting-time predictions, delivery, ordering and payments.

## How it works

1. The menu is a file the team typed from photos of the seven menu boards. Every item has a price, a counter and a role
   (main dish, side, drink, dessert, add-on).
2. When the student presses **Find my lunch**, ordinary program code builds every allowed combination: a main dish,
   optionally with a drink, whose prices add up to no more than the budget and whose items pass the diet, allergen, spice
   and day checks.
3. Only that checked list is shown to Gemini. Gemini chooses up to three and writes one or two sentences about each.
4. The code checks Gemini's answer again (same IDs, same pairs, same totals, no risky wording). If anything is off, the
   answer is thrown away and the student sees options chosen by the rules, with a label that says so.
5. In **Ask**, the selected lunch travels as IDs only. The server looks the items up again and computes the total and
   the money left itself; Gemini is asked only what the dish is.

```text
 Browser (public/)                              Node.js server (server.js)
 ┌────────────────────────────────┐  POST      ┌─────────────────────────────────────────────────────────┐
 │ Find my lunch form             │ /api/lunch │ lib/lunch.js — plain code decides what is allowed        │
 │ results + "made for" chips     │ ─────────► │   role, day, time, known price, diet, allergens, spice   │
 │ outdated / swap / provenance   │            │   money in whole sen, top price of a range, sets ≤ budget│
 │ (shared/journey.js)            │ ◄───────── │ lib/lunch-ai.js — ≤ 40 checked sets → model picks ≤ 3    │
 │                                │            │   re-checks IDs, pairs, totals, wording; else rules      │
 │ Ask: "Discussing this lunch"   │ POST       │ lib/lunch-context.js — selected lunch rebuilt from IDs   │
 │ card + "Applied to answers"    │ /api/ask   │ lib/constraints.js — what the student's text means       │
 │ chips                          │ ─────────► │ lib/recommend.js — set facts by code, dish text by AI    │
 └────────────────────────────────┘            │      │ AI_PROVIDER=gemini      │ AI_PROVIDER=enterprise  │
                                               │      ▼                         ▼                         │
                                               │  Gemini API (working)     Gemini Enterprise agent        │
                                               │                           (adapter, mocked tests only)   │
                                               └─────────────────────────────────────────────────────────┘
 Menu update (by the team, offline):
 data/source/*.json ─► tools/import-menu.js ─► data/dishes.json + import-report.json + backups/
```

## What code decides and what AI does

| Plain code (deterministic, tested) | AI (Gemini) |
|---|---|
| Which items exist, their prices and counters | Picks up to three sets from the checked list, with variety |
| Budget: sum in whole sen, highest price of a range, no estimated or missing prices | Writes one or two sentences on why a set suits the request |
| Only `main` items count as the dish; sides, add-ons and plain rice never do | Explains one dish for a newcomer (usual recipe, labelled as not checked with the stall) |
| Diet (vegan needs explicit confirmation), allergens (unknown = excluded), spice (unknown ≠ mild) | Answers free-text questions in English or Russian |
| Day-only specials, "after 15:00" items, unconfirmed availability | — |
| Items, total and money left of the selected lunch in Ask | — |
| What the student's text means for budget, diet, allergens and spice (negation, questions, precedence) | — |
| Whether results on screen still match the current choices; which request is the newest | — |
| Whether AI text is shown at all | — |

## Questions and answers

**How is the budget validated?**
Every price is converted to whole sen (RM9.90 → 990), so 7.90 + 2.10 is exactly 1000. For a price range or two board
prices we count the highest. Items with an estimated (`~`) or missing price are never used under a budget. A set is
built only if main + drink ≤ budget; if no drink fits, the card says "Main dish only, no drink" and gives the reason
("the cheapest suitable drink costs RM0.50, but only RM0.20 is left"). The model never computes money: it must repeat
the total of the set it picked, and a different number discards its whole answer. In Ask, the browser sends item IDs,
not prices; the server recomputes the total. Tests cover each of these.

**Where does the data come from, and how reliable is it?**
Three levels, shown separately in the dish details:
*from the menu board* (name, price, counter, days: typed by the team from photos compiled on 6 November 2026);
*confirmed by the team* (every listed outlet serves halal food: confirmed in person, no certificate claimed);
*estimates* (descriptions, spice level and likely allergens: produced with Gemini at import time from the dish name and
the usual recipe, not checked with the stalls). Prices can change; the app says to check at the counter. No item is
confirmed vegan, so a vegan search honestly returns nothing. An allergen exclusion is a filter on estimates, not a
guarantee: unknown allergens exclude the item, and the AI is never allowed to say "allergen-free" or "safe".

**Why AI, and what exactly does it do?**
The hard part for a newcomer is not arithmetic but understanding unfamiliar food and asking in their own words. Gemini
does two things: it chooses a varied trio from options the code has already checked, and it explains dishes in plain
words. It never decides what is allowed, never states a price that we show, and its choice is verified again. Each
option card says whether Gemini or the rules selected it, also after "Show another".

**What happens when something fails?**

| Situation | What the server or page does | What the student sees |
|---|---|---|
| Model returns an unknown ID, a changed dish–drink pair, a duplicate or a wrong total | Discards the whole AI answer, uses the rules answer | Amber note "The AI answer did not pass our checks…" and rules-based options |
| Model text promises safety or quotes money | That text is dropped; menu notes are used | "Menu notes:" instead of "Why this (written by AI):" |
| Model times out, is rate-limited, or the key is wrong | Tries the next Gemini model, then falls back | Amber note "The AI helper is unavailable right now…", every card "Rules-based match" |
| `AI_PROVIDER=offline` | Rules only | "Rules-based menu matches… AI is switched off" |
| Nothing fits | No AI call | The reason, and a "Try RMx" button when a higher budget would help; diet and allergies are never relaxed |
| Preferences, budget, spice, drink or day changed after results appeared | Results are compared with the current choices | Results dimmed, "These results are out of date", swap and Ask switched off, **Update results** |
| An older request answers after a newer one | The late answer is ignored | Only the newest results |
| The student's text is unclear ("chilli", "I have an allergy") | Nothing is inferred | One short question |
| A question refers to "this" or "the set" with nothing selected | No guess | "No lunch or dish is selected right now…" |

The wording check is a list of risky phrases and money patterns. It reduces unsupported claims in AI text; it cannot
prove that an explanation is correct, which is why AI text is labelled and the facts next to it come from the menu data.

**More questions**

- *Is the halal information verified?* The team confirmed in person that every listed outlet serves halal food. We
  show exactly that and claim no certificates.
- *Can a student with a peanut allergy trust it?* It is a filter on estimates, not a guarantee; the app says to confirm
  at the counter. Vendor confirmation is a next step.
- *Why no queue times?* Out of scope on purpose: we show nothing we cannot measure.
- *Is this part of APSpace?* No. It is an independent prototype of a proposed feature, with no connection to APSpace.
- *Is the cuisine poll a real rating?* No: one anonymous vote per browser. It is optional and does not affect lunch options.
- *Where is Gemini Enterprise?* The prototype uses the Gemini API and labels it "Gemini". Gemini Enterprise is the next
  integration step; see the plan below.

## Status

| Working | Prepared (code or documents exist; not live) | Next |
|---|---|---|
| Find my lunch with the Gemini API and rules fallback | Gemini Enterprise adapter for lunch sets and chat (`lib/enterprise.js`), tested with mocked responses only | A live Gemini Enterprise agent with the menu as its source |
| Budget in sen, roles, diet, allergens, spice, day and time rules | Agent instructions and menu export (`docs/enterprise/`) | Testing with students |
| Item descriptions on every option; "Main dish only" label with the reason | Firestore storage for the poll (`lib/firestore-votes.js`), tested with mocked responses only | Vendor confirmation of allergens, vegan status and disputed roles |
| Outdated-results detection; newest request wins | Dockerfile and deployment notes ([DEPLOYMENT.md](DEPLOYMENT.md)) | Menu kept in a shared sheet with an export job |
| Provenance per option, also after "Show another" | | Any APSpace integration (needs APU approval) |
| Ask about the selected lunch (main, drink, day, total by code); EN/RU | | |
| Text constraints with negation and precedence; "Applied to answers" chips | | |
| Menu with search and filters; items without photos shown | | |
| Saved preferences; optional anonymous poll | | |
| Menu import: validation, change report, overrides, backup, rollback | | |
| 54 automated tests; browser check at 320, 390 and 768 px | | |

## Gemini Enterprise plan

An adapter and an environment variable are not an integration. We will call Gemini Enterprise integrated only after a
real agent has answered inside the running product.

**A useful role, not a renamed model call.** In Gemini Enterprise the agent has the team's menu document connected as
its data source. That gives the product two things the plain API does not:

1. *Grounded dish explanations.* The agent explains a dish from the connected, citable menu source that the team
   maintains, instead of from a prompt we paste in. The website keeps doing every check and all arithmetic.
2. *One source for the team.* Team members can ask the agent about the menu inside Gemini Enterprise itself (prices,
   which items lack a confirmed allergen list) while preparing a menu update.

**Verification, in order** (details in [enterprise/SETUP.md](enterprise/SETUP.md)):

1. A team account opens the Gemini Enterprise app.
2. The agent is created with `docs/enterprise/agent-instructions.md`; the menu source is connected and indexed.
3. Inside Enterprise, the agent answers a question about a known item with a citation of our source.
4. In APEats with `AI_PROVIDER=enterprise`: `POST /api/lunch` returns `source: enterprise`, the banner says "Gemini
   Enterprise agent", and one Ask answer returns `source: enterprise`.
5. Negative checks: a wrong total from the agent is rejected; with the agent unreachable the app shows the labelled
   rules fallback.

Open technical risks: the agent may not return strict JSON reliably (the adapter then falls back, which is honest but
is not an integration), and its response time is unknown.

## Tools

| Tool | Used for | Where |
|---|---|---|
| Node.js 22+, plain HTML/CSS/JavaScript, no framework | Server and website | `package.json`, `server.js`, `public/` |
| Gemini API, `gemini-3.5-flash` first with configured fallbacks | Live lunch picks and chat explanations; import-time dish descriptions, spice and allergen estimates | `lib/gemini.js`, `lib/lunch-ai.js`, `lib/recommend.js`, `data/enrichment.json` |
| `google-auth-library` | Google credentials for the Enterprise and Firestore adapters | `lib/enterprise.js`, `lib/firestore-votes.js` |
| Wikipedia / Wikimedia Commons API | Illustrative photos with author and licence | `tools/fetch-photos.js`, `data/photos.json` |
| Node test runner (`node --test`) | 54 automated tests | `tests/` |
| Claude Code (Anthropic), an AI coding assistant | Code, tests and documentation, written under the team's direction | whole repository |

## Key files

| File | Role |
|---|---|
| `public/index.html`, `public/app.js`, `public/app.css` | Page: Lunch (first), Menu, Ask, Me |
| `public/shared/filters.js` | Rules shared by browser and server: money in sen, highest price, diet, allergens, spice |
| `public/shared/journey.js` | Lunch journey state: which choices produced the results, newest request wins, provenance |
| `server.js` | HTTP API: `/api/lunch`, `/api/ask`, `/api/menu`, `/api/status`, `/api/poll` |
| `lib/lunch.js` | What may be offered, sets under budget, explanations, empty-result hints |
| `lib/lunch-ai.js` | Sends checked sets to the model and verifies the answer |
| `lib/lunch-context.js` | The selected lunch in Ask: rebuilt from IDs, facts and totals by code |
| `lib/constraints.js` | Meaning of the student's text: negation, questions, precedence (EN/RU) |
| `lib/recommend.js` | Ask: selected lunch, one dish, dish names, recommendations; answer kind and source |
| `lib/prose.js` | Drops AI wording that promises safety or states money |
| `lib/roles.js`, `data/menu-overrides.json` | Item roles: section rules and hand decisions with reasons |
| `lib/menu-data.js`, `tools/import-menu.js`, `tools/menu-rollback.js` | Menu validation, import, report, backup, rollback |
| `lib/gemini.js` / `lib/enterprise.js` | Gemini API client with model fallback / Gemini Enterprise client (mock-tested) |
| `lib/votes.js`, `lib/firestore-votes.js` | Optional anonymous poll (local file / Firestore) |
| `tests/` | `lunch`, `journey`, `constraints`, `menu-data`, `http`, `recommend`, `votes` |
