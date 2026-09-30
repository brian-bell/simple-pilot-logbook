/**
 * Simple Pilot Logbook — Frontend
 *
 * The header, status, live-flight banner, logbook table and detail modal are
 * Preact components (app.js polls /api/status every 3 s and /api/flights every
 * 10 s while signed in). The sign-in overlay and CSV export are still vanilla
 * DOM code here until the last migration PR.
 * Every /api call carries a bearer token (the "viewer token") that is kept in
 * localStorage; a 401 brings up the sign-in overlay and pauses polling.
 */

import { render } from "preact";
import { html } from "./html.js";
import { App } from "./app.js";
import { UnauthorizedError, getToken, setToken, clearToken, apiFetch } from "./api.js";

// ---------------------------------------------------------------------------
// Auth – sign-in overlay (token storage lives in api.js)
// ---------------------------------------------------------------------------

/** Show the sign-in overlay; rendering <App> signed out stops both polls. */
function showAuth(message) {
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

/** Render the Preact app; it polls status and flights while signed in. */
function renderShell(signedIn) {
  render(html`<${App} signedIn=${signedIn} onSignOut=${signOut} onUnauthorized=${showAuth}
                      onExport=${exportCsv} />`,
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
}

function signOut() {
  clearToken();
  showAuth("");
}


// ---------------------------------------------------------------------------
// Export (CSV backup of every flight)
// ---------------------------------------------------------------------------

const DEFAULT_EXPORT_NAME = "pilot-logbook.csv";

function exportFilename(res) {
  const m = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "");
  return m ? m[1] : DEFAULT_EXPORT_NAME;
}

/** Click handler for the toolbar's Export CSV button (rendered by <App>). */
async function exportCsv(e) {
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
}

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
} else {
  showAuth("");
}
