/**
 * The dual-layer map.
 *
 * Two camera networks watch the same roads. One you can watch back; one only
 * watches you. Putting them in a single view, at the same scale, is the whole
 * point of this page — so the two layers share every control except colour.
 *
 * Data loads in two regimes. Zoomed out, the country is too big to ask Overpass
 * about, so we render pre-baked per-state counts and say so. Zoomed in past
 * LIVE_DATA_MIN_ZOOM, every settled map move queries the actual viewport. The
 * seam between those two is the only part of this file that is tricky.
 */

import {
  VIEW,
  BASEMAP,
  LIVE_DATA_MIN_ZOOM,
  CORE_TAGS,
  CAMERA_REFRESH_MS,
} from "./config.js";
import {
  loadCameras,
  loadALPRsInBBox,
  loadVendors,
  loadSummary,
  missingTags,
  editUrl,
  bust,
} from "./data.js";
import { coneRing, parseDirections, distance, metersToMiles, streetViewLinks } from "./geo.js";
import * as locale from "./locale.js";

const $ = (sel) => document.querySelector(sel);

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

const state = {
  cameras: [],
  alprs: [],
  vendors: {},
  publicNetwork: {},
  summary: [],
  markers: [],
  thumbTimer: null,
  moveTimer: null,
  seq: 0,
  live: false,
  /** True while a flyTo we started is still settling — see the moveend handler. */
  programmatic: false,
};

const start = locale.initial();

const map = new maplibregl.Map({
  container: "map",
  style: BASEMAP,
  center: [start.lon, start.lat],
  zoom: start.zoom,
  minZoom: VIEW.minZoom,
  maxZoom: VIEW.maxZoom,
  attributionControl: false,
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
map.addControl(
  new maplibregl.AttributionControl({
    compact: true,
    customAttribution:
      '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a> · ALPR data ODbL · cameras © state DOTs',
  }),
  "bottom-right"
);

/* ---------- GeoJSON builders ---------- */

const fc = (features) => ({ type: "FeatureCollection", features });

function cameraFeatures(cameras) {
  return fc(
    cameras.map((c, i) => ({
      type: "Feature",
      id: i,
      geometry: { type: "Point", coordinates: [c.longitude, c.latitude] },
      properties: { idx: i },
    }))
  );
}

function alprFeatures(nodes) {
  return fc(
    nodes.map((n, i) => ({
      type: "Feature",
      id: i,
      geometry: { type: "Point", coordinates: [n.lon, n.lat] },
      properties: {
        idx: i,
        incomplete: missingTags(n, CORE_TAGS).length > 0 ? 1 : 0,
      },
    }))
  );
}

/** One wedge per direction — a dual-head unit tagged "105;343" gets two. */
function coneFeatures(nodes) {
  const out = [];
  nodes.forEach((n, i) => {
    for (const bearing of parseDirections(n.tags && n.tags.direction)) {
      out.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [coneRing(n.lat, n.lon, bearing)] },
        properties: { idx: i },
      });
    }
  });
  return fc(out);
}

/* ---------- layers ---------- */

