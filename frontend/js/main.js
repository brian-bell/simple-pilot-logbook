/**
 * Simple Pilot Logbook — Frontend
 *
 * The header, status indicator and live-flight banner are Preact components
 * (app.js, polling /api/status every 3 s). The sign-in overlay, the logbook
 * table (polled from /api/flights every 10 s), the detail modal and CSV export
 * are still vanilla DOM code here until the later migration PRs.
 * Every /api call carries a bearer token (the "viewer token") that is kept in
 * localStorage; a 401 brings up the sign-in overlay and pauses polling.
 */

import { render } from "preact";
import { html } from "./html.js";
import { App } from "./app.js";
import { UnauthorizedError, getToken, setToken, clearToken, apiFetch } from "./api.js";
import { fmtDuration, fmtVS, fmtG, fmtNm, fmtAlt, fmtDate, routeLabel } from "./format.js";
import { sortFlights } from "./sort.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FLIGHTS_INTERVAL = 10_000; // ms between logbook refreshes

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _flights = [];
let _sortCol = "date";
let _sortDir = "desc";   // "asc" | "desc"
let _flightsTimer = null;

// ---------------------------------------------------------------------------
// Auth – sign-in overlay and polling (token storage lives in api.js)
// ---------------------------------------------------------------------------

/** Show the sign-in overlay, stop polling, and reset the status indicator. */
function showAuth(message) {
  stopPolling();
  document.getElementById("auth-error").textContent = message || "";
  document.getElementById("auth-overlay").classList.remove("hidden");
  renderShell(false);
  const input = document.getElementById("auth-token");
  input.value = "";
  input.focus();
}

function hideAuth() {
  document.getElementById("auth-overlay").classList.add("hidden");
  renderShell(true);
}

/** Render the Preact shell (header, status, banner); it polls status while signed in. */
function renderShell(signedIn) {
  render(html`<${App} signedIn=${signedIn} onSignOut=${signOut} onUnauthorized=${showAuth} />`,
         document.getElementById("app"));
}

/** Save a token, verify it against /api/status, then start polling. */
async function signIn(token) {
  setToken(token);
  try {
    const res = await apiFetch("/api/status");
    if (!res.ok) throw new Error(res.status);
  } catch (err) {
    clearToken();
    showAuth(err instanceof UnauthorizedError ? "Invalid token." : "Could not reach the server.");
    return;
  }
  hideAuth();
  startPolling();
}

function signOut() {
  clearToken();
  _flights = [];
  renderTable();
  document.getElementById("flight-count").textContent = "";
  showAuth("");
}

/** Start the logbook poll; the status poll is owned by <App>. */
function startPolling() {
  if (_flightsTimer !== null) return;
  loadFlights();
  _flightsTimer = setInterval(loadFlights, FLIGHTS_INTERVAL);
}

function stopPolling() {
  if (_flightsTimer !== null) { clearInterval(_flightsTimer); _flightsTimer = null; }
}


// ---------------------------------------------------------------------------
// Flights table
// ---------------------------------------------------------------------------

/** The Worker returns at most 500 flights per page. */
const FLIGHTS_PAGE_SIZE = 500;

async function loadFlights() {
  try {
    const flights = [];
    let total = 0;
    for (;;) {
      const res = await apiFetch(`/api/flights?limit=${FLIGHTS_PAGE_SIZE}&offset=${flights.length}`);
      if (!res.ok) throw new Error(res.status);
      const page = await res.json();
      flights.push(...page.flights);
      total = page.total;
      if (page.flights.length === 0 || flights.length >= total) break;
    }
    _flights = flights;
    renderTable();

    const countEl = document.getElementById("flight-count");
    countEl.textContent = total > 0 ? `${total} flight${total !== 1 ? "s" : ""}` : "";
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      showAuth("Token rejected. Enter a valid viewer token.");
      return;
    }
    // otherwise silently ignore – table stays as-is
  }
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

  const rows = sortFlights(_flights, _sortCol, _sortDir);

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
    const type      = flight.aircraft_type || "";
    const aircraft  = flight.aircraft_registration || "";
    const title     = flight.aircraft_title || "";

    tr.innerHTML = `
      <td>
        <span class="date-date">${date}</span>
        <span class="date-time">${time}</span>
      </td>
      <td>
        ${type ? `<span class="aircraft-type">${escHtml(type)}</span>` : ""}
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
    const res = await apiFetch(`/api/flights/${id}`, { method: "DELETE" });
    if (res.ok) {
      _flights = _flights.filter(f => String(f.id) !== id);
      renderTable();
      const total = _flights.length;
      document.getElementById("flight-count").textContent =
        total > 0 ? `${total} flight${total !== 1 ? "s" : ""}` : "";
    }
  } catch (err) {
    if (err instanceof UnauthorizedError) showAuth("Token rejected. Enter a valid viewer token.");
  }
});

// ---------------------------------------------------------------------------
// Export (CSV backup of every flight)
// ---------------------------------------------------------------------------

const DEFAULT_EXPORT_NAME = "pilot-logbook.csv";

function exportFilename(res) {
  const m = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "");
  return m ? m[1] : DEFAULT_EXPORT_NAME;
}

document.getElementById("btn-export").addEventListener("click", async e => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = "Exporting…";
  try {
    const res = await apiFetch("/api/flights/export.csv");
    if (!res.ok) throw new Error(res.status);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFilename(res);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (err) {
    if (err instanceof UnauthorizedError) showAuth("Token rejected. Enter a valid viewer token.");
    else alert("Export failed. Could not reach the server.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Export CSV";
  }
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
        <span class="detail-label">Type (ICAO)</span>
        <span class="detail-value">${escHtml(flight.aircraft_type || "—")}</span>
      </div>
      <div class="detail-cell detail-cell-wide">
        <span class="detail-label">Title</span>
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

document.getElementById("auth-form").addEventListener("submit", e => {
  e.preventDefault();
  const token = document.getElementById("auth-token").value.trim();
  if (!token) return;
  document.getElementById("auth-error").textContent = "";
  signIn(token);
});

if (getToken()) {
  hideAuth();
  startPolling();
} else {
  showAuth("");
}
