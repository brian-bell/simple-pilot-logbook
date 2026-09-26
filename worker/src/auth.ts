/**
 * Bearer-token authentication.
 *
 * Two roles, two secrets, no cross-acceptance:
 *   AGENT_TOKEN  -> POST /api/events
 *   VIEWER_TOKEN -> everything else under /api
 *
 * Tokens are compared in constant time by hashing both sides with SHA-256 and
 * comparing the fixed-length digests, which side-steps timingSafeEqual's
 * equal-length requirement. An unset secret always fails, so a deploy that
 * forgot `wrangler secret put` cannot accidentally be open.
 */

import { json } from "./types";

const BEARER_RE = /^Bearer\s+(.+)$/i;

export async function bearerMatches(request: Request, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;

  const header = (request.headers.get("authorization") ?? "").trim();
  const match = BEARER_RE.exec(header);
  if (!match) return false;

  const presented = match[1].trim();
  if (!presented) return false;

  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(presented)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401, {
    "www-authenticate": 'Bearer realm="logbook"',
  });
}
