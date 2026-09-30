/**
 * Preact components: the app shell (header, status indicator, live-flight banner)
 * and the logbook (toolbar, flight table, detail modal).
 */

import { useEffect } from "preact/hooks";
import { html } from "./html.js";
import { fmtDuration, fmtVS, fmtG, fmtNm, fmtAlt, fmtDate, routeLabel } from "./format.js";

/** True when the agent has heartbeated within the last minute. */
function agentRecentlySeen(agentSeenAt) {
  if (!agentSeenAt) return false;
  const seen = Date.parse(agentSeenAt);
  return !isNaN(seen) && (Date.now() - seen) < 60_000;
}

/**
 * Map a /api/status payload to the dot modifier class and label.
 * status is null before the first poll answers.
 */
function statusView(signedIn, status) {
  if (!signedIn) return { cls: "disconnected", label: "Signed out" };
  if (!status) return { cls: "", label: "Connecting…" };
  const { connected, state, on_ground, paused, agent_seen_at } = status;
  if (connected && paused)   return { cls: "paused",    label: "Paused" };
  if (state === "AIRBORNE")  return { cls: "airborne",  label: "In Flight" };
  if (connected && on_ground) return { cls: "on-ground", label: "On Ground" };
  if (connected)             return { cls: "connected", label: "Connected" };
  // Agent heartbeating but MSFS closed → "Disconnected"; no agent at all → "Agent offline".
  return { cls: "disconnected", label: agentRecentlySeen(agent_seen_at) ? "Disconnected" : "Agent offline" };
}

export function StatusDot({ cls }) {
  return html`<span class=${cls ? `status-dot ${cls}` : "status-dot"} id="status-dot"></span>`;
}

export function Header({ signedIn, status, onSignOut }) {
  const { cls, label } = statusView(signedIn, status);
  return html`
    <header class="app-header">
      <div class="header-left">
        <span class="header-icon">✈</span>
        <h1>Pilot Logbook</h1>
      </div>
      <div class="header-right">
        <button class=${signedIn ? "btn-signout" : "btn-signout hidden"} id="btn-signout" type="button"
                title="Forget the saved viewer token" onClick=${onSignOut}>Sign out</button>
        <span class="status-label" id="status-label">${label}</span>
        <${StatusDot} cls=${cls} />
      </div>
    </header>
  `;
}

