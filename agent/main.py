"""
Simple Pilot Logbook – local agent entry point.

Watches MSFS through SimConnect (SimConnectWorker), queues flight events in a
local SQLite outbox, and ships them to the Cloudflare Worker (Sender). A
heartbeat carrying the live status goes out every HEARTBEAT_SECONDS.

    python main.py             # run in the foreground, Ctrl+C to stop
    python windows_service.py  # run as a Windows service (see docs/service-install.md)

Configuration lives in agent/.env — see .env.example.
"""

from __future__ import annotations

import logging
import logging.handlers
import signal
import sys
import threading
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parent
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from config import Config, load_config  # noqa: E402
from events import heartbeat_event  # noqa: E402
from outbox import Outbox  # noqa: E402
from sender import Sender  # noqa: E402
from simconnect_worker import SimConnectWorker  # noqa: E402

logger = logging.getLogger("agent")

_LOG_FORMAT = "%(asctime)s  %(levelname)-7s  %(name)s  %(message)s"


def setup_logging(log_path: Path) -> None:
    """Rotating file log (1 MB x 3) plus stderr when a console is attached."""
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    formatter = logging.Formatter(_LOG_FORMAT)

    if not any(isinstance(h, logging.handlers.RotatingFileHandler) for h in root.handlers):
        log_path.parent.mkdir(parents=True, exist_ok=True)
        file_handler = logging.handlers.RotatingFileHandler(
            log_path, maxBytes=1_000_000, backupCount=3, encoding="utf-8"
        )
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)

    # Under pythonservice.exe there is no console and sys.stderr is None.
    has_stream = any(
        isinstance(h, logging.StreamHandler) and not isinstance(h, logging.FileHandler)
        for h in root.handlers
    )
    if sys.stderr is not None and not has_stream:
        stream_handler = logging.StreamHandler()
        stream_handler.setFormatter(formatter)
        root.addHandler(stream_handler)


def run(stop_event: threading.Event, cfg: Config | None = None) -> None:
    """
    Run the agent until `stop_event` is set.
    Raises SystemExit from load_config() when agent/.env is incomplete.
    """
    cfg = cfg or load_config()
    setup_logging(cfg.log_path)
    logger.info("Agent starting. Worker: %s", cfg.worker_url)

    outbox = Outbox(cfg.outbox_path)
    pending = outbox.pending_count()
    if pending:
        logger.info("%d event(s) waiting in the outbox from a previous run.", pending)

    sender = Sender(cfg, outbox)
    sender.start()

    def on_event(event: dict) -> None:
        if outbox.enqueue(event):
            sender.wake.set()

    worker = SimConnectWorker(on_event=on_event, position_seconds=cfg.position_seconds)
    worker.start()

    try:
        while True:
            sender.post_now(heartbeat_event(worker.get_status(), outbox.pending_count()))
            if stop_event.wait(cfg.heartbeat_seconds):
                break
    finally:
        logger.info("Agent stopping.")
        worker.stop()
        sender.stop()
        sender.join(timeout=5.0)
        # Best-effort final heartbeat so the UI flips to offline immediately.
        sender.post_now(
            heartbeat_event({"connected": False, "state": "DISCONNECTED", "current_flight": None}, outbox.pending_count())
        )
        logger.info("Agent stopped. %d event(s) still queued.", outbox.pending_count())


def main() -> None:
    stop_event = threading.Event()

    def _request_stop(signum, frame) -> None:  # noqa: ARG001
        stop_event.set()

    signal.signal(signal.SIGINT, _request_stop)
    try:
        signal.signal(signal.SIGTERM, _request_stop)
    except (AttributeError, ValueError):
        pass

    run(stop_event)


if __name__ == "__main__":
    main()
