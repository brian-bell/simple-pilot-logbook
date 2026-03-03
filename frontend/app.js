/**
 * Simple Pilot Logbook — Frontend
 *
 * Polls /api/status every 3 s for live SimConnect state.
 * Polls /api/flights every 10 s (and on first load) for the logbook table.
 * All DOM manipulation is vanilla JS — no build step, no dependencies.
 */

"use strict";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_INTERVAL = 3_000;   // ms between status polls
const FLIGHTS_INTERVAL = 10_000; // ms between logbook refreshes

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _flights = [];
let _sortCol = "date";
let _sortDir = "desc";   // "asc" | "desc"

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Format elapsed seconds as "2h 34m" or "45m 12s".
 * @param {number|null} secs
 */
function fmtDuration(secs) {
  if (secs == null) return "—";
  secs = Math.round(secs);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/**
 * Format a vertical speed in fpm with a landing quality CSS class.
 * @param {number|null} fpm
 * @returns {{ text: string, cls: string }}
 */
function fmtVS(fpm) {
  if (fpm == null) return { text: "—", cls: "" };
  const abs = Math.abs(fpm);
  const text = `${Math.round(fpm)} fpm`;
  let cls = "";
  if (abs <= 200)       cls = "vs-smooth";
  else if (abs <= 400)  cls = "vs-firm";
  else                  cls = "vs-hard";
  return { text, cls };
}

/**
 * Format a G-force value.
 * @param {number|null} g
 */
function fmtG(g) {
  if (g == null) return "—";
  return g.toFixed(2) + " G";
}

/**
 * Format a distance in nautical miles.
 * @param {number|null} nm
 */
function fmtNm(nm) {
  if (nm == null) return "—";
  return nm.toFixed(1);
}

/**
 * Format altitude in feet.
 * @param {number|null} ft
 */
function fmtAlt(ft) {
  if (ft == null) return "—";
  return Math.round(ft).toLocaleString() + " ft";
}

/**
 * Parse an ISO 8601 date string and return { date, time } display strings.
 * @param {string|null} iso
 */
function fmtDate(iso) {
  if (!iso) return { date: "—", time: "" };
  const d = new Date(iso);
  if (isNaN(d)) return { date: iso.slice(0, 10), time: "" };
  return {
    date: d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }),
    time: d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
  };
}

/**
 * Build a safe text node from a potentially unsafe string.
 * @param {string|null|undefined} s
 * @param {string} fallback
 */
function safe(s, fallback = "—") {
  return (s != null && s !== "") ? String(s) : fallback;
}

/**
 * Return ICAO or a shortened coordinate string.
 * @param {object} flight
 * @param {"departure"|"arrival"} which
 */
function routeLabel(flight, which) {
  const icao = flight[`${which}_icao`];
  const lat  = flight[`${which}_lat`];
  const lon  = flight[`${which}_lon`];
  if (icao) return icao;
  if (lat != null && lon != null) {
    const ns = lat >= 0 ? "N" : "S";
    const ew = lon >= 0 ? "E" : "W";
    return `${ns}${Math.abs(lat).toFixed(1)} ${ew}${Math.abs(lon).toFixed(1)}`;
  }
  return "—";
}

// ---------------------------------------------------------------------------
// Status polling
// ---------------------------------------------------------------------------

async function pollStatus() {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    applyStatus(data);
  } catch {
    applyStatus({ connected: false, state: "DISCONNECTED", current_flight: null });
  }
}

function applyStatus({ connected, state, current_flight }) {
  const dot   = document.getElementById("status-dot");
  const label = document.getElementById("status-label");

  dot.className = "status-dot";
  if (state === "AIRBORNE") {
    dot.classList.add("airborne");
    label.textContent = "In Flight";
  } else if (connected) {
    dot.classList.add("connected");
    label.textContent = "Connected";
  } else {
    dot.classList.add("disconnected");
    label.textContent = "Disconnected";
  }

  const banner = document.getElementById("active-banner");
  if (state === "AIRBORNE" && current_flight) {
    banner.classList.remove("hidden");
    const cf = current_flight;
    document.getElementById("b-dep").textContent =
      cf.departure_icao || "—";
    document.getElementById("b-aircraft").textContent =
      cf.aircraft_registration || cf.aircraft_title?.split(" ").slice(0, 3).join(" ") || "—";
    document.getElementById("b-alt").textContent =
      cf.altitude_ft != null ? Math.round(cf.altitude_ft).toLocaleString() : "—";
    document.getElementById("b-elapsed").textContent =
      fmtDuration(cf.elapsed_seconds);
  } else {
    banner.classList.add("hidden");
  }
}

