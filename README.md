# DTLA Rent Tracker

Asking-rent history for **825 South Hill** and four downtown LA comps —
Atelier, Eighth & Grand, Beaudry, Circa LA — scraped twice a day so there's
data on the table at renewal time.

**Dashboard**: enable GitHub Pages on `docs/` and it lives at
`https://<user>.github.io/<repo>/`

## Setup

```bash
npm install
npm run track          # one scrape of all five buildings (~6s)
cd docs && python3 -m http.server 8731   # preview at http://127.0.0.1:8731
```

Then open the dashboard and fill in the **我的租约** form — unit, sqft, current
rent, lease end date. It's stored in your browser only (never committed), and
drives the reference line on the trend chart, the gap-to-median tile, the pin on
the scatter, and the renewal countdown.

To put it on autopilot: push to GitHub, then Settings → Pages → source
`main` / `/docs`. The workflow in `.github/workflows/track.yml` runs at
07:20 and 16:20 PT and commits each scrape back to the repo.

See `CLAUDE.md` for architecture, data caveats, and how to add a building.