function addLayers() {
  map.addSource("alpr-cones", { type: "geojson", data: fc([]) });
  map.addSource("alpr", { type: "geojson", data: fc([]) });
  map.addSource("odot", { type: "geojson", data: fc([]) });
  map.addSource("probe", { type: "geojson", data: fc([]) });

  map.addLayer({
    id: "alpr-cones",
    type: "fill",
    source: "alpr-cones",
    paint: { "fill-color": "#ff4d4f", "fill-opacity": 0.16 },
  });

  map.addLayer({
    id: "probe-ring",
    type: "line",
    source: "probe",
    paint: {
      "line-color": "#ffffff",
      "line-width": 1.2,
      "line-opacity": 0.5,
      "line-dasharray": [3, 3],
    },
  });

  map.addLayer({
    id: "alpr-points",
    type: "circle",
    source: "alpr",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 3, 13, 5.5, 17, 9],
      "circle-color": "#ff4d4f",
      "circle-stroke-width": 1,
      "circle-stroke-color": "#08090b",
    },
  });

  // Ring around nodes with tags missing — the contribute page's to-do list, on the map.
  map.addLayer({
    id: "alpr-gaps",
    type: "circle",
    source: "alpr",
    filter: ["==", ["get", "incomplete"], 1],
    layout: { visibility: "none" },
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 7, 13, 10, 17, 15],
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-width": 1.4,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-opacity": 0.55,
    },
  });

  map.addLayer({
    id: "odot-points",
    type: "circle",
    source: "odot",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 5, 13, 8, 17, 13],
      "circle-color": "#ffcc00",
      "circle-stroke-width": 2,
      "circle-stroke-color": "#08090b",
    },
  });

  for (const id of ["odot-points", "alpr-points"]) {
    map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
  }

  map.on("click", "odot-points", (e) => showCamera(state.cameras[e.features[0].properties.idx]));
  map.on("click", "alpr-points", (e) => showALPR(state.alprs[e.features[0].properties.idx]));

  // A click on empty map = "who watches this spot?"
  map.on("click", (e) => {
    const hit = map.queryRenderedFeatures(e.point, { layers: ["odot-points", "alpr-points"] });
    if (hit.length === 0) probeAt(e.lngLat.lat, e.lngLat.lng);
  });
}

/* ---------- national summary ---------- */

const BUBBLE_MIN_PX = 30;
const BUBBLE_MAX_PX = 74;

/**
 * Diameter for a state's count, scaled against the busiest state in the file.
 *
 * Area-proportional, so `sqrt` — a state with four times the readers gets four
 * times the ink, not four times the width. Calibrating off the observed maximum
 * rather than a fixed coefficient matters because these counts are neither
 * small nor stable: Ohio is around 6,700 and California around 20,000, and any
 * constant tuned for one of those pins every other state to the clamp and
 * renders the whole country at one size.
 */
function bubbleSize(count, max) {
  if (!max) return BUBBLE_MIN_PX;
  const t = Math.sqrt(Math.min(count, max) / max);
  return Math.round(BUBBLE_MIN_PX + (BUBBLE_MAX_PX - BUBBLE_MIN_PX) * t);
}

/**
 * Drawn as HTML markers rather than a symbol layer on purpose: a symbol layer
 * would need a glyph stack from the basemap style, and fifty markers cost
 * nothing. This keeps the zoomed-out view independent of the style's fonts.
 */
function showSummary() {
  if (state.markers.length) return;

  const max = state.summary.reduce((m, s) => Math.max(m, s.count || 0), 0);

  for (const s of state.summary) {
    if (!s.count) continue; // null = we couldn't ask; 0 = genuinely none. Neither draws.

    const el = document.createElement("button");
    el.className = "state-bubble";
    el.type = "button";
    el.title = `${s.name}: ${s.count.toLocaleString()} plate readers mapped in OSM`;
    el.innerHTML = `<span>${s.count.toLocaleString()}</span><small>${esc(s.code)}</small>`;

    const size = bubbleSize(s.count, max);
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;

    el.addEventListener("click", () => {
      map.flyTo({ center: [s.lon, s.lat], zoom: LIVE_DATA_MIN_ZOOM + 0.4 });
    });

    state.markers.push(new maplibregl.Marker({ element: el }).setLngLat([s.lon, s.lat]).addTo(map));
  }
}

function hideSummary() {
  state.markers.forEach((m) => m.remove());
  state.markers = [];
}

/* ---------- viewport-driven loading ---------- */

const inView = (b, lat, lon) =>
  lat >= b.getSouth() && lat <= b.getNorth() && lon >= b.getWest() && lon <= b.getEast();

function setStatus(html, tone) {
  const el = $("#loading");
  el.innerHTML = html;
  el.className = tone || "";
}

/**
 * Reload for wherever the map now is.
 *
 * `seq` guards against a slow response for an old viewport landing after a fast
 * one for the current viewport and quietly replacing good data with stale data.
 * Panning quickly triggers that within seconds.
 */