// ---------------------------------------------------------------------------
// Flights table
// ---------------------------------------------------------------------------

async function loadFlights() {
  try {
    const res = await fetch("/api/flights?limit=200");
    if (!res.ok) throw new Error(res.status);
    const { flights, total } = await res.json();
    _flights = flights;
    renderTable();

    const countEl = document.getElementById("flight-count");
    countEl.textContent = total > 0 ? `${total} flight${total !== 1 ? "s" : ""}` : "";
  } catch {
    // silently ignore – table stays as-is
  }
}

function sortedFlights() {
  const col = _sortCol;
  const dir = _sortDir === "asc" ? 1 : -1;

  return [..._flights].sort((a, b) => {
    let va, vb;
    switch (col) {
      case "date":        va = a.date || ""; vb = b.date || ""; break;
      case "aircraft":    va = a.aircraft_registration || a.aircraft_title || ""; vb = b.aircraft_registration || b.aircraft_title || ""; break;
      case "from":        va = a.departure_icao || ""; vb = b.departure_icao || ""; break;
      case "to":          va = a.arrival_icao || ""; vb = b.arrival_icao || ""; break;
      case "distance_nm": va = a.distance_nm ?? -Infinity; vb = b.distance_nm ?? -Infinity; break;
      case "elapsed":     va = a.elapsed_seconds ?? -Infinity; vb = b.elapsed_seconds ?? -Infinity; break;
      case "max_alt":     va = a.max_altitude_ft ?? -Infinity; vb = b.max_altitude_ft ?? -Infinity; break;
      case "landing_vs":  va = a.landing_vs_fpm ?? Infinity; vb = b.landing_vs_fpm ?? Infinity; break;
      case "landing_g":   va = a.landing_g_force ?? -Infinity; vb = b.landing_g_force ?? -Infinity; break;
      default:            va = ""; vb = "";
    }
    if (va < vb) return -dir;
    if (va > vb) return dir;
    return 0;
  });
}

function renderTable() {
  const tbody    = document.getElementById("flight-rows");
  const emptyEl  = document.getElementById("empty-state");
  const tableEl  = document.getElementById("logbook-table");

  // Update sort indicators
  document.querySelectorAll(".logbook-table th.sortable").forEach(th => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.col === _sortCol) {
      th.classList.add(_sortDir === "asc" ? "sort-asc" : "sort-desc");
    }
  });

  const rows = sortedFlights();

  if (rows.length === 0) {
    tableEl.classList.add("hidden");
    emptyEl.classList.remove("hidden");
    return;
  }

  tableEl.classList.remove("hidden");
  emptyEl.classList.add("hidden");

  const frag = document.createDocumentFragment();

  rows.forEach(flight => {
    const tr = document.createElement("tr");
    tr.dataset.id = flight.id;

    const { date, time } = fmtDate(flight.date);
    const depLabel  = routeLabel(flight, "departure");
    const arrLabel  = routeLabel(flight, "arrival");
    const vs        = fmtVS(flight.landing_vs_fpm);
    const aircraft  = flight.aircraft_registration || "";
    const title     = flight.aircraft_title || "";

    tr.innerHTML = `
      <td>
        <span class="date-date">${date}</span>
        <span class="date-time">${time}</span>
      </td>
      <td>
        ${aircraft ? `<span class="aircraft-reg">${escHtml(aircraft)}</span>` : ""}
        <span class="aircraft-title" title="${escHtml(title)}">${escHtml(title || "—")}</span>
      </td>
      <td><span class="route-from">${escHtml(depLabel)}</span></td>
      <td><span class="route-to">${escHtml(arrLabel)}</span></td>
      <td class="num hide-sm">${fmtNm(flight.distance_nm)}</td>
      <td class="num">${fmtDuration(flight.elapsed_seconds)}</td>
      <td class="num hide-md">${fmtAlt(flight.max_altitude_ft)}</td>
      <td class="num"><span class="${vs.cls}">${vs.text}</span></td>
      <td class="num hide-md">${fmtG(flight.landing_g_force)}</td>
      <td class="actions-col">
        <button class="btn-delete" data-id="${flight.id}" title="Delete this flight">✕</button>
      </td>
    `;

    // Row click → open detail modal (ignore clicks on the delete button)
    tr.addEventListener("click", e => {
      if (e.target.closest(".btn-delete")) return;
      openModal(flight);
    });

    frag.appendChild(tr);
  });

  tbody.replaceChildren(frag);
}

/** Minimal HTML escaping to prevent XSS from MSFS data strings. */
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

