# Menu data: where it comes from and how it is updated

## Where the data comes from

| What | Source | Trust level shown in the app |
|---|---|---|
| Dish names, prices, menu sections, day-only specials, "available after 15:00", "comes with fries/salad" | Photos of the campus menu boards taken by the team, typed into `data/source/menu_all_cuisines.json` (compiled 6 Nov 2026; descriptions there are in Russian) | "From the menu board" |
| Halal status of all listed outlets | Checked in person by the team (`data/campus.json` → `halalNote`). No certificates or certificate numbers are claimed. | "Checked by the APEats team" |
| Bottled water and canned drinks at two counters | Added by the team (`data/extra-items.json`). Water price checked by the team; can prices are a team estimate (about RM2–3) and are marked `~` | "Added by the APEats team" |
| One-line explanation, spice 0–5, likely allergens, `~` price where the board shows none | Generated at import time with the Gemini API from the dish name, section and description (`data/enrichment.json`, cached) | "Estimate of the usual recipe (AI-assisted, not checked with the stall)" |
| Vegetarian flag | Set when the source was typed: from the dish name, a vegetarian label on the board, or a clearly plant/egg-based dish; meat or fish named → not vegetarian; unclear → unknown | Shown as "by its name"; never treated as vegan |
| Role (main dish, side, drink…) and base (rice, noodles…) | Rules on the menu section (`lib/roles.js`) plus hand decisions (`data/menu-overrides.json`) | "Type", with the reason |
| Photos | Wikipedia / Wikimedia Commons, free licences, author and licence on every dish (`data/photos.json`, `tools/fetch-photos.js`) | "Illustrative photo of this kind of dish, not from this stall" |

Not in the data (the app says so instead of guessing): portion size, calories, protein, exact sauce recipes,
cross-contact, live stock ("sold out"), queues and waiting times. Vegan status is not confirmed for any item.

## Limits to say out loud

- Prices are what the boards showed when photographed; they can change. Ranges and "two prices" count at their highest value.
- Allergens are a "likely contains" estimate. "None in our estimate" is not "allergen-free". Unknown allergens exclude an item whenever the student avoids any allergen.
- Mixed rice prices on the Chinese counter screen are student/staff prices with APCard; other prices were not shown. The app shows this condition next to the price.
- 15 items on the boards could not be read (`unresolved_items` in the source) and are not in the app.
- Items without an illustration (80 at the time of writing) are shown with a placeholder and can be found and suggested like any other.

## Roles: what counts as a lunch

The lunch finder only offers items with role `main` as the dish and `drink` as the drink. Everything else stays in the menu
and search. Rules (`lib/roles.js`):

- drinks section → `drink`; plated rice, noodle, bread, pasta, bento, burger and sandwich sections → `main`;
- snacks, appetisers, sides, single pieces, oden, roti/naan/chapati/tosai, toast → `side`;
- add-ons and toppings → `addon`; desserts → `dessert`;
- sections that mix meals and single dishes (economy-rice counter, "prepared dish", Korean section, soups) → `unknown`
  until a person decides item by item in `data/menu-overrides.json`, with a reason.

Unclear items stay `unknown` rather than being promoted to `main` to produce more results. The current list of disputed and
hand-decided items, with reasons, is generated into [menu-roles.md](menu-roles.md) by every import.

## The one source and the update workflow

The single source of menu facts is `data/source/*.json` (plus the team additions in `data/extra-items.json` and the hand
decisions in `data/menu-overrides.json`). `data/dishes.json` and `data/stalls.json` are generated — never edit them by hand.

```powershell
# 1. Edit the source file (new price, new item, removed item). Keep the existing item IDs.
# 2. Dry run: validate and see what would change, without writing anything
npm run menu:check
# 3. Import. Uses Gemini only for new or renamed items; use import:offline to skip AI entirely
npm run import            # or: npm run import:offline
# 4. Read the change report
Get-Content data\import-report.json
# 5. Restart the server (it validates the menu again at start)
npm start
# If anything looks wrong: restore the previous menu and restart
npm run menu:rollback
```

What the import does, in order:

1. **Validates the source**: JSON format, cuisine names, required `id` and `name`, unique IDs per cuisine, positive prices,
   `min <= max` for ranges, weekday names, `HH:MM` times, `available` true/false/null. Any problem stops the import and
   **nothing is written**.
2. Builds items, applies section roles, then the hand decisions from `data/menu-overrides.json` (an override for an ID that no
   longer exists becomes a warning in the report).
3. Reuses cached translations and AI estimates. A **price change keeps the description, spice and allergens** (the cache key
   describes the dish, not its price). New items get AI estimates when AI is enabled; with `--no-ai` their spice and
   allergens stay **unknown**, which keeps them out of "not spicy" and allergy-filtered results.
4. Validates the generated menu again (roles, IDs, prices, days, allergens).
5. Copies the current `dishes.json`, `stalls.json` and `import-report.json` to `data/backups/<time>/` (the last 10 are kept),
   then writes the new files atomically.
6. Writes `data/import-report.json`: import time, source date, source file hashes, counts by role, **added / changed /
   removed items with the changed fields** (for prices: old → new), disputed items and warnings. It also refreshes
   [menu-roles.md](menu-roles.md).

The server shows the source date and the last import date in About, and refuses to start on invalid menu data with a
message pointing to `npm run menu:rollback`. The rollback validates the backup first and keeps a copy of what it replaces.

All of this is covered by `tests/menu-data.test.js`, which changes a price in a copy of the source, imports, checks the
report and the lunch finder, feeds a broken source (refused, nothing written) and rolls back.

## Cloud source: next step, not connected

Not done and not claimed: syncing from Google Sheets or Drive, a Firestore copy of the menu, or any API that edits the menu.
A safe next step would be: the team keeps the source as a Google Sheet; a scheduled job exports it to the same JSON shape,
runs `npm run menu:check`, and only an authorised person runs the import. There is deliberately no public endpoint that
changes the menu.