async function refreshViewport({ force = false } = {}) {
  const zoom = map.getZoom();
  const bounds = map.getBounds();

  // Cameras are cheap to hold in memory; only the count is viewport-scoped.
  const camsHere = state.cameras.filter((c) => inView(bounds, c.latitude, c.longitude));
  $("#count-odot").textContent = camsHere.length.toLocaleString();

  if (zoom < LIVE_DATA_MIN_ZOOM) {
    state.live = false;
    state.alprs = [];
    map.getSource("alpr").setData(fc([]));
    map.getSource("alpr-cones").setData(fc([]));
    showSummary();

    const total = state.summary.reduce((n, s) => n + (s.count || 0), 0);
    $("#count-alpr").textContent = total ? total.toLocaleString() : "—";
    $("#count-gaps").textContent = "—";
    setStatus(
      state.summary.length
        ? "Showing per-state totals. <b>Zoom in</b> to load individual plate readers."
        : "<b>Zoom in</b> to load plate readers for an area."
    );
    return;
  }

  hideSummary();
  state.live = true;

  const seq = ++state.seq;
  setStatus('<span class="spinner"></span> Loading plate readers for this view…');

  try {
    const { nodes, stale } = await loadALPRsInBBox(
      [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()],
      { force }
    );
    if (seq !== state.seq) return; // a newer viewport already won

    state.alprs = nodes;
    map.getSource("alpr").setData(alprFeatures(nodes));
    map.getSource("alpr-cones").setData(coneFeatures(nodes));

    const incomplete = nodes.filter((n) => missingTags(n, CORE_TAGS).length > 0).length;
    $("#count-alpr").textContent = nodes.length.toLocaleString();
    $("#count-gaps").textContent = incomplete.toLocaleString();

    setStatus(
      nodes.length === 0
        ? "No plate readers mapped here yet. That may mean none exist — or that nobody has added them."
        : `<b>${nodes.length.toLocaleString()}</b> plate readers in view.`
    );
    $("#stale-hint").classList.toggle("hide", !stale);
  } catch (err) {
    if (seq !== state.seq) return;
    setStatus(`Could not load plate readers — ${esc(err.message)}`, "warn");
  }
}

/** Map moves are chatty; one query per settled view is plenty. */
function scheduleRefresh() {
  clearTimeout(state.moveTimer);
  state.moveTimer = setTimeout(() => refreshViewport(), 400);
}

/* ---------- detail panel ---------- */

function closeDetail() {
  clearInterval(state.thumbTimer);
  state.thumbTimer = null;
  $("#detail").classList.add("hide");
}

function openDetail(html) {
  clearInterval(state.thumbTimer);
  state.thumbTimer = null;
  const el = $("#detail");
  el.innerHTML = '<button class="detail-close" aria-label="Close">✕</button>' + html;
  el.classList.remove("hide");
  el.querySelector(".detail-close").addEventListener("click", closeDetail);
  el.scrollTop = 0;
}

function scoreRow(label, value, tone) {
  const cls = tone ? ' class="' + tone + '"' : "";
  return `<div class="score-row"><dt>${esc(label)}</dt><dd${cls}>${esc(value)}</dd></div>`;
}

/** Public camera: the point is that you can just look through it. */
function showCamera(cam) {
  if (!cam) return;
  const p = state.publicNetwork;
  const views = cam.views || [];

  openDetail(`
    <span class="chip open">Public infrastructure</span>
    <h2 class="detail-title">${esc(cam.location || "Traffic camera")}</h2>
    <p class="detail-sub">${esc(cam.description || "")}</p>

    ${views
      .map(
        (v) => `<figure class="thumb">
            <img class="cam-img" data-src="${esc(v.smallUrl)}" alt="${esc(cam.location)} live view">
            <figcaption>${esc(v.direction || "view")} · ${esc(v.mainRoute || "")}</figcaption>
          </figure>`
      )
      .join("")}

    <h3 class="panel-title" style="margin-top:18px">Transparency</h3>
    <dl class="score-grid">
      ${scoreRow("You can view it live", "Yes", "yes")}
      ${scoreRow("Identifies individuals", "No", "yes")}
      ${scoreRow("Operator", cam.agency || p.operator || "State DOT")}
      ${scoreRow("Data licence", p.dataLicense || "Public domain")}
      ${scoreRow("Records request", p.recordsRequest || "—")}
    </dl>
    <p class="detail-note">${esc(p.retention || "")}</p>
    <p class="detail-note faint mono">${cam.latitude.toFixed(5)}, ${cam.longitude.toFixed(5)}</p>
  `);

  // Live refresh, cleared whenever the panel closes or another one opens.
  const imgs = Array.from($("#detail").querySelectorAll(".cam-img"));
  const tick = () => imgs.forEach((img) => (img.src = bust(img.dataset.src)));
  tick();
  state.thumbTimer = setInterval(tick, CAMERA_REFRESH_MS);
}

