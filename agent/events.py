"""
Event envelopes sent to the Worker, plus string helpers for SimVar values.

Envelope: {"id": <uuid>, "type": <str>, "ts": <ISO UTC>, "payload": {...}}

The id is generated client-side so the Worker can de-duplicate retries.
Legacy imports use a deterministic uuid5 so re-running the import is a no-op.
"""

from __future__ import annotations

import ast
import re
import uuid
from datetime import datetime, timezone
from typing import Any

# The 17 logbook columns, same order as the Worker's FLIGHT_FIELDS.
FLIGHT_FIELDS = (
    "date",
    "aircraft_title",
    "aircraft_registration",
    "departure_icao",
    "departure_name",
    "departure_lat",
    "departure_lon",
    "arrival_icao",
    "arrival_name",
    "arrival_lat",
    "arrival_lon",
    "distance_nm",
    "elapsed_seconds",
    "max_altitude_ft",
    "landing_vs_fpm",
    "landing_g_force",
    "notes",
)

_LEGACY_NAMESPACE = uuid.NAMESPACE_URL
_BYTES_REPR_RE = re.compile(r"""^b(['"])(.*)\1$""", re.DOTALL)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def make_event(event_type: str, payload: dict[str, Any], event_id: str | None = None) -> dict[str, Any]:
    return {
        "id": event_id or str(uuid.uuid4()),
        "type": event_type,
        "ts": utc_now_iso(),
        "payload": payload,
    }


# ---------------------------------------------------------------------------
# String helpers
# ---------------------------------------------------------------------------


def decode_simvar_str(value: Any) -> str | None:
    """
    SimConnect returns *bytes* for string SimVars (TITLE, ATC_ID).
    Decode them, drop NULs and whitespace, and return None for empty values.
    """
    if value is None:
        return None
    if isinstance(value, (bytes, bytearray)):
        text = bytes(value).decode("utf-8", errors="replace")
    else:
        text = str(value)
    text = text.replace("\x00", "").strip()
    return text or None


def clean_legacy_str(value: Any) -> str | None:
    """
    Undo the old ``str(bytes)`` bug in stored records:
    ``"b'C750 Winglets - Livery 1'"`` -> ``"C750 Winglets - Livery 1"``.
    Values that are not a bytes repr pass through unchanged (trimmed).
    """
    if value is None:
        return None
    text = str(value).strip()
    match = _BYTES_REPR_RE.match(text)
    if match:
        try:
            literal = ast.literal_eval(text)
            if isinstance(literal, (bytes, bytearray)):
                text = bytes(literal).decode("utf-8", errors="replace")
            else:
                text = str(literal)
        except (ValueError, SyntaxError):
            text = match.group(2)
    text = text.replace("\x00", "").strip()
    return text or None


# ---------------------------------------------------------------------------
# Event builders
# ---------------------------------------------------------------------------


def heartbeat_event(status: dict[str, Any], outbox_pending: int) -> dict[str, Any]:
    """`status` is SimConnectWorker.get_status(): {connected, state, current_flight}."""
    return make_event(
        "agent.heartbeat",
        {
            "connected": bool(status.get("connected")),
            "state": str(status.get("state") or "DISCONNECTED"),
            "current_flight": status.get("current_flight"),
            "outbox_pending": int(outbox_pending),
        },
    )


def takeoff_event(flight: dict[str, Any]) -> dict[str, Any]:
    """The takeoff event's id doubles as the flight_uuid shared by positions and the landing."""
    return make_event(
        "flight.takeoff",
        {
            "flight_uuid": flight["flight_uuid"],
            "takeoff_ts": flight.get("takeoff_wall"),
            "departure_icao": flight.get("departure_icao"),
            "departure_name": flight.get("departure_name"),
            "departure_lat": flight.get("departure_lat"),
            "departure_lon": flight.get("departure_lon"),
            "aircraft_title": flight.get("aircraft_title"),
            "aircraft_registration": flight.get("aircraft_registration"),
            "altitude_ft": flight.get("max_alt"),
        },
        event_id=flight["flight_uuid"],
    )


def position_event(
    flight_uuid: str | None,
    lat: Any,
    lon: Any,
    altitude_ft: Any,
    vs_fpm: Any,
    ground_speed_kt: Any,
    elapsed_seconds: int,
) -> dict[str, Any]:
    return make_event(
        "flight.position",
        {
            "flight_uuid": flight_uuid,
            "lat": _num(lat),
            "lon": _num(lon),
            "altitude_ft": _num(altitude_ft, 0),
            "vs_fpm": _num(vs_fpm, 0),
            "ground_speed_kt": _num(ground_speed_kt, 1),
            "elapsed_seconds": int(elapsed_seconds),
        },
    )


def landing_event(flight_data: dict[str, Any]) -> dict[str, Any]:
    """`flight_data` is the 17-field record built by SimConnectWorker plus flight_uuid."""
    return make_event("flight.landing", dict(flight_data))


def legacy_import_event(row: dict[str, Any]) -> dict[str, Any]:
    """Build a flight.import event from a (cleaned) row of the old SQLite flights table."""
    payload: dict[str, Any] = {field: row.get(field) for field in FLIGHT_FIELDS}
    payload["legacy_id"] = row.get("id")
    payload["legacy_created_at"] = row.get("created_at")

    event = make_event(
        "flight.import",
        payload,
        event_id=str(uuid.uuid5(_LEGACY_NAMESPACE, f"simple-pilot-logbook:legacy-flight:{row.get('id')}")),
    )
    if row.get("created_at"):
        event["ts"] = str(row["created_at"])
    return event


def _num(value: Any, ndigits: int | None = None) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return round(number, ndigits) if ndigits is not None else number
