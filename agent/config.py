"""
Agent configuration.

Values come from agent/.env (next to this file — never the current working
directory, because the Windows service starts with a different cwd) and may be
overridden by real environment variables of the same name.

Required
    WORKER_URL          https://simple-pilot-logbook.<account>.workers.dev
    AGENT_TOKEN         bearer token matching the Worker's AGENT_TOKEN secret

Optional
    HEARTBEAT_SECONDS   default 10
    POSITION_SECONDS    default 10   (flight.position cadence while airborne)
    BATCH_SIZE          default 20   (the Worker rejects more than 20 events per request)
    OUTBOX_PATH         default agent/outbox.db
    LOG_PATH            default agent/agent.log
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parent
ENV_PATH = AGENT_DIR / ".env"

# Hard upper bound enforced by the Worker (worker/src/events.ts MAX_EVENTS).
MAX_BATCH_SIZE = 20


@dataclass(frozen=True)
class Config:
    worker_url: str
    agent_token: str
    heartbeat_seconds: float = 10.0
    position_seconds: float = 10.0
    batch_size: int = MAX_BATCH_SIZE
    outbox_path: Path = AGENT_DIR / "outbox.db"
    log_path: Path = AGENT_DIR / "agent.log"


def read_env_file(path: Path) -> dict[str, str]:
    """
    Parse a minimal KEY=VALUE file.
    Blank lines and lines starting with '#' are ignored; matching surrounding
    quotes are stripped from values.
    """
    values: dict[str, str] = {}
    if not path.exists():
        return values

    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key:
            values[key] = value
    return values


def load_config(env_path: Path = ENV_PATH) -> Config:
    """Build the Config or raise SystemExit with a human-readable reason."""
    file_values = read_env_file(env_path)

    def get(key: str, default: str | None = None) -> str | None:
        return os.environ.get(key, file_values.get(key, default))

    worker_url = (get("WORKER_URL") or "").strip().rstrip("/")
    agent_token = (get("AGENT_TOKEN") or "").strip()

    missing = [name for name, value in (("WORKER_URL", worker_url), ("AGENT_TOKEN", agent_token)) if not value]
    if missing:
        raise SystemExit(
            f"Missing required setting(s): {', '.join(missing)}. "
            f"Create {env_path} from .env.example or set them as environment variables."
        )
    if not worker_url.startswith(("http://", "https://")):
        raise SystemExit(f"WORKER_URL must start with http:// or https:// (got {worker_url!r}).")

    def get_number(key: str, default: float, minimum: float) -> float:
        raw = get(key)
        if raw is None or raw.strip() == "":
            return default
        try:
            value = float(raw)
        except ValueError:
            raise SystemExit(f"{key} must be a number (got {raw!r}).") from None
        return max(minimum, value)

    heartbeat_seconds = get_number("HEARTBEAT_SECONDS", 10.0, 2.0)
    position_seconds = get_number("POSITION_SECONDS", 10.0, 2.0)
    batch_size = int(min(MAX_BATCH_SIZE, get_number("BATCH_SIZE", MAX_BATCH_SIZE, 1)))

    outbox_path = Path(get("OUTBOX_PATH") or (AGENT_DIR / "outbox.db"))
    log_path = Path(get("LOG_PATH") or (AGENT_DIR / "agent.log"))

    return Config(
        worker_url=worker_url,
        agent_token=agent_token,
        heartbeat_seconds=heartbeat_seconds,
        position_seconds=position_seconds,
        batch_size=batch_size,
        outbox_path=outbox_path,
        log_path=log_path,
    )
