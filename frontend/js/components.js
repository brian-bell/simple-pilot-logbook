/** Preact components for the app shell: header, status indicator and live-flight banner. */

import { html } from "./html.js";
import { fmtDuration } from "./format.js";

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