document.querySelectorAll(".logbook-table th.sortable").forEach(th => {
  th.addEventListener("click", () => {
    const col = th.dataset.col;
    if (_sortCol === col) {
      _sortDir = _sortDir === "asc" ? "desc" : "asc";
    } else {
      _sortCol = col;
      _sortDir = col === "date" ? "desc" : "asc";
    }
    renderTable();
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

document.getElementById("flight-rows").addEventListener("click", async e => {
  const btn = e.target.closest(".btn-delete");
  if (!btn) return;
  const id = btn.dataset.id;
  if (!confirm("Delete this flight entry?")) return;
  try {
    const res = await fetch(`/api/flights/${id}`, { method: "DELETE" });
    if (res.ok) {
      _flights = _flights.filter(f => String(f.id) !== id);
      renderTable();
      const total = _flights.length;
      document.getElementById("flight-count").textContent =
        total > 0 ? `${total} flight${total !== 1 ? "s" : ""}` : "";
    }
  } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Detail modal
// ---------------------------------------------------------------------------

function openModal(flight) {
  const overlay = document.getElementById("modal-overlay");
  const title   = document.getElementById("modal-title");
  const body    = document.getElementById("modal-body");

  const dep = routeLabel(flight, "departure");
  const arr = routeLabel(flight, "arrival");
  title.textContent = `${dep} → ${arr}`;

  const vs = fmtVS(flight.landing_vs_fpm);
  const { date, time } = fmtDate(flight.date);

  body.innerHTML = `
    <p class="detail-section">Route</p>
    <div class="detail-grid">
      <div class="detail-cell">
        <span class="detail-label">Departure</span>
        <span class="detail-value">${escHtml(flight.departure_icao || "—")}</span>
      </div>
      <div class="detail-cell">
        <span class="detail-label">Arrival</span>
        <span class="detail-value">${escHtml(flight.arrival_icao || "—")}</span>
      </div>
      <div class="detail-cell">
        <span class="detail-label">Dep. Name</span>
        <span class="detail-value">${escHtml(flight.departure_name || "—")}</span>
      </div>
      <div class="detail-cell">
        <span class="detail-label">Arr. Name</span>
        <span class="detail-value">${escHtml(flight.arrival_name || "—")}</span>
      </div>
      <div class="detail-cell">
        <span class="detail-label">Distance</span>
        <span class="detail-value">${fmtNm(flight.distance_nm)} nm</span>
      </div>
      <div class="detail-cell">
        <span class="detail-label">Duration</span>
        <span class="detail-value">${fmtDuration(flight.elapsed_seconds)}</span>
      </div>
    </div>

    <p class="detail-section">Aircraft</p>
    <div class="detail-grid">
      <div class="detail-cell">
        <span class="detail-label">Registration</span>
        <span class="detail-value">${escHtml(flight.aircraft_registration || "—")}</span>
      </div>
      <div class="detail-cell">
        <span class="detail-label">Type / Title</span>
        <span class="detail-value">${escHtml(flight.aircraft_title || "—")}</span>
      </div>
    </div>

    <p class="detail-section">Performance</p>
    <div class="detail-grid">
      <div class="detail-cell">
        <span class="detail-label">Max Altitude</span>
        <span class="detail-value">${fmtAlt(flight.max_altitude_ft)}</span>
      </div>
      <div class="detail-cell">
        <span class="detail-label">Landing VS</span>
        <span class="detail-value ${vs.cls}">${vs.text}</span>
      </div>
      <div class="detail-cell">
        <span class="detail-label">Landing G-Force</span>
        <span class="detail-value">${fmtG(flight.landing_g_force)}</span>
      </div>
      <div class="detail-cell">
        <span class="detail-label">Date / Time</span>
        <span class="detail-value">${date} ${time}</span>
      </div>
    </div>

    ${flight.notes ? `
    <p class="detail-section">Notes</p>
    <div class="detail-grid">
      <div class="detail-cell" style="grid-column:1/-1">
        <span class="detail-value">${escHtml(flight.notes)}</span>
      </div>
    </div>` : ""}
  `;

  overlay.classList.remove("hidden");
}

function closeModal() {
  document.getElementById("modal-overlay").classList.add("hidden");
}

document.getElementById("modal-close").addEventListener("click", closeModal);
document.getElementById("modal-overlay").addEventListener("click", e => {
  if (e.target === e.currentTarget) closeModal();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeModal();
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

pollStatus();
loadFlights();

setInterval(pollStatus, STATUS_INTERVAL);
setInterval(loadFlights, FLIGHTS_INTERVAL);
