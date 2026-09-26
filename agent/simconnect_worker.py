"""
SimConnect background worker.

Runs as a daemon thread, polling MSFS every 2 seconds.
Implements a simple state machine to detect takeoffs and landings and hands
the resulting events (flight.takeoff / flight.position / flight.landing) to
the `on_event` callback, which queues them for upload to the Worker.

States
------
DISCONNECTED  – SimConnect not available / MSFS not running
ON_GROUND     – Aircraft on ground (engines may be off)
AIRBORNE      – Aircraft in the air
"""

import threading
import time
import logging
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Callable

from airports import find_nearest_airport, haversine_nm
from events import decode_simvar_str, landing_event, position_event, takeoff_event

logger = logging.getLogger(__name__)

# -------------------------------------------------------------------
# Optional import – SimConnect only works on Windows with MSFS running
# -------------------------------------------------------------------
try:
    from SimConnect import SimConnect, AircraftRequests
    _SIMCONNECT_AVAILABLE = True
except (ImportError, OSError):
    _SIMCONNECT_AVAILABLE = False
    logger.warning(
        "SimConnect library not available (expected on non-Windows hosts). "
        "Worker will run in offline mode."
    )

# Minimum airborne duration (seconds) before a flight is recorded.
# Prevents spurious records from runway bumps or brief altitude spikes.
_MIN_FLIGHT_SECONDS = 30

# Trailing window of (timestamp, vertical_speed) samples used to capture
# peak descent rate just before touchdown.
_VS_WINDOW_SECONDS = 6

# Default interval between flight.position events while airborne.
_DEFAULT_POSITION_SECONDS = 10.0


