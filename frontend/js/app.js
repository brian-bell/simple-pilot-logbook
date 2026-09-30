/**
 * App component: owns the live status and renders the header and banner.
 * Sign-in, the table and the modals still live in main.js (Preact migration,
 * PR 2 of 4); main.js passes signedIn and the sign-out/401 callbacks in.
 */

import { useState, useEffect } from "preact/hooks";
import { html } from "./html.js";
import { apiFetch, UnauthorizedError } from "./api.js";
import { usePolling } from "./hooks.js";
import { Header, ActiveBanner } from "./components.js";

const STATUS_INTERVAL = 3_000; // ms between status polls
const OFFLINE_STATUS = { connected: false, state: "DISCONNECTED", current_flight: null, agent_seen_at: null };

export function App({ signedIn, onSignOut, onUnauthorized }) {
  const [status, setStatus] = useState(null);

  // Forget the last status on sign-in and sign-out, so the header shows "Connecting…" again.
  useEffect(() => setStatus(null), [signedIn]);

  async function pollStatus() {
    try {
      const res = await apiFetch("/api/status");
      if (!res.ok) throw new Error(res.status);
      setStatus(await res.json());
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized("Token rejected. Enter a valid viewer token.");
        return;
      }
      setStatus(OFFLINE_STATUS);
    }
  }

  usePolling(pollStatus, STATUS_INTERVAL, signedIn);

  return html`
    <${Header} signedIn=${signedIn} status=${status} onSignOut=${onSignOut} />
    <${ActiveBanner} status=${signedIn ? status : null} />
  `;
}
