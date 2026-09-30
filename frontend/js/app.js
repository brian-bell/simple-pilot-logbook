/**
 * App component: owns the live status, the logbook (flights, total, sort,
 * selected flight) and renders the header, banner, table and detail modal.
 * Sign-in and CSV export still live in main.js (Preact migration, PR 3 of 4);
 * main.js passes signedIn and the sign-out/401/export callbacks in.
 */

import { useState, useEffect, useMemo, useCallback } from "preact/hooks";
import { html } from "./html.js";
import { apiFetch, UnauthorizedError } from "./api.js";
import { usePolling } from "./hooks.js";
import { sortFlights } from "./sort.js";
import { Header, ActiveBanner, Toolbar, FlightTable, FlightModal } from "./components.js";

const STATUS_INTERVAL = 3_000;   // ms between status polls
const FLIGHTS_INTERVAL = 10_000; // ms between logbook refreshes
const FLIGHTS_PAGE_SIZE = 500;   // the Worker returns at most 500 flights per page
const OFFLINE_STATUS = { connected: false, state: "DISCONNECTED", current_flight: null, agent_seen_at: null };
const EMPTY_LOGBOOK = { flights: [], total: 0 };
const TOKEN_REJECTED = "Token rejected. Enter a valid viewer token.";

export function App({ signedIn, onSignOut, onUnauthorized, onExport }) {
  const [status, setStatus] = useState(null);
  const [logbook, setLogbook] = useState(EMPTY_LOGBOOK);
  const [sort, setSort] = useState({ col: "date", dir: "desc" });
  const [selected, setSelected] = useState(null);

  // Forget the last status on sign-in and sign-out, so the header shows "Connecting…" again.
  useEffect(() => setStatus(null), [signedIn]);

  // Drop the logbook when signed out; it reloads on the next sign-in.
  useEffect(() => {
    if (signedIn) return;
    setLogbook(EMPTY_LOGBOOK);
    setSelected(null);
  }, [signedIn]);

  async function pollStatus() {
    try {
      const res = await apiFetch("/api/status");
      if (!res.ok) throw new Error(res.status);
      setStatus(await res.json());
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized(TOKEN_REJECTED);
        return;
      }
      setStatus(OFFLINE_STATUS);
    }
  }

  /** Load every flight, paging through /api/flights. */
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
      setLogbook({ flights, total });
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(TOKEN_REJECTED);
      // otherwise silently ignore – table stays as-is
    }
  }

  usePolling(pollStatus, STATUS_INTERVAL, signedIn);
  usePolling(loadFlights, FLIGHTS_INTERVAL, signedIn);

  const handleSort = useCallback(col => {
    setSort(s => s.col === col
      ? { col, dir: s.dir === "asc" ? "desc" : "asc" }
      : { col, dir: col === "date" ? "desc" : "asc" });
  }, []);

  const handleDelete = useCallback(async id => {
    if (!confirm("Delete this flight entry?")) return;
    try {
      const res = await apiFetch(`/api/flights/${id}`, { method: "DELETE" });
      if (!res.ok) return;
      setLogbook(lb => {
        const flights = lb.flights.filter(f => f.id !== id);
        return { flights, total: flights.length };
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(TOKEN_REJECTED);
    }
  }, [onUnauthorized]);

  const closeModal = useCallback(() => setSelected(null), []);

  // Reuse the same table vnode while flights and sort are unchanged, so Preact
  // skips re-rendering every row on each 3-second status poll.
  const table = useMemo(() => html`
    <${FlightTable} rows=${sortFlights(logbook.flights, sort.col, sort.dir)} sort=${sort}
                    onSort=${handleSort} onSelect=${setSelected} onDelete=${handleDelete} />
  `, [logbook.flights, sort, handleSort, handleDelete]);

  return html`
    <${Header} signedIn=${signedIn} status=${status} onSignOut=${onSignOut} />
    <${ActiveBanner} status=${signedIn ? status : null} />
    <main class="main-content">
      <${Toolbar} total=${logbook.total} onExport=${onExport} />
      ${table}
    </main>
    ${selected && html`<${FlightModal} flight=${selected} onClose=${closeModal} />`}
  `;
}
