"""
Airport lookup utilities.

Loads the bundled airports.json (mwgg/Airports dataset) once at first use,
then provides nearest-airport lookup via the haversine formula.
"""

import json
import math
from pathlib import Path
from typing import Optional

_AIRPORTS: dict | None = None
_DATA_FILE = Path(__file__).parent / "data" / "airports.json"

# Earth radius in nautical miles
_R_NM = 3440.065


def _load() -> dict:
    global _AIRPORTS
    if _AIRPORTS is None:
        if _DATA_FILE.exists():
            with open(_DATA_FILE, encoding="utf-8") as f:
                _AIRPORTS = json.load(f)
        else:
            _AIRPORTS = {}
    return _AIRPORTS


def haversine_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Return great-circle distance in nautical miles between two lat/lon points."""
    lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * _R_NM * math.asin(math.sqrt(a))


def find_nearest_airport(
    lat: float,
    lon: float,
    max_nm: float = 10.0,
) -> Optional[dict]:
    """
    Return the nearest airport within *max_nm* nautical miles, or None.

    Returned dict: {"icao", "name", "city", "country", "lat", "lon", "distance_nm"}
    """
    airports = _load()
    best: Optional[dict] = None
    best_dist = max_nm

    for icao, ap in airports.items():
        ap_lat = ap.get("lat")
        ap_lon = ap.get("lon")
        if ap_lat is None or ap_lon is None:
            continue
        d = haversine_nm(lat, lon, ap_lat, ap_lon)
        if d < best_dist:
            best_dist = d
            best = {
                "icao": icao,
                "name": ap.get("name", ""),
                "city": ap.get("city", ""),
                "country": ap.get("country", ""),
                "lat": ap_lat,
                "lon": ap_lon,
                "distance_nm": round(d, 2),
            }

    return best


def airport_label(lat: float | None, lon: float | None, icao: str | None = None) -> str:
    """
    Return a human-readable label for a position.
    Prefers ICAO code; falls back to 'N00.00 E000.00' coordinate format.
    """
    if icao:
        return icao
    if lat is not None and lon is not None:
        ns = "N" if lat >= 0 else "S"
        ew = "E" if lon >= 0 else "W"
        return f"{ns}{abs(lat):.2f} {ew}{abs(lon):.2f}"
    return "Unknown"
