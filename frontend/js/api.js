/**
 * Viewer-token storage and the authenticated fetch wrapper.
 * The token is kept in localStorage and sent as a bearer token.
 */

export const TOKEN_KEY = "spl_viewer_token";

export class UnauthorizedError extends Error {}

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
export function setToken(token) {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* storage unavailable */ }
}
export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ }
}

/**
 * fetch() wrapper that adds the Authorization header.
 * Throws UnauthorizedError when no token is saved or the server answers 401.
 * @param {string} path
 * @param {RequestInit} [init]
 */
export async function apiFetch(path, init = {}) {
  const token = getToken();
  if (!token) throw new UnauthorizedError("no token");
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) throw new UnauthorizedError("rejected");
  return res;
}