/** ALPR: the point is how little you are allowed to know. */
function showALPR(node) {
  if (!node) return;
  const t = node.tags || {};
  const maker = t.manufacturer || "Unknown";
  const v = state.vendors[maker] || {};
  const gaps = missingTags(node, CORE_TAGS);
  const dirs = parseDirections(t.direction);
  const sv = streetViewLinks(node.lat, node.lon, dirs);

  const gapBlock = gaps.length
    ? `<h3 class="panel-title" style="margin-top:18px">Missing from OSM (${gaps.length})</h3>
       <div class="gap-tags">${gaps.map((g) => `<span class="chip missing">${esc(g.label)}</span>`).join("")}</div>
       <a class="btn btn-primary" style="width:100%;margin-top:12px" target="_blank" rel="noopener"
          href="${esc(editUrl(node))}">Add these in OpenStreetMap →</a>
       <p class="detail-note faint">Edits land in OSM, so DeFlock and every other consumer picks them up too.</p>`
    : '<p class="detail-note" style="color:var(--ok)">✓ Fully tagged. Nothing to add.</p>';

  openDetail(`
    <span class="chip closed">Private surveillance</span>
    <h2 class="detail-title">${esc(maker)} ALPR</h2>
    <p class="detail-sub">Reads and records licence plates. There is no public view through this camera.</p>

    <div class="no-view">
      <span>NO PUBLIC FEED</span>
      <small>This one only points outward.</small>
    </div>

    <div class="sv-block">
      <p class="sv-lede">You can't look through it. You can still look at it.</p>
      <div class="sv-links">
        <a class="btn btn-sm" target="_blank" rel="noopener" href="${esc(sv.toward)}">Street View: the pole ↗</a>
        ${
          sv.along
            ? `<a class="btn btn-sm" target="_blank" rel="noopener" href="${esc(sv.along)}">What it sees ↗</a>`
            : ""
        }
      </div>
      <p class="detail-note faint">Google snaps to the nearest panorama, so the aim is approximate.</p>
    </div>

    <h3 class="panel-title" style="margin-top:18px">Transparency</h3>
    <dl class="score-grid">
      ${scoreRow("You can view it live", "No", "no")}
      ${scoreRow("Identifies individuals", "Yes", "no")}
      ${scoreRow("Operator", t.operator || "Not recorded in OSM")}
      ${scoreRow("Faces", dirs.length ? dirs.map((d) => Math.round(d) + "°").join(" / ") : "Unknown")}
      ${scoreRow("Zone", t["surveillance:zone"] || "—")}
    </dl>
    <p class="detail-note">${esc(v.retention || "Retention is set by the operating agency's contract.")}</p>
    ${v.sharing ? `<p class="detail-note">${esc(v.sharing)}</p>` : ""}

    ${gapBlock}
    <p class="detail-note faint mono">node/${node.id} · ${node.lat.toFixed(5)}, ${node.lon.toFixed(5)}</p>
  `);
}

/* ---------- "who watches this spot?" ---------- */

const PROBE_M = 1609.344; // one mile

function circleRing(lat, lon, meters, steps = 64) {
  const R = 6371008.8;
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const d = meters / R;
    const b = ((360 * i) / steps) * (Math.PI / 180);
    const l1 = (lat * Math.PI) / 180;
    const o1 = (lon * Math.PI) / 180;
    const l2 = Math.asin(Math.sin(l1) * Math.cos(d) + Math.cos(l1) * Math.sin(d) * Math.cos(b));
    const o2 =
      o1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(l1), Math.cos(d) - Math.sin(l1) * Math.sin(l2));
    ring.push([(o2 * 180) / Math.PI, (l2 * 180) / Math.PI]);
  }
  return ring;
}

