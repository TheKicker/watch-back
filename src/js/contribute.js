/**
 * The contribution funnel.
 *
 * DeFlock already has the national map. What it cannot have is someone standing
 * at the corner of Sunset and University who knows which pole is which. So this
 * page does the one thing local knowledge is uniquely good at: it finds the
 * nearby records that are incomplete and walks you into the OSM editor.
 *
 * Everything written there flows back into OSM, which is where DeFlock reads
 * from — so fixing it here fixes it there.
 */

import { CENTER, ALPR_RADIUS_M, DESIRED_TAGS, CORE_TAGS } from "./config.js";
import { loadALPRs, missingTags, editUrl } from "./data.js";
import { distance, metersToMiles, parseDirections, streetViewLinks } from "./geo.js";

const $ = (sel) => document.querySelector(sel);

const state = { rows: [], sort: "nearest" };

const esc = (s) =>
  String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

function bearingFrom(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x =
    Math.cos(lat1 * r) * Math.sin(lat2 * r) -
    Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}

const compassOf = (deg) => COMPASS[Math.round(deg / 22.5) % 16];

function render() {
  const rows = [...state.rows].sort((a, b) =>
    state.sort === "nearest" ? a.dist - b.dist : b.gaps.length - a.gaps.length || a.dist - b.dist
  );

  $("#list").innerHTML = rows
    .slice(0, 60)
    .map(
      (r) => `
      <li class="fix-row">
        <div class="fix-main">
          <div class="fix-head">
            <span class="fix-maker">${esc(r.node.tags?.manufacturer || "Unspecified")} ALPR</span>
            <span class="fix-dist mono">${metersToMiles(r.dist).toFixed(1)} mi ${compassOf(r.bearing)}</span>
          </div>
          <div class="gap-tags">
            ${DESIRED_TAGS.map((t) => {
              const missing = r.gaps.some((g) => g.key === t.key);
              return `<span class="chip ${missing ? "missing" : "present"}" title="${esc(t.why)}">${
                missing ? "" : "✓ "
              }${esc(t.label)}</span>`;
            }).join("")}
          </div>
          <span class="fix-coords mono faint">node/${r.node.id} · ${r.node.lat.toFixed(5)}, ${r.node.lon.toFixed(5)}</span>
        </div>
        <div class="fix-actions">
          <a class="btn btn-sm" target="_blank" rel="noopener" href="${esc(
            streetViewLinks(r.node.lat, r.node.lon, parseDirections(r.node.tags?.direction)).toward
          )}">Look ↗</a>
          <a class="btn btn-sm btn-primary" target="_blank" rel="noopener" href="${esc(editUrl(r.node))}">Edit ↗</a>
        </div>
      </li>`
    )
    .join("");

  $("#showing").textContent = Math.min(rows.length, 60);
}

async function boot() {
  try {
    const { nodes } = await loadALPRs(CENTER.lat, CENTER.lon, ALPR_RADIUS_M);

    const rows = nodes
      .map((node) => ({
        node,
        gaps: missingTags(node, CORE_TAGS),
        dist: distance(CENTER.lat, CENTER.lon, node.lat, node.lon),
        bearing: bearingFrom(CENTER.lat, CENTER.lon, node.lat, node.lon),
      }))
      .filter((r) => r.gaps.length > 0);

    state.rows = rows;

    // Headline numbers: how much of the local record is actually filled in.
    const totalSlots = nodes.length * CORE_TAGS.length;
    const filled = totalSlots - nodes.reduce((n, x) => n + missingTags(x, CORE_TAGS).length, 0);

    $("#stat-total").textContent = nodes.length;
    $("#stat-gaps").textContent = rows.length;
    $("#stat-pct").textContent = totalSlots ? Math.round((filled / totalSlots) * 100) + "%" : "—";

    // Which single tag is most-missing — the highest-leverage thing to fix.
    const worst = CORE_TAGS.map((t) => ({
      t,
      n: nodes.filter((x) => !x.tags?.[t.key]).length,
    })).sort((a, b) => b.n - a.n)[0];

    if (worst && worst.n > 0) {
      $("#worst").innerHTML =
        `Biggest gap: <b>${esc(worst.t.label)}</b> is missing on ` +
        `<b>${worst.n}</b> of ${nodes.length} nearby readers. ${esc(worst.t.why)}`;
      $("#worst").classList.remove("hide");
    }

    $("#loading").classList.add("hide");
    $("#list-wrap").classList.remove("hide");
    render();
  } catch (err) {
    $("#loading").innerHTML =
      '<span style="color:var(--closed)">Could not reach OpenStreetMap — ' + esc(err.message) + "</span>";
  }

  document.querySelectorAll("[data-sort]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.sort = btn.dataset.sort;
      document.querySelectorAll("[data-sort]").forEach((b) => b.classList.remove("btn-primary"));
      btn.classList.add("btn-primary");
      render();
    });
  });
}

boot();