class SimConnectWorker(threading.Thread):
    """
    Daemon thread that monitors MSFS via SimConnect and emits flight events.

    Parameters
    ----------
    on_event : callable(dict) or None
        Receives each event envelope (see events.py). Exceptions it raises are
        logged and never propagate into the polling loop.
    position_seconds : float
        Interval between flight.position events while airborne.

    Public attributes
    -----------------
    status : dict
        Snapshot of current state, safe to read from other threads.
        Keys: connected, state, current_flight (dict or None).
    """

    def __init__(
        self,
        on_event: Callable[[dict], None] | None = None,
        position_seconds: float = _DEFAULT_POSITION_SECONDS,
    ) -> None:
        super().__init__(daemon=True, name="simconnect-worker")
        self._stop_event = threading.Event()
        self._lock = threading.Lock()
        self._on_event = on_event
        self._position_seconds = float(position_seconds)
        self._last_position_emit = 0.0

        # Shared status dict read by the API
        self.status: dict = {
            "connected": False,
            "state": "DISCONNECTED",
            "current_flight": None,
        }

        # Internal flight tracking
        self._state = "DISCONNECTED"
        self._flight: dict = {}
        self._vs_window: deque = deque()  # (timestamp, vs_fpm) pairs

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def stop(self) -> None:
        self._stop_event.set()

    def get_status(self) -> dict:
        with self._lock:
            import copy
            return copy.deepcopy(self.status)

    # ------------------------------------------------------------------
    # Thread entry point
    # ------------------------------------------------------------------

    def run(self) -> None:
        if not _SIMCONNECT_AVAILABLE:
            logger.info("SimConnect unavailable – worker idle.")
            self._update_status("DISCONNECTED", connected=False)
            return

        while not self._stop_event.is_set():
            try:
                logger.info("Connecting to SimConnect…")
                sm = SimConnect()
                aq = AircraftRequests(sm, _time=2000)
                logger.info("SimConnect connected.")
                self._monitor_loop(sm, aq)
            except Exception as exc:
                logger.warning("SimConnect error: %s – retrying in 5 s", exc)
                self._update_status("DISCONNECTED", connected=False)
                self._stop_event.wait(5)

    # ------------------------------------------------------------------
    # Main polling loop
    # ------------------------------------------------------------------

    def _monitor_loop(self, sm, aq) -> None:
        """Poll SimConnect variables; update state machine."""
        self._state = "ON_GROUND"
        self._update_status("ON_GROUND", connected=True)

        while not self._stop_event.is_set():
            try:
                on_ground = aq.get("SIM_ON_GROUND")
                lat = aq.get("PLANE_LATITUDE")
                lon = aq.get("PLANE_LONGITUDE")
                alt = aq.get("PLANE_ALTITUDE")
                vs = aq.get("VERTICAL_SPEED")
                gs = aq.get("GPS_GROUND_SPEED")
                title = aq.get("TITLE")
                reg = aq.get("ATC_ID")
                gforce = aq.get("G_FORCE")
            except Exception as exc:
                logger.warning("SimConnect read error: %s", exc)
                raise  # bubble up to trigger reconnect

            # Null-guard — SimConnect returns None on timeout
            if on_ground is None:
                self._stop_event.wait(2)
                continue

            on_ground = bool(on_ground)
            now = time.monotonic()

            # Track vertical speed samples (for landing quality)
            if vs is not None:
                self._vs_window.append((now, float(vs)))
                # Prune old samples
                while self._vs_window and (now - self._vs_window[0][0]) > _VS_WINDOW_SECONDS:
                    self._vs_window.popleft()

            if self._state == "ON_GROUND" and not on_ground:
                self._handle_takeoff(lat, lon, alt, title, reg)

            elif self._state == "AIRBORNE":
                # Track max altitude
                if alt is not None:
                    self._flight["max_alt"] = max(
                        self._flight.get("max_alt", 0), float(alt)
                    )
                if not on_ground:
                    # Still flying — refresh live status
                    elapsed = int(time.time() - self._flight.get("takeoff_ts", time.time()))
                    with self._lock:
                        if self.status["current_flight"]:
                            self.status["current_flight"]["elapsed_seconds"] = elapsed
                            self.status["current_flight"]["altitude_ft"] = (
                                round(float(alt), 0) if alt is not None else None
                            )
                    # Periodic track point for the Worker
                    if now - self._last_position_emit >= self._position_seconds:
                        self._last_position_emit = now
                        self._emit(position_event(
                            self._flight.get("flight_uuid"), lat, lon, alt, vs, gs, elapsed,
                        ))
                else:
                    self._handle_landing(lat, lon, gforce)

            self._stop_event.wait(2)

    # ------------------------------------------------------------------
    # State handlers
    # ------------------------------------------------------------------

    def _handle_takeoff(
        self,
        lat, lon, alt, title, reg
    ) -> None:
        """Record departure data and transition to AIRBORNE."""
        logger.info("Takeoff detected at %.4f, %.4f", lat or 0, lon or 0)

        dep_airport = None
        if lat is not None and lon is not None:
            dep_airport = find_nearest_airport(float(lat), float(lon))

        self._flight = {
            "flight_uuid": str(uuid.uuid4()),
            "takeoff_ts": time.time(),
            "takeoff_wall": datetime.now(timezone.utc).isoformat(),
            "departure_lat": float(lat) if lat is not None else None,
            "departure_lon": float(lon) if lon is not None else None,
            "departure_icao": dep_airport["icao"] if dep_airport else None,
            "departure_name": dep_airport["name"] if dep_airport else None,
            # SimConnect returns bytes for string SimVars — decode, don't str()
            "aircraft_title": decode_simvar_str(title),
            "aircraft_registration": decode_simvar_str(reg),
            "max_alt": float(alt) if alt is not None else 0.0,
        }
        self._vs_window.clear()
        self._state = "AIRBORNE"
        # First flight.position follows one interval after the takeoff event.
        self._last_position_emit = time.monotonic()

        with self._lock:
            self.status["state"] = "AIRBORNE"
            self.status["current_flight"] = {
                "departure_icao": self._flight["departure_icao"],
                "departure_name": self._flight["departure_name"],
                "departure_lat": self._flight["departure_lat"],
                "departure_lon": self._flight["departure_lon"],
                "aircraft_title": self._flight["aircraft_title"],
                "aircraft_registration": self._flight["aircraft_registration"],
                "elapsed_seconds": 0,
                "altitude_ft": float(alt) if alt is not None else None,
            }

        self._emit(takeoff_event(self._flight))

    def _handle_landing(self, lat, lon, gforce) -> None:
        """Record arrival data, persist flight, transition to ON_GROUND."""
        elapsed = int(time.time() - self._flight.get("takeoff_ts", time.time()))
        logger.info("Landing detected – flight duration %d s", elapsed)

        if elapsed < _MIN_FLIGHT_SECONDS:
            logger.info("Flight too short (%d s) – discarding.", elapsed)
            self._state = "ON_GROUND"
            self._update_status("ON_GROUND", connected=True, current_flight=None)
            return

        arr_airport = None
        if lat is not None and lon is not None:
            arr_airport = find_nearest_airport(float(lat), float(lon))

        # Peak descent rate from the trailing window (most negative VS)
        landing_vs = None
        if self._vs_window:
            landing_vs = min(v for _, v in self._vs_window)

        # Straight-line distance
        dep_lat = self._flight.get("departure_lat")
        dep_lon = self._flight.get("departure_lon")
        arr_lat = float(lat) if lat is not None else None
        arr_lon = float(lon) if lon is not None else None
        distance_nm = None
        if None not in (dep_lat, dep_lon, arr_lat, arr_lon):
            distance_nm = round(haversine_nm(dep_lat, dep_lon, arr_lat, arr_lon), 1)

        flight_data = {
            "date": self._flight.get("takeoff_wall", datetime.now(timezone.utc).isoformat()),
            "aircraft_title": self._flight.get("aircraft_title"),
            "aircraft_registration": self._flight.get("aircraft_registration"),
            "departure_icao": self._flight.get("departure_icao"),
            "departure_name": self._flight.get("departure_name"),
            "departure_lat": dep_lat,
            "departure_lon": dep_lon,
            "arrival_icao": arr_airport["icao"] if arr_airport else None,
            "arrival_name": arr_airport["name"] if arr_airport else None,
            "arrival_lat": arr_lat,
            "arrival_lon": arr_lon,
            "distance_nm": distance_nm,
            "elapsed_seconds": elapsed,
            "max_altitude_ft": round(self._flight.get("max_alt", 0), 0),
            "landing_vs_fpm": round(landing_vs, 1) if landing_vs is not None else None,
            "landing_g_force": round(float(gforce), 2) if gforce is not None else None,
            "notes": None,
        }

        flight_data["flight_uuid"] = self._flight.get("flight_uuid")
        self._emit(landing_event(flight_data))
        logger.info(
            "Flight %s -> %s (%d s) queued for upload.",
            flight_data["departure_icao"] or "?",
            flight_data["arrival_icao"] or "?",
            elapsed,
        )

        self._flight = {}
        self._vs_window.clear()
        self._state = "ON_GROUND"
        self._update_status("ON_GROUND", connected=True, current_flight=None)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _emit(self, event: dict) -> None:
        """Hand an event to the outbox; a queuing problem must never kill the poller."""
        if self._on_event is None:
            return
        try:
            self._on_event(event)
        except Exception:
            logger.exception("Failed to queue %s event", event.get("type"))

    def _update_status(
        self,
        state: str,
        connected: bool,
        current_flight: dict | None = None,
    ) -> None:
        with self._lock:
            self.status["state"] = state
            self.status["connected"] = connected
            self.status["current_flight"] = current_flight