function probeAt(lat, lon) {
  // Nothing is loaded at summary zoom, so a count here would read as zero.
  if (!state.live) return;

  const alprs = state.alprs.filter((n) => distance(lat, lon, n.lat, n.lon) <= PROBE_M);
  const cams = state.cameras.filter((c) => distance(lat, lon, c.latitude, c.longitude) <= PROBE_M);

  map.getSource("probe").setData(
    fc([
      {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [circleRing(lat, lon, PROBE_M)] },
        properties: {},
      },
    ])
  );

  const nearest = state.alprs
    .map((n) => ({ n, d: distance(lat, lon, n.lat, n.lon) }))
    .sort((a, b) => a.d - b.d)[0];

  const probe = $("#probe");
  probe.innerHTML = `
    <div class="probe-head">
      <span class="panel-title" style="margin:0">Within one mile</span>
      <button class="probe-close" aria-label="Clear">✕</button>
    </div>
    <div class="probe-stats">
      <div class="probe-stat closed"><span class="stat-num">${alprs.length}</span><small>plate readers</small></div>
      <div class="probe-stat open"><span class="stat-num">${cams.length}</span><small>public cameras</small></div>
    </div>
    ${
      nearest
        ? `<p class="detail-note faint">Nearest plate reader in view: ${metersToMiles(nearest.d).toFixed(2)} mi</p>`
        : ""
    }`;
  probe.classList.remove("hide");
  probe.querySelector(".probe-close").addEventListener("click", () => {
    probe.classList.add("hide");
    map.getSource("probe").setData(fc([]));
  });
}

/* ---------- legend wiring ---------- */

function wireLegend() {
  const bind = (rowSel, layers) => {
    const row = $(rowSel);
    row.addEventListener("click", () => {
      const on = !row.classList.contains("on");
      row.classList.toggle("on", on);
      layers.forEach((id) => map.setLayoutProperty(id, "visibility", on ? "visible" : "none"));
    });
  };
  bind("#row-odot", ["odot-points"]);
  bind("#row-alpr", ["alpr-points", "alpr-cones"]);
  bind("#row-gaps", ["alpr-gaps"]);

  // The six-hour cache means a contributor cannot see their own OSM edit
  // without this. That is exactly the moment they most want to.
  $("#refresh").addEventListener("click", async (e) => {
    e.target.disabled = true;
    await refreshViewport({ force: true });
    e.target.disabled = false;
  });
}

/* ---------- boot ---------- */

map.on("load", async () => {
  addLayers();
  wireLegend();

  const [camData, vendorData, summary] = await Promise.all([
    loadCameras(),
    loadVendors(),
    loadSummary(),
  ]);

  state.cameras = camData.cameras;
  state.vendors = vendorData.vendors || {};
  state.publicNetwork = vendorData.publicNetwork || {};
  state.summary = summary.states || [];

  map.getSource("odot").setData(cameraFeatures(state.cameras));
  if (camData.source === "seed") $("#seed-hint").classList.remove("hide");

  await refreshViewport();

  map.on("moveend", () => {
    // The map is the source of truth once it moves: push the view into the URL
    // so it is shareable, and into locale so the other pages follow.
    const c = map.getCenter();
    const view = { lat: c.lat, lon: c.lng, zoom: map.getZoom() };

    if (state.programmatic) {
      // We flew here because a place was picked, so that place's name still
      // describes the view. Keep it, and stay quiet to avoid a feedback loop.
      state.programmatic = false;
      locale.set(view, { silent: true });
    } else {
      // The visitor dragged. Whatever this view was called, it isn't that any
      // more — drop the name rather than let the header lie about where you are.
      locale.set({ ...view, name: null, source: "map" });
    }

    locale.writeHash(view);
    scheduleRefresh();
  });
});

/* A place chosen in the header moves the map; the moveend above does the rest. */
locale.subscribe((next) => {
  if (next.source === "map") return; // our own move, already applied
  state.programmatic = true;
  map.flyTo({ center: [next.lon, next.lat], zoom: next.zoom ?? map.getZoom(), essential: true });
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDetail();
});
