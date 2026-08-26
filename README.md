# Watch Back

**Two camera networks watch the roads around Steubenville, Ohio. One you can watch back. One only watches you.**

A static site that puts Ohio DOT's public traffic cameras and the region's automated
licence plate readers (ALPRs) on the same map, at the same scale, with the same controls —
so the difference between them is the only thing left to notice.

🟡 **Yellow** — ODOT cameras. Public, live, keyless, no plate reading. Click one and look through it.
🔴 **Red** — plate readers. Private vendors, records your plate, no public view through any of them.

That colour rule is the argument. Nothing on the site editorialises beyond it.

## Pages

| Page | What it does |
|---|---|
| [`index.html`](index.html) | The dual-layer map. Direction cones, per-camera transparency scorecards, and click-anywhere "who watches this spot?" |
| [`wall.html`](wall.html) | Every public camera view at once, auto-refreshing. The original single-camera page, generalised. |
| [`contribute.html`](contribute.html) | Finds incomplete ALPR records nearby, then **Look → Edit**: Street View aimed back at the pole, and that exact node open in the OSM editor. |

### Street View

Plate-reader panels link out to Google Street View via
[Maps URLs](https://developers.google.com/maps/documentation/urls/get-started), which needs
**no API key and has no quota** — unlike the embeddable Street View iframe, which is billable.
Two aims are offered: *the pole* (`direction + 180`, so the housing is in frame — this is how
you read a manufacturer or operator off it) and *what it sees* (`direction`). Google snaps to
the nearest panorama, so the aim is approximate where that pano lands off-road.

## How it stays free

No backend, no serverless functions, no runtime API key:

```
GitHub Action (nightly)            Browser
  OHGO API + key from Secrets        ├─ data/cameras.json  ← baked, keyless
  └─> commits data/cameras.json      ├─ Overpass API       ← live, CORS-open
                                     └─ ODOT JPEGs         ← keyless <img>
```

Camera *locations* need a key, so they're fetched in CI and committed. Camera *images*
are public and keyless, so the browser loads them directly. ALPR data comes live from
Overpass, which sends `Access-Control-Allow-Origin: *`, cached in `localStorage` for six
hours. GitHub Actions is free with unlimited minutes on public repositories.

## Running locally

ES modules need a real origin — `file://` won't work:

```bash
python -m http.server 8000
# or: npx serve .
```

Then open <http://localhost:8000>. Everything works with no API key; you'll just see the
single seed camera until you bake the catalog.

## Baking the full ODOT catalog

1. Register a free key at [publicapi.ohgo.com](https://publicapi.ohgo.com/) — ODOT data is public domain.
2. Add it as a repo secret named `OHGO_API_KEY`.
3. Run the **Update ODOT camera catalog** workflow from the Actions tab, or wait for the nightly run.

Locally: `OHGO_API_KEY=... node scripts/fetch-cameras.mjs`

Without a key the script exits cleanly and leaves the existing catalog alone, so the repo
stays green either way.

## Re-homing it on another town

Everything is centred by one constant. Edit `CENTER` in
[`src/js/config.js`](src/js/config.js) and the matching `OHGO_LAT` / `OHGO_LON` in
[the workflow](.github/workflows/update-cameras.yml). The ALPR layer needs no other
changes — it's a live Overpass query around whatever point you set.

## Relationship to DeFlock

[DeFlock](https://deflock.org) maintains the national ALPR map. This site reads the **same
OpenStreetMap data** rather than mirroring theirs, and deliberately does not compete with
it. What it adds is local: it surfaces which *nearby* records are incomplete and deep-links
into the iD editor to fix them. Those edits land in OSM, so DeFlock and every other
consumer picks them up automatically.

As of August 2026 the site's own query returns **329 ALPRs** mapped around Steubenville
(6,686 across Ohio). Core-tag completeness is **62%**, and the single biggest gap is
`operator` — **missing on 319 of 329**. That number is what the contribute page is pointed at.

`ref` is deliberately excluded from the completeness score: it's absent on literally every
node in the region, so counting it would flag 100% of records and bury the gaps that a
five-minute walk could actually close.

## Data & licensing

- ALPR nodes © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/).
- Camera imagery and metadata © Ohio Department of Transportation, public domain.
- Vendor reference facts in [`data/vendors.json`](data/vendors.json) are deliberately hedged:
  retention and sharing are set by the **operating agency's contract**, not the vendor.
  Sourced corrections welcome via issue.
