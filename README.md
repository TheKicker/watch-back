# Watch Back

**Two camera networks watch the same roads. One you can watch back. One only watches you.**

A static site that puts public traffic cameras and automated licence plate readers (ALPRs)
on the same map, at the same scale, with the same controls — so the difference between them
is the only thing left to notice.

Plate-reader coverage is **nationwide**, because it comes from OpenStreetMap. Public-camera
coverage is per-agency and currently Ohio; see [Adding a state](#adding-a-state).

🟡 **Yellow** — public traffic cameras. Live, keyless, no plate reading. Click one and look through it.
🔴 **Red** — plate readers. Private vendors, records your plate, no public view through any of them.

That colour rule is the argument. Nothing on the site editorialises beyond it.

## Pages

| Page | What it does |
|---|---|
| [`index.html`](index.html) | The dual-layer map. Direction cones, per-camera transparency scorecards, and click-anywhere "who watches this spot?" |
| [`wall.html`](wall.html) | Every public camera view at once, auto-refreshing, nearest first. Only tiles actually on screen re-fetch. |
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
GitHub Actions (nightly)              Browser
  OHGO API + key from Secrets           ├─ data/cameras.json      ← baked, keyless
  └─> commits data/cameras.json         ├─ data/alpr-summary.json ← baked, national view
  Overpass count-per-state              ├─ Overpass API           ← live, by viewport
  └─> commits data/alpr-summary.json    └─ camera JPEGs           ← keyless <img>
```

Camera *locations* need a key, so they're fetched in CI and committed. Camera *images*
are public and keyless, so the browser loads them directly. ALPR data comes live from
Overpass, which sends `Access-Control-Allow-Origin: *`, cached in `localStorage` for six
hours. GitHub Actions is free with unlimited minutes on public repositories.

### Two loading regimes

Ohio alone has ~6,700 ALPR nodes in OSM and California has ~20,000, so "just query the
country" is not an option — it would be slow for the visitor and abusive to a service run
on donations. So:

- **Below zoom 9** the map draws pre-baked per-state counts from `data/alpr-summary.json`
  (a few KB) and says *zoom in to load individual readers*.
- **At zoom 9 and above** every settled map move queries that viewport, snapped outward
  onto a 0.25° grid so panning reuses cache entries instead of minting new ones.

The same reasoning bounds the camera wall. Its ceiling is bandwidth, not catalogue size:
each tile is a JPEG on a 5-second timer, so an `IntersectionObserver` limits refreshing to
tiles actually on screen. That is why the wall needs no radius setting — the list can be as
long as it likes, sorted nearest-first, and you scroll.

## Where the map looks, and what that costs you

There is no account, no backend, and nothing that could collect a location even in
principle. Every way a place gets chosen is local by construction:

| Source | Where it comes from |
|---|---|
| default | The whole country. We don't know where you are and don't ask. |
| URL | `#zoom/lat/lon`. Shareable, bookmarkable, back-button-able. |
| geolocation | The browser's own permission prompt — **only ever on a click**, never on load. |
| search | Nominatim, on explicit submit only. |
| saved view | `localStorage`. Never transmitted, never leaves the device. |

Coordinates from GPS are rounded to ~110 m before they reach the address bar, so sharing a
link after locating yourself doesn't publish your house. The saved view is deliberately not
called "home" — for a tool about surveillance, prompting people to pin their residence is
the wrong nudge.

The honest other half: drawing a map means your **browser** talks directly to
OpenStreetMap, CARTO and the state DOTs, and those services see your IP address the same as
any site you visit. We can't see it, and we also can't stop them seeing it. Saying only the
flattering half of that would undercut the entire point of the site.

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

## Adding a state

Plate readers need no work — OSM already covers the country, and the nightly summary job
counts every state whether or not anyone has wired up its cameras.

Public cameras are the per-agency half. There is no single national feed: each state runs
its own 511 system with its own auth and schema, and **shard geography and data source are
different axes** — a state's cameras may come from its DOT *plus* a turnpike commission
*plus* a city. `scripts/fetch-cameras.mjs` is the Ohio adapter; a new one normalises its
agency's response into the same `{ id, agency, latitude, longitude, location, views[] }`
shape and commits it from CI.

Still open: sharding `data/cameras.json` into per-state files with a bbox manifest, so the
browser loads only the shards intersecting the viewport. That matters most at state lines —
Steubenville sits on the Ohio/WV/PA tri-point, and a single-state shard puts a hard data
edge down the middle of its own map.

## Relationship to DeFlock

[DeFlock](https://deflock.org) maintains the national ALPR map. This site reads the **same
OpenStreetMap data** rather than mirroring theirs, and deliberately does not compete with
it. What it adds is local: it surfaces which *nearby* records are incomplete and deep-links
into the iD editor to fix them. Those edits land in OSM, so DeFlock and every other
consumer picks them up automatically.

As of August 2026 the site's own query returns **329 ALPRs** mapped around Steubenville,
**6,687** across Ohio, and over 100,000 nationwide. Core-tag completeness locally is **62%**,
and the single biggest gap is `operator` — **missing on 319 of 329**. That number is what the
contribute page is pointed at, wherever you point the contribute page.

`ref` is deliberately excluded from the completeness score: it's absent on literally every
node in the region, so counting it would flag 100% of records and bury the gaps that a
five-minute walk could actually close.

## Data & licensing

- ALPR nodes © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/).
- Camera imagery and metadata © the operating agency (currently Ohio DOT), public domain.
- Geocoding by [Nominatim](https://nominatim.openstreetmap.org/) © OpenStreetMap contributors.
- Vendor reference facts in [`data/vendors.json`](data/vendors.json) are deliberately hedged:
  retention and sharing are set by the **operating agency's contract**, not the vendor.
  Sourced corrections welcome via issue.
