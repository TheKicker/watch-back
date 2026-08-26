/** Shared constants. Change CENTER to re-home the whole site on another town. */

export const CENTER = { lat: 40.3871, lon: -80.6348, name: "Steubenville, OH" };

/** Default map view. */
export const VIEW = { zoom: 11, minZoom: 7, maxZoom: 18 };

/** How far out we look for ALPRs, in meters. */
export const ALPR_RADIUS_M = 40000;

/** Basemap: CARTO dark-matter is keyless and CORS-open. */
export const BASEMAP = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

/** Overpass mirrors, tried in order. Both send Access-Control-Allow-Origin: *. */
export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

/** ODOT publishes a fresh JPEG roughly every 5s. */
export const CAMERA_REFRESH_MS = 5000;

/** Overpass results are cached this long. ALPR nodes change on the order of days. */
export const ALPR_CACHE_MS = 6 * 60 * 60 * 1000;

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