/** Live-flight strip, shown only while airborne with a current flight. */
export function ActiveBanner({ status }) {
  const cf = status?.state === "AIRBORNE" ? status.current_flight : null;
  if (!cf) return html`<div class="active-banner hidden" id="active-banner"></div>`;

  const reg = cf.aircraft_registration || cf.aircraft_title?.split(" ").slice(0, 3).join(" ");
  const aircraft = [cf.aircraft_type, reg].filter(Boolean).join(" · ") || "—";
  const alt = cf.altitude_ft != null ? Math.round(cf.altitude_ft).toLocaleString() : "—";

  return html`
    <div class="active-banner" id="active-banner">
      <div class="banner-row">
        <span class="banner-segment">
          <span class="banner-key">From</span>
          <strong id="b-dep">${cf.departure_icao || "—"}</strong>
        </span>
        <span class="banner-arrow">➔</span>
        <span class="banner-segment">
          <span class="banner-key">Aircraft</span>
          <strong id="b-aircraft">${aircraft}</strong>
        </span>
        <span class="banner-segment">
          <span class="banner-key">Altitude</span>
          <strong id="b-alt">${alt}</strong>
          <span class="banner-unit">ft</span>
        </span>
        <span class="banner-segment">
          <span class="banner-key">Elapsed</span>
          <strong id="b-elapsed">${fmtDuration(cf.elapsed_seconds)}</strong>
        </span>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Logbook
// ---------------------------------------------------------------------------

/** Toolbar above the table: title, flight count and the CSV export button. */
export function Toolbar({ total, onExport }) {
  return html`
    <div class="toolbar">
      <span class="toolbar-title">Flight Log</span>
      <span class="flight-count" id="flight-count">${total > 0 ? `${total} flight${total !== 1 ? "s" : ""}` : ""}</span>
      <button class="btn-export" id="btn-export" type="button" title="Download every flight as a CSV file"
              onClick=${onExport}>Export CSV</button>
    </div>
  `;
}

/** Sortable columns, in display order; col is the key sortFlights understands. */
const COLUMNS = [
  { col: "date",        label: "Date" },
  { col: "aircraft",    label: "Aircraft" },
  { col: "from",        label: "From" },
  { col: "to",          label: "To" },
  { col: "distance_nm", label: "Dist (nm)", num: true },
  { col: "elapsed",     label: "Duration",  num: true },
  { col: "max_alt",     label: "Max Alt",   num: true },
  { col: "landing_vs",  label: "Ldg VS",    num: true },
  { col: "landing_g",   label: "Ldg G",     num: true },
];

function headerClass({ col, num }, sort) {
  const cls = ["sortable"];
  if (num) cls.push("num");
  if (sort.col === col) cls.push(sort.dir === "asc" ? "sort-asc" : "sort-desc");
  return cls.join(" ");
}

/** The logbook table, or the empty state when there are no flights. rows are already sorted. */
export function FlightTable({ rows, sort, onSort, onSelect, onDelete }) {
  return html`
    <div class="table-wrapper">
      <table class=${rows.length === 0 ? "logbook-table hidden" : "logbook-table"} id="logbook-table">
        <thead>
          <tr>
            ${COLUMNS.map(c => html`
              <th key=${c.col} data-col=${c.col} class=${headerClass(c, sort)} onClick=${() => onSort(c.col)}>
                ${c.label} <span class="sort-icon"></span>
              </th>
            `)}
            <th class="actions-col"></th>
          </tr>
        </thead>
        <tbody id="flight-rows">
          ${rows.map(f => html`<${FlightRow} key=${f.id} flight=${f} onSelect=${onSelect} onDelete=${onDelete} />`)}
        </tbody>
      </table>
    </div>

    <div class=${rows.length === 0 ? "empty-state" : "empty-state hidden"} id="empty-state">
      <span class="empty-icon">✈</span>
      <p>No flights recorded yet.</p>
      <p class="empty-sub">Flights are automatically captured from Microsoft Flight Simulator via SimConnect.</p>
    </div>
  `;
}

export function FlightRow({ flight, onSelect, onDelete }) {
  const { date, time } = fmtDate(flight.date);
  const vs    = fmtVS(flight.landing_vs_fpm);
  const type  = flight.aircraft_type || "";
  const reg   = flight.aircraft_registration || "";
  const title = flight.aircraft_title || "";

  function handleDelete(e) {
    e.stopPropagation(); // the row click would open the detail modal
    onDelete(flight.id);
  }

  return html`
    <tr data-id=${flight.id} onClick=${() => onSelect(flight)}>
      <td>
        <span class="date-date">${date}</span>
        <span class="date-time">${time}</span>
      </td>
      <td>
        ${type && html`<span class="aircraft-type">${type}</span>`}
        ${reg && html`<span class="aircraft-reg">${reg}</span>`}
        <span class="aircraft-title" title=${title}>${title || "—"}</span>
      </td>
      <td><span class="route-from">${routeLabel(flight, "departure")}</span></td>
      <td><span class="route-to">${routeLabel(flight, "arrival")}</span></td>
      <td class="num hide-sm">${fmtNm(flight.distance_nm)}</td>
      <td class="num">${fmtDuration(flight.elapsed_seconds)}</td>
      <td class="num hide-md">${fmtAlt(flight.max_altitude_ft)}</td>
      <td class="num"><span class=${vs.cls}>${vs.text}</span></td>
      <td class="num hide-md">${fmtG(flight.landing_g_force)}</td>
      <td class="actions-col">
        <button class="btn-delete" data-id=${flight.id} title="Delete this flight" onClick=${handleDelete}>✕</button>
      </td>
    </tr>
  `;
}

function DetailCell({ label, value, cls = "", wide = false }) {
  return html`
    <div class=${wide ? "detail-cell detail-cell-wide" : "detail-cell"}>
      <span class="detail-label">${label}</span>
      <span class=${cls ? `detail-value ${cls}` : "detail-value"}>${value}</span>
    </div>
  `;
}

/** Flight detail modal; overlay click, the close button and Escape all close it. */
export function FlightModal({ flight, onClose }) {
  useEffect(() => {
    const onKey = e => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const dep = routeLabel(flight, "departure");
  const arr = routeLabel(flight, "arrival");
  const vs = fmtVS(flight.landing_vs_fpm);
  const { date, time } = fmtDate(flight.date);

  return html`
    <div class="modal-overlay" id="modal-overlay" role="dialog" aria-modal="true"
         onClick=${e => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title" id="modal-title">${dep} → ${arr}</span>
          <button class="modal-close" id="modal-close" aria-label="Close" onClick=${onClose}>×</button>
        </div>
        <div class="modal-body" id="modal-body">
          <p class="detail-section">Route</p>
          <div class="detail-grid">
            <${DetailCell} label="Departure" value=${flight.departure_icao || "—"} />
            <${DetailCell} label="Arrival" value=${flight.arrival_icao || "—"} />
            <${DetailCell} label="Dep. Name" value=${flight.departure_name || "—"} />
            <${DetailCell} label="Arr. Name" value=${flight.arrival_name || "—"} />
            <${DetailCell} label="Distance" value=${`${fmtNm(flight.distance_nm)} nm`} />
            <${DetailCell} label="Duration" value=${fmtDuration(flight.elapsed_seconds)} />
          </div>

          <p class="detail-section">Aircraft</p>
          <div class="detail-grid">
            <${DetailCell} label="Registration" value=${flight.aircraft_registration || "—"} />
            <${DetailCell} label="Type (ICAO)" value=${flight.aircraft_type || "—"} />
            <${DetailCell} label="Title" value=${flight.aircraft_title || "—"} wide />
          </div>

          <p class="detail-section">Performance</p>
          <div class="detail-grid">
            <${DetailCell} label="Max Altitude" value=${fmtAlt(flight.max_altitude_ft)} />
            <${DetailCell} label="Landing VS" value=${vs.text} cls=${vs.cls} />
            <${DetailCell} label="Landing G-Force" value=${fmtG(flight.landing_g_force)} />
            <${DetailCell} label="Date / Time" value=${`${date} ${time}`} />
          </div>

          ${flight.notes && html`
            <p class="detail-section">Notes</p>
            <div class="detail-grid">
              <div class="detail-cell" style="grid-column:1/-1">
                <span class="detail-value">${flight.notes}</span>
              </div>
            </div>
          `}
        </div>
      </div>
    </div>
  `;
}
