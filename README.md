# APEats — Find my lunch

APU Cloud Innovation Hackathon 2026 · Smart Campus & Student Experience

APEats helps a new student understand an unfamiliar campus menu and choose lunch within budget. Code validates prices
and constraints; Gemini helps explain dishes and select from eligible options.

*"It's my first time here, I have RM10 and I don't like spicy food — what should I eat, and what is it?"*
The journey: budget → up to three options → understandable explanations → calculated total → counter for each item.

APEats is an **independent student prototype** of a feature we propose for APSpace. It is not an official APU or
APSpace service and has no connection to APSpace.

**Live demo:** <https://apeats.onrender.com> (free hosting: the first visit after a pause can take up to a minute to load).

## Run it

Node.js 22 or later. From this folder:

```powershell
npm ci
Copy-Item .env.example .env   # first setup only
npm start
```

Open <http://localhost:8080>. With the example settings (`AI_PROVIDER=offline`) everything works without AI, using
rules-based menu matching. To use the Gemini API, set `AI_PROVIDER=gemini` and `GEMINI_API_KEY` in `.env`, then
restart the server.

```powershell
npm test            # 54 automated tests (no real AI calls)
npm run check       # syntax check + menu validation (writes nothing)
npm run doctor      # configuration status without showing secrets
```

## What the website does

| Tab | What it does |
|---|---|
| **Lunch** (first screen) | *Find my lunch*: budget, any spice / not spicy, main dish only / main dish + drink, "Use my saved preferences". Up to 3 options. Each shows the main dish and the drink with a one-line description, the counter, each price, the total and the money left. A set without a drink is labelled "Main dish only" with the reason. The results list the choices that produced them; when the form or the saved preferences change, they are marked out of date and **Update results** is offered. Each option says whether Gemini or the rules selected it, also after **Show another**. |
| **Menu** | All counters and items with search and filters. Dish details separate *from the menu board*, *confirmed by the team* and *estimate of the usual recipe*. |
| **Ask** | Chat in English or Russian. **Ask about it** carries the whole selected lunch (main dish, drink, budget, preferences); a "Discussing this lunch" card shows it. Questions such as "Which drink is included?" or "How much is left?" are answered from menu data by code; Gemini explains the dish. Restrictions the chat applies are listed and those made in chat can be removed. |
| **Me** | Diet (vegetarian / vegan-confirmed-only) and allergens to avoid, saved in this browser. Below: an optional anonymous cuisine poll (one vote per browser, not a verified rating). |

All listed outlets serve halal food: the team confirmed this in person; no certificates are claimed. Queues,
waiting-time predictions, delivery, ordering and payments are out of scope.

## How it stays correct

Plain code decides everything that must be right; AI chooses among checked options and explains them.

- **Money in whole sen.** Ranges and two board prices count at their highest value; estimated (`~`) or missing prices
  are never used under a budget. A set is offered only if dish + drink ≤ budget; otherwise the dish alone, labelled.
- **Full meals only.** Every item has a role (`main`, `side`, `drink`, `dessert`, `addon`, `unknown`). Only `main` can
  be the dish. See [docs/menu-roles.md](docs/menu-roles.md).
- **Every item of the set is checked**, the drink too: vegan needs explicit confirmation, unknown allergens exclude,
  unknown spice is not "not spicy", day-only specials, "after 15:00" items and unconfirmed availability are excluded.
- **The model's answer is verified.** Unknown IDs, changed pairs, duplicates or a wrong total discard the whole AI
  answer. AI wording that promises safety or states money is dropped. This reduces unsupported claims; it does not
  prove an explanation correct, so AI text is labelled and the facts beside it come from the menu data.
- **Results match the current choices.** The page knows which choices produced the results on screen
  (`public/shared/journey.js`). Outdated results cannot be swapped or asked about, and a late answer from an earlier
  search or swap never replaces newer results.
- **The selected lunch is rebuilt on the server.** Ask receives item IDs and choices, never prices. Names, prices,
  total and money left are recomputed from the menu (`lib/lunch-context.js`).
- **Text is interpreted carefully** (`lib/constraints.js`). "not vegan", "no allergies", "without chilli", "Is it
  vegan?" and "What is Vegetarian Fried Rice?" mean different things. Saved preferences are never removed by chat text;
  a newer form selection is never overridden by old messages; unclear text gets one clarifying question.

```text
Browser ──POST /api/lunch──► lib/lunch.js (rules, sets, money) ─► lib/lunch-ai.js ─► Gemini API
   ▲                                                              │
   └────── options, each labelled AI / rules ◄── re-check IDs, pairs, totals, text ◄┘  else rules-only answer
Browser ──POST /api/ask (IDs of the selected lunch)──► lib/lunch-context.js (facts, totals) + lib/recommend.js (dish text by AI)
Menu: data/source/*.json ─► npm run import (validate · roles · report · backup) ─► data/dishes.json
```

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Menu data and updates

The menu comes from the team's photos of the seven menu boards (compiled 6 Nov 2026), typed into
`data/source/menu_all_cuisines.json`. Descriptions, spice and allergens are AI-assisted estimates of the usual recipe
and are labelled as such. Update workflow (one source, validation, change report, hand overrides, backup, rollback):
[docs/DATA.md](docs/DATA.md).

```powershell
npm run menu:check      # validate + show what would change, write nothing
npm run import          # import (Gemini only for new items); npm run import:offline for no AI at all
npm run menu:rollback   # restore the previous menu if needed
```

Current counts are in `data/import-report.json` (560 items at 7 counters; the app reads them from the data).

## Status

| Working | Prepared, not live | Next |
|---|---|---|
| Find my lunch with the Gemini API and a rules fallback; outdated-results handling; per-option provenance; Ask about the selected lunch; text constraints (EN/RU); Menu; preferences; optional poll; menu import with report, backup and rollback; 54 tests | Gemini Enterprise adapter, agent instructions and menu export ([docs/enterprise/](docs/enterprise/)), tested with mocked responses only; Firestore poll storage (mocked tests only); Dockerfile and deployment notes | Live Gemini Enterprise agent; testing with students; vendor confirmation of allergens and vegan status |

Known limitations: allergens, spice and descriptions are estimates; no item is confirmed vegan; prices are a snapshot
of the boards; the app has not yet been tested with students; text interpretation is rule-based and covers common
English and Russian phrasings, not every sentence.

## Documents

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how it works, what code decides and what AI does, failure handling, tools, key files
- [docs/DEMO.md](docs/DEMO.md) — demo walkthrough and the test checklist
- [docs/DATA.md](docs/DATA.md) — data origin, limits, roles, update workflow
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — settings and hosting options
- [docs/enterprise/](docs/enterprise/) — Gemini Enterprise setup, agent instructions, menu export

AI coding assistance (Claude Code) was used for code, tests and documents. Secrets, local votes, backups and
credentials are excluded from Git and the container build.
