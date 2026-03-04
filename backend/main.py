"""
Simple Pilot Logbook – FastAPI backend.

Serves both the REST API (/api/*) and the static frontend.
Run from the backend/ directory:

    uvicorn main:app --host 0.0.0.0 --port 8080 --reload
"""

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from database import init_db, insert_flight, get_flights, get_flight, delete_flight, get_flight_count
from simconnect_worker import SimConnectWorker

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(name)s  %(message)s",
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Application lifespan – start/stop the SimConnect worker thread
# ---------------------------------------------------------------------------

_worker = SimConnectWorker()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    logger.info("Database initialised.")
    _worker.start()
    logger.info("SimConnect worker started.")
    yield
    _worker.stop()
    logger.info("SimConnect worker stopped.")


# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Simple Pilot Logbook",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class FlightCreate(BaseModel):
    date: str
    aircraft_title: Optional[str] = None
    aircraft_registration: Optional[str] = None
    departure_icao: Optional[str] = None
    departure_name: Optional[str] = None
    departure_lat: Optional[float] = None
    departure_lon: Optional[float] = None
    arrival_icao: Optional[str] = None
    arrival_name: Optional[str] = None
    arrival_lat: Optional[float] = None
    arrival_lon: Optional[float] = None
    distance_nm: Optional[float] = None
    elapsed_seconds: Optional[int] = None
    max_altitude_ft: Optional[float] = None
    landing_vs_fpm: Optional[float] = None
    landing_g_force: Optional[float] = None
    notes: Optional[str] = None


# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------


@app.get("/api/status")
def api_status():
    """Return SimConnect connection status and current flight data if airborne."""
    return _worker.get_status()


@app.get("/api/flights")
def api_list_flights(limit: int = 100, offset: int = 0):
    """Return a paginated list of logged flights, newest first."""
    return {
        "flights": get_flights(limit, offset),
        "total": get_flight_count(),
        "limit": limit,
        "offset": offset,
    }


@app.get("/api/flights/{flight_id}")
def api_get_flight(flight_id: int):
    """Return a single flight by ID."""
    flight = get_flight(flight_id)
    if flight is None:
        raise HTTPException(status_code=404, detail="Flight not found")
    return flight


@app.delete("/api/flights/{flight_id}")
def api_delete_flight(flight_id: int):
    """Delete a flight entry."""
    if not delete_flight(flight_id):
        raise HTTPException(status_code=404, detail="Flight not found")
    return {"deleted": flight_id}


@app.post("/api/flights", status_code=201)
def api_create_flight(data: FlightCreate):
    """Manually add a flight (useful for testing or back-filling the logbook)."""
    fid = insert_flight(data.model_dump())
    return {"id": fid}


# ---------------------------------------------------------------------------
# Static frontend – mount last so API routes take priority
# ---------------------------------------------------------------------------

_frontend_build = Path(__file__).parent.parent / "frontend" / "dist" / "client"
_frontend_dir = Path(__file__).parent.parent / "frontend"

if _frontend_build.exists():
    app.mount("/", StaticFiles(directory=str(_frontend_build), html=True), name="static")
elif _frontend_dir.exists():
    app.mount("/", StaticFiles(directory=str(_frontend_dir), html=True), name="static")
else:
    logger.warning("frontend/ directory not found – static files will not be served.")
