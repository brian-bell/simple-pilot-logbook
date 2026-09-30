/** Display formatting for flight values. */

/**
 * Format elapsed seconds as "2h 34m" or "45m 12s".
 * @param {number|null} secs
 */
export function fmtDuration(secs) {
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
export function fmtVS(fpm) {
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
export function fmtG(g) {
  if (g == null) return "—";
  return g.toFixed(2) + " G";
}

/**
 * Format a distance in nautical miles.
 * @param {number|null} nm
 */
export function fmtNm(nm) {
  if (nm == null) return "—";
  return nm.toFixed(1);
}

/**
 * Format altitude in feet.
 * @param {number|null} ft
 */
export function fmtAlt(ft) {
  if (ft == null) return "—";
  return Math.round(ft).toLocaleString() + " ft";
}

/**
 * Parse an ISO 8601 date string and return { date, time } display strings.
 * @param {string|null} iso
 */
export function fmtDate(iso) {
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
export function safe(s, fallback = "—") {
  return (s != null && s !== "") ? String(s) : fallback;
}

/**
 * Return ICAO or a shortened coordinate string.
 * @param {object} flight
 * @param {"departure"|"arrival"} which
 */
export function routeLabel(flight, which) {
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
