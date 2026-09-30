/** Logbook table sorting. */

/**
 * Return a sorted copy of flights.
 * @param {object[]} flights
 * @param {string} col
 * @param {"asc"|"desc"} sortDir
 */
export function sortFlights(flights, col, sortDir) {
  const dir = sortDir === "asc" ? 1 : -1;

  return [...flights].sort((a, b) => {
    let va, vb;
    switch (col) {
      case "date":        va = a.date || ""; vb = b.date || ""; break;
      case "aircraft":    va = aircraftSortKey(a); vb = aircraftSortKey(b); break;
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

/** Sort by ICAO type first, so all C172s group together; older flights without one fall back as before. */
export function aircraftSortKey(f) {
  return [f.aircraft_type, f.aircraft_registration || f.aircraft_title].filter(Boolean).join(" ");
}
