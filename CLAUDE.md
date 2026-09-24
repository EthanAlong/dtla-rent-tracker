# dtla-rent-tracker

Tracks asking rents at **825 South Hill** (the home building) plus six DTLA
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
| `scraper/track.js` | Loops the enabled properties, appends rows, prints a summary. `node scraper/track.js <id>` scrapes one. `DRY=1` scrapes without writing. |
| `scraper/probe.js` | `node scraper/probe.js <url>` — tells you whether a candidate building can be tracked (SightMap id / Onni Craft / server-rendered / needs a browser) and prints concession banner text with a CSS selector. Read-only. |
| `.github/workflows/probe.yml` | Runs the probe + a `DRY=1` scrape on every push that touches `scraper/` or the building list, and on demand. Use it when your own network can't reach the leasing sites. |
| `scraper/adapters/onni-craft.js` | Onni's in-house Craft CMS sites — 825 South Hill, Hope + Flower. Reads `data-*` attrs off `.js-plan-row`. |
| `scraper/adapters/sightmap.js` | Any building embedding an Engrain SightMap — Atelier, Eighth & Grand, Beaudry, Circa LA, THEA at Metropolis. Reads the schema.org JSON-LD off `sightmap.com/embed/<id>`. |
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
  survivors. The first 5 slots are the validated categorical set (passes CVD
  and lightness gates in both themes); slots 6–10 exist so newly added
  buildings get a colour of their own, and any id not in `SERIES_ORDER` is
  appended to it at load time in first-seen order. Pin a new building
  explicitly if you care which colour it gets.
- **Two languages, one dictionary.** Every visible string in `docs/index.html`
  lives in the `I18N` table (`zh` + `en`). Static markup uses
  `data-i18n="key"` (innerHTML) / `data-i18n-ph` (placeholder); dynamic text
  calls `t(key, vars)`. Add a key to **both** languages or the English side
  silently falls back to Chinese. The choice is remembered in localStorage;
  Chinese is the default.
- **Concessions are folded in via one switch, not a separate metric.** The
  filter bar's 折算进价格 toggle (`state.fold`) makes `rentOf(r)` return the
  amortised effective rent instead of `rent_min`, and every chart, tile and
  $/sqft goes through `rentOf`. Off, the unit table still shows the offer tag
  and the effective figure next to the asking rent — that's the "show the
  promotion inside the price" ask. The diff table always compares asking
  rents, so a banner change doesn't spray a fake repricing across a building.
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

Asking rents from public availability pages — **not** signed-lease rents. The
raw numbers are **not** net of concessions; the dashboard can fold the
advertised concession in (a $4,000 ask with 2 months free on a 12-month term ≈
$3,333/mo, and a look & lease credit is spread over the same term), but what
it folds in is the banner's *maximum* — read the buildings' own pages before
quoting a number in a negotiation.

## Common operations

```bash
npm run track                      # scrape all enabled buildings
node scraper/track.js atelier      # just one
DUMP=1 npm run track               # also save raw HTML to scraper/dumps/ (gitignored)

# Preview the dashboard locally (fetch() needs http://, not file://)
cd docs && python3 -m http.server 8731    # → http://127.0.0.1:8731
```

### Adding a building

1. `node scraper/probe.js https://its-site.com` (or push a change under
   `scraper/` / the config and read the probe workflow's log). It reports a
   `sightmap.com/embed/<id>` if there is one, whether it's an Onni Craft site,
   how many prices are server-rendered, and any concession banner text with a
   CSS selector for `config.concession`.
2. SightMap id → add a config entry with that `sightmap_id` and
   `adapter: "sightmap"` — done, no code. Onni site → `adapter: "onni-craft"`
   with `url: <site>/availability`.
3. Otherwise, if prices are server-rendered, write a small adapter next to the
   existing two.
4. If the page needs JS or sits behind Cloudflare (Perla on Broadway returns a
   403 challenge; the securecafe application flow does too), it needs a
   browser — decide whether the comp is worth that dependency.
5. `DRY=1 node scraper/track.js <id>` to see the rows before the cron writes
   them. The dashboard picks a new building up automatically (colour slot,
   chips, lease form); pin it in `SERIES_ORDER` if you want a specific colour.

## Current state (as of 2026-09-24)

- ✅ 7 buildings (~290 units per scrape), no browser. Hope + Flower and THEA
  were added 2026-09-24 after the probe workflow confirmed their feeds; THEA's
  `floors` is deliberately unset until a real scrape shows its label scheme.
- ✅ Dashboard: zoomable trend, $/sqft comparison, scatter, diff table, unit table, dark mode
- ✅ Lease details live in browser localStorage, entered through the 我的租约
  form; the sqft filter then defaults to ±10% of that unit's size. **Never
  write the actual unit number, rent, or lease dates into a tracked file —
  this repo is public.** That includes docs, comments, and form placeholders.
- ✅ Concessions tracked (all five buildings had an offer up on 2026-08-23),
  shown per unit (offer tag + effective rent) and foldable into every chart
- ✅ Dashboard in 中文 / English (header toggle, remembered per browser)
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
2. **More comps.** Probe run of 2026-09-24 (workflow run 36038856169) sorted
   the candidates:
   - *Server-rendered, needs a small adapter* — **The Emerson** (225 S Grand,
     ~26 prices on theemersonla.com, banner selector
     `.property-flash-message__text h5`), **Olympic by Windsor** (936 S Olive,
     36 prices on `/properties/olympic-by-windsor/floorplans/`), **Metropolis**
     (10 prices on `/availability`, behind Cloudflare but served to a plain
     fetch). The probe now prints the DOM outline of the price elements — run
     it and write the adapter from that.
   - *JS-only or 403 to a plain fetch* — Apex/Alina (liveatapexalina.com),
     Verdosa, Park Fifth, Onyx, Level, Grace/Griffin on Spring, Wren, E on
     Grand, AVEN. Need a browser; probably not worth it.
   - *Dead domains* — broadwaypalace.com and perlaonbroadway.com are parked.
3. **Retention pruning** if the CSV crosses a few MB.
4. **Weekly digest email** in the 90 days before the lease ends (the user
   declined notifications for now — revisit near renewal).
