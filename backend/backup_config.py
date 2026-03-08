from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from secrets_store import get_secret


def _read_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _read_int(name: str, default: int, minimum: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default

    try:
        value = int(raw)
    except ValueError:
        return default

    return max(value, minimum)


def _default_local_backup_dir() -> Path:
    return Path.home() / "Documents" / "SimplePilotLogbook" / "backups"


@dataclass(frozen=True)
class BackupSettings:
    check_interval_seconds: int
    retention_days: int
    filename_prefix: str
    local_enabled: bool
    local_directory: Path
    spaces_enabled: bool
    spaces_bucket: str
    spaces_region: str
    spaces_access_key_id: str
    spaces_secret_access_key: str
    spaces_prefix: str

    @property
    def spaces_endpoint_url(self) -> str:
        return f"https://{self.spaces_region}.digitaloceanspaces.com"

    @property
    def normalized_spaces_prefix(self) -> str:
        return self.spaces_prefix.strip("/")

    @property
    def enabled(self) -> bool:
        return self.local_enabled or self.spaces_enabled


def load_backup_settings() -> BackupSettings:
    local_directory = Path(
        os.getenv("LOGBOOK_BACKUP_LOCAL_DIR", str(_default_local_backup_dir()))
    ).expanduser()

    return BackupSettings(
        check_interval_seconds=_read_int(
            "LOGBOOK_BACKUP_CHECK_INTERVAL_SECONDS",
            default=3600,
            minimum=300,
        ),
        retention_days=_read_int(
            "LOGBOOK_BACKUP_RETENTION_DAYS",
            default=30,
            minimum=1,
        ),
        filename_prefix=os.getenv("LOGBOOK_BACKUP_FILENAME_PREFIX", "logbook").strip() or "logbook",
        local_enabled=_read_bool("LOGBOOK_BACKUP_LOCAL_ENABLED", True),
        local_directory=local_directory,
        spaces_enabled=_read_bool("LOGBOOK_BACKUP_SPACES_ENABLED", False),
        spaces_bucket=os.getenv("LOGBOOK_BACKUP_SPACES_BUCKET", "").strip(),
        spaces_region=os.getenv("LOGBOOK_BACKUP_SPACES_REGION", "nyc3").strip() or "nyc3",
        spaces_access_key_id=get_secret("LOGBOOK_BACKUP_SPACES_KEY").strip(),
        spaces_secret_access_key=get_secret("LOGBOOK_BACKUP_SPACES_SECRET").strip(),
        spaces_prefix=os.getenv("LOGBOOK_BACKUP_SPACES_PREFIX", "logbook-backups").strip(),
    )
