# dtla-rent-tracker

Tracks asking rents at **825 South Hill** (the home building) plus four DTLA
comps, so there's a price history to put on the table at renewal time.

Successor to `ApartmentPriceTracking` (UDR / Westerly on Lincoln, built for a
friend). Same shape — cron → CSV → static dashboard — but no browser, multiple
buildings, and a chart you can actually zoom.

## Architecture

```
GitHub Actions cron (2x/day, PT-aligned)
        │
        ▼
plain fetch() + cheerio        scraper/track.js → scraper/adapters/*
        │
        ▼
docs/data/prices.csv           append-only, one row per available unit per scrape
        │  bot commits with [skip ci]
        ▼
GitHub Pages (docs/)
        │  dashboard fetches ./data/prices.csv  (relative — no raw.githubusercontent)
        ▼
ECharts dashboard: trend + dataZoom · $/sqft bar · sqft-vs-rent scatter · diff · table
```

## File layout

| Path | Purpose |
|---|---|
| `config/properties.json` | The building list. Adding a comp = adding an entry, not writing code (unless it's a new platform). |
| `scraper/track.js` | Loops the enabled properties, appends rows, prints a summary. `node scraper/track.js <id>` scrapes one. |
| `scraper/adapters/onni-craft.js` | 825 South Hill (Onni's in-house Craft CMS site). Reads `data-*` attrs off `.js-plan-row`. |
| `scraper/adapters/sightmap.js` | Any building embedding an Engrain SightMap — Atelier, Eighth & Grand, Beaudry, Circa LA. Reads the schema.org JSON-LD off `sightmap.com/embed/<id>`. |
| `scraper/lib/util.js` | fetch-with-retry, int/date coercion, CSV escaping. |
| `scraper/lib/floor.js` | Floor number derived from the unit label, guarded by the building's storey count. |
| `scraper/lib/concession.js` | Fetches each building's marketing banner (url + CSS selector from config) and parses "up to 2.5 months free" into months, scope, look-&-lease bonus, move-in deadline. |
| `docs/data/concessions.csv` | Change log of those banners — a row only when the text changes. |
| `docs/index.html` | Single-file dashboard. ECharts from CDN. |
| `docs/me.json` | **Gitignored.** Optional local-only copy of your lease. The published dashboard reads the lease from browser `localStorage` (edited via the 我的租约 form) so the repo can stay public without publishing your unit number and rent. |
| `docs/data/prices.csv` | Append-only history. |
| `.github/workflows/track.yml` | Cron 2x/day, commits the CSV back. |

## Key design decisions — don't undo by accident

- **No Playwright.** Every source is server-rendered or a JSON blob, so the
  whole run is `fetch()` + cheerio: ~6s for 185 units, no browser install in
  CI. Only reach for a browser if a site starts requiring JS.
- **Read attributes / JSON, never rendered text.** Same lesson as the UDR
  project: `data-rent-min` and JSON-LD survive copy changes; innerText doesn't.
- **CSV lives under `docs/`, not a top-level `data/`.** Pages serves `docs/` as
  the site root, so the dashboard fetches `./data/prices.csv` with a plain
  relative path. The old project had to hit `raw.githubusercontent.com` with a
  cache-bust because its CSV sat outside the published directory — that also
  breaks the moment the repo goes private. One canonical copy, no duplication.
- **Scrape everything, filter in the dashboard.** No bed/sqft filter in the
  scraper — future questions get answered without re-scraping.
- **`rent_min` is the comparable number.** 825 advertises a *lease-term range*
  (short terms cost more), so `rent_min` ≈ the longest-term price. SightMap
  buildings advertise one base rent, stored as `rent_min == rent_max`.
  `rent_all_in` (SightMap only) adds the recurring fees — insurance, utility
  admin, pest, pet — which run ~$17–35/mo on top.
- **Floor is derived and guarded.** `deriveFloor(unit, floors)` decodes
  `<floor><line>` labels, but only up to the building's storey count. Eighth &
  Grand is 7 storeys and numbers units `0-2077`, which would decode to a
  nonexistent floor 20 — so its config has no `floors` and the column stays
  empty. Don't "fix" that by guessing a number.
- **Color follows the building, not its rank.** `SERIES_ORDER` in the dashboard
  pins each property to a palette slot, so filtering never repaints the
  survivors. Palette is the validated 5-slot categorical set (passes CVD and
  lightness gates in both themes); the light theme's contrast warning is
  covered by the table view + direct end labels.
- **Lease details never enter git.** The repo is public so Pages is free; the
  dashboard's 我的租约 form writes to `localStorage`. Don't "simplify" this back
  into a committed JSON file.
- **A stale selector must not look like an ended offer.** `scrapeConcession`
  returns three states, not two: `active` (selector matched), `ended` (selector
  matched nothing AND the page mentions no offer anywhere), and `check`
  (selector matched nothing but the page still advertises free rent → the site
  moved its banner). Without the third state a redesign silently writes a fake
  "offer ended" row and the dashboard quietly under-reports the competition.
  `check` never fails the run — the price data collected that run is worth more
  than the banner — but it prints a loud CI error AND renders a red warning on
  the dashboard's concession card above the last known offer. The fallback scan
  strips `<script>` first: these sites ship i18n blobs containing
  `"special_offer"`, which would otherwise match forever.
- **Concessions are a change log, not a snapshot.** They move maybe monthly, so
  `concessions.csv` gets a row only when a building's banner text changes —
  which makes it directly readable as "Beaudry went to 2 months free on
  <date>". How often that actually happens is unmeasured — the Brookfield
  banners carry month-end move-in deadlines, which *suggests* a monthly
  campaign cycle, but this log is what will answer it. The dashboard resolves "offer in force at time T" as the newest
  row at or before T.
- **Concession numbers are advertised MAXIMA.** "Up to", "on select homes" —
  `raw_text` is always stored verbatim and the derived discount is labelled an
  upper bound in the UI. Where a scope names a floorplan category (825's offer
  is Skyhomes-only) it's matched against `plan_cat` so it doesn't leak onto
  other units; a vague "select homes" can't be resolved and is counted in,
  which is exactly why the metric is called an upper bound. Don't quietly
  promote these to "the discount".
- **Two scrapes a day is enough.** These are all Yardi/RentCafe-backed;
  pricing updates overnight. 2x/day ≈ 135k rows/year, still trivial to load.

## What the data is and isn't

Asking rents from public availability pages — **not** signed-lease rents, and
**not** net of concessions. Several comps were running "up to 2.5 months free"
during the first scrape; a $4,000 ask with 2 months free is an effective ~$3,333
on a 12-month term. Concessions aren't captured yet (see backlog) — read the
buildings' own pages before quoting a number in a negotiation.

## Common operations

```bash
npm run track                      # scrape all enabled buildings
node scraper/track.js atelier      # just one
DUMP=1 npm run track               # also save raw HTML to scraper/dumps/ (gitignored)

# Preview the dashboard locally (fetch() needs http://, not file://)
cd docs && python3 -m http.server 8731    # → http://127.0.0.1:8731
```

### Adding a building

1. Open its floorplans/availability page source and grep for
   `sightmap.com/embed/`. If it's there, add a config entry with that
   `sightmap_id` and `adapter: "sightmap"` — done, no code.
2. Otherwise check whether prices are server-rendered (`curl | grep '\$[0-9]'`).
   If yes, write a small adapter next to the existing two.
3. If the page needs JS or sits behind Cloudflare (Perla on Broadway returns a
   403 challenge; the securecafe application flow does too), it needs a
   browser — decide whether the comp is worth that dependency.

## Current state (as of 2026-08-22)

- ✅ 5 buildings, 185 units per scrape, ~6s, no browser
- ✅ Dashboard: zoomable trend, $/sqft comparison, scatter, diff table, unit table, dark mode
- ✅ Lease details live in browser localStorage, entered through the 我的租约
  form; the sqft filter then defaults to ±10% of that unit's size. **Never
  write the actual unit number, rent, or lease dates into a tracked file —
  this repo is public.** That includes docs, comments, and form placeholders.
- ✅ Concessions tracked (all five buildings had an offer up on 2026-08-23)
- ✅ Days on market per unit, derived from our own scrape history (one-scrape gaps tolerated; `≥` marks units already listed before tracking began)
- ✅ Live: https://github.com/EthanAlong/dtla-rent-tracker → https://ethanalong.github.io/dtla-rent-tracker/
- ✅ Public repo (Pages on a private repo needs Pro), which is why the lease
  lives in localStorage rather than in a committed file
- ✅ CI verified end to end: a `workflow_dispatch` run scraped, committed with
  `[skip ci]`, and Pages redeployed
- ⏳ Only a few scrapes of history so far — the trend chart and days-on-market
  numbers get interesting after a couple of weeks

## Backlog (rough priority)

1. **Lease-term matrix for 825.** The min–max range hides the actual 12-month
   price. It lives inside the securecafe application flow
   (`oleapplication.aspx?stepname=RentalOptions`), which 403s a plain fetch —
   would need a browser session. High negotiation value, medium cost.
2. **More comps.** Perla on Broadway (Cloudflare), Hope + Flower, Metropolis.
3. **Retention pruning** if the CSV crosses a few MB.
4. **Weekly digest email** in the 90 days before the lease ends (the user
   declined notifications for now — revisit near renewal).
