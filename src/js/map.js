/**
 * The dual-layer map.
 *
 * Two camera networks watch the same roads. One you can watch back; one only
 * watches you. Putting them in a single view, at the same scale, is the whole
 * point of this page — so the two layers share every control except colour.
 */

import { CENTER, VIEW, BASEMAP, ALPR_RADIUS_M, CORE_TAGS, CAMERA_REFRESH_MS } from "./config.js";
import { loadCameras, loadALPRs, loadVendors, missingTags, editUrl, bust } from "./data.js";
import { coneRing, parseDirections, distance, metersToMiles, streetViewLinks } from "./geo.js";

const $ = (sel) => document.querySelector(sel);

const state = {
  cameras: [],
  alprs: [],
  vendors: {},
  publicNetwork: {},
  thumbTimer: null,
};

const map = new maplibregl.Map({
  container: "map",
  style: BASEMAP,
  center: [CENTER.lon, CENTER.lat],
  zoom: VIEW.zoom,
  minZoom: VIEW.minZoom,
  maxZoom: VIEW.maxZoom,
  attributionControl: false,
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
map.addControl(
  new maplibregl.AttributionControl({
    compact: true,
    customAttribution:
      '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a> · ALPR data ODbL · cameras © ODOT',
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

/* ---------- detail panel ---------- */

const ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

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

/** ODOT camera: the point is that you can just look through it. */
function showCamera(cam) {
  if (!cam) return;
  const p = state.publicNetwork;
  const views = cam.views || [];

  openDetail(`
    <span class="chip open">Public infrastructure</span>
    <h2 class="detail-title">${esc(cam.location || "ODOT camera")}</h2>
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
      ${scoreRow("Operator", p.operator || "ODOT")}
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
        ? `<p class="detail-note faint">Nearest plate reader: ${metersToMiles(nearest.d).toFixed(2)} mi</p>`
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
}

/* ---------- boot ---------- */

map.on("load", async () => {
  addLayers();
  wireLegend();

  const [camData, vendorData] = await Promise.all([loadCameras(), loadVendors()]);
  state.cameras = camData.cameras;
  state.vendors = vendorData.vendors || {};
  state.publicNetwork = vendorData.publicNetwork || {};

  map.getSource("odot").setData(cameraFeatures(state.cameras));
  $("#count-odot").textContent = state.cameras.length;
  if (camData.source === "seed") $("#seed-hint").classList.remove("hide");

  try {
    const { nodes, stale } = await loadALPRs(CENTER.lat, CENTER.lon, ALPR_RADIUS_M);
    state.alprs = nodes;
    map.getSource("alpr").setData(alprFeatures(nodes));
    map.getSource("alpr-cones").setData(coneFeatures(nodes));

    const incomplete = nodes.filter((n) => missingTags(n, CORE_TAGS).length > 0).length;
    $("#count-alpr").textContent = nodes.length;
    $("#count-gaps").textContent = incomplete;
    $("#loading").classList.add("hide");
    if (stale) $("#stale-hint").classList.remove("hide");
  } catch (err) {
    $("#loading").innerHTML =
      '<span style="color:var(--closed)">ALPR data unavailable — ' + esc(err.message) + "</span>";
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDetail();
});
