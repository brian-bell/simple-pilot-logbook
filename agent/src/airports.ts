/**
 * Airport lookup: the bundled data/airports.json (mwgg/Airports dataset) is
 * loaded once on first use; nearest-airport search uses the haversine formula.
 */

import fs from "node:fs";
import path from "node:path";
import { AGENT_DIR } from "./config.js";

interface AirportRow {
  name?: string;
  city?: string;
  country?: string;
  lat?: number;
  lon?: number;
}

export interface NearestAirport {
  icao: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  distance_nm: number;
}

const DATA_FILE = path.join(AGENT_DIR, "data", "airports.json");
/** Earth radius in nautical miles. */
const R_NM = 3440.065;

let airports: Array<[string, AirportRow]> | null = null;

function load(): Array<[string, AirportRow]> {
  if (airports === null) {
    try {
      airports = Object.entries(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) as Record<string, AirportRow>);
    } catch {
      airports = [];
    }
  }
  return airports;
}

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in nautical miles. */
export function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Nearest airport within `maxNm` nautical miles, or null. */
export function findNearestAirport(lat: number, lon: number, maxNm = 10): NearestAirport | null {
  let best: NearestAirport | null = null;
  let bestDist = maxNm;
  for (const [icao, ap] of load()) {
    if (typeof ap.lat !== "number" || typeof ap.lon !== "number") continue;
    const d = haversineNm(lat, lon, ap.lat, ap.lon);
    if (d < bestDist) {
      bestDist = d;
      best = {
        icao,
        name: ap.name ?? "",
        city: ap.city ?? "",
        country: ap.country ?? "",
        lat: ap.lat,
        lon: ap.lon,
        distance_nm: Math.round(d * 100) / 100,
      };
    }
  }
  return best;
}
