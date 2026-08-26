/**
 * Shared constants.
 *
 * There is deliberately no hardcoded home town here any more. Where the map
 * looks is runtime state owned by locale.js — the URL, an opt-in geolocation,
 * or a view the visitor saved themselves. See that file for why.
 */

/** Cold-start view: the whole country, because we don't know where you are. */
export const US_VIEW = { lat: 39.5, lon: -98.35, zoom: 4, name: "United States" };

/** Zoom limits. minZoom must stay low enough to frame the lower 48. */
export const VIEW = { minZoom: 3, maxZoom: 18 };

/**
 * Below this zoom we show pre-baked per-state counts instead of querying live.
 *
 * The threshold is set by response size, not by taste. Ohio alone holds ~6,700
 * ALPR nodes in OSM, so a viewport spanning several states would pull tens of
 * thousands — megabytes of JSON, slow for the visitor and rude to a service run
 * on donations. At z9 the view is roughly one metro, which is a fair question
 * to ask. Below that, the baked per-state counts answer it for free.
 */
export const LIVE_DATA_MIN_ZOOM = 9;

/** Radius used by the contribute page's to-do list, in meters. */
export const ALPR_RADIUS_M = 40000;

/** Basemap: CARTO dark-matter is keyless and CORS-open. */
export const BASEMAP = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

/** Overpass mirrors, tried in order. Both send Access-Control-Allow-Origin: *. */
export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

/** Keyless, CORS-open geocoder. Their policy asks for <=1 req/s, so we only
    ever fire on an explicit submit — never per keystroke. */
export const NOMINATIM_URL = "https://nominatim.openstreetmap.org";

/** ODOT publishes a fresh JPEG roughly every 5s. */
export const CAMERA_REFRESH_MS = 5000;

/** Overpass results are cached this long. ALPR nodes change on the order of days. */
export const ALPR_CACHE_MS = 6 * 60 * 60 * 1000;

/**
 * Cache cells, in degrees.
 *
 * Viewport queries are snapped outward to this grid before being sent or
 * cached. Without the snap, every few pixels of panning would mint a fresh
 * localStorage entry and blow the quota within a minute of normal use.
 */
export const CACHE_GRID_DEG = 0.25;

/**
 * Refuse to query a snapped box bigger than this. Sized so a wide monitor at
 * LIVE_DATA_MIN_ZOOM still passes (~14 deg²) with room for the grid snap, and
 * anything wildly larger is caught rather than sent.
 */
export const MAX_QUERY_DEG2 = 25;

/**
 * Don't cache responses bigger than this many nodes.
 *
 * localStorage is synchronous: stringifying a few megabytes of nodes janks the
 * main thread on every pan, and a handful of such entries exhausts the origin
 * quota anyway. Big dense views simply re-query — that costs one request, which
 * is cheaper than a frozen map.
 */
export const CACHE_MAX_NODES = 3000;

/**
 * How many wall tiles to add per page.
 *
 * The wall's real ceiling is bandwidth, not catalogue size: only tiles actually
 * on screen ever refresh (see wall.js), so this just keeps the DOM bounded.
 */
export const WALL_PAGE = 60;

/**
 * Tags the OSM wiki wants on a well-described ALPR node.
 *
 * `optional` ones are shown as things you *could* add but don't mark a record
 * incomplete. `ref` is missing on essentially every node in the wild — counting
 * it would flag 100% of records and drown out the gaps that are actually worth
 * a trip outside.
 */
export const DESIRED_TAGS = [
  { key: "direction",         label: "Direction",   why: "Which way it faces — determines what it actually captures." },
  { key: "manufacturer",      label: "Manufacturer",why: "Flock, Motorola, Genetec, Leonardo…" },
  { key: "operator",          label: "Operator",    why: "Which agency or business runs it. The most-missing tag." },
  { key: "surveillance:zone", label: "Zone",        why: "traffic / parking / entrance." },
  { key: "camera:mount",      label: "Mount",       why: "pole / wall / mast." },
  { key: "ref",               label: "Reference",   why: "Any visible unit ID on the housing.", optional: true },
];

/** The subset that decides whether a record counts as incomplete. */
export const CORE_TAGS = DESIRED_TAGS.filter((t) => !t.optional);
