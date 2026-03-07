from __future__ import annotations

import logging
import os
import sqlite3
import tempfile
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from backup_config import BackupSettings
from database import DB_PATH

logger = logging.getLogger(__name__)

try:
    import boto3
except ImportError:  # pragma: no cover - handled at runtime if dependency missing
    boto3 = None


class BackupWorker(threading.Thread):
    def __init__(self, settings: BackupSettings) -> None:
        super().__init__(daemon=True, name="backup-worker")
        self._settings = settings
        self._stop_event = threading.Event()
        self._spaces_warning_logged = False

    def is_enabled(self) -> bool:
        return self._settings.enabled

    def stop(self) -> None:
        self._stop_event.set()
        if self.is_alive():
            self.join(timeout=5)

    def run(self) -> None:
        if not self.is_enabled():
            return

        logger.info("Backup worker initialised.")
        while not self._stop_event.is_set():
            self._run_cycle()
            self._stop_event.wait(self._settings.check_interval_seconds)

    def _run_cycle(self) -> None:
        now = datetime.now(timezone.utc)

        local_due = self._settings.local_enabled and self._is_local_backup_due(now)
        spaces_due = self._spaces_target_ready() and self._is_spaces_backup_due(now)

        snapshot_path: Path | None = None
        timestamp = now.strftime("%Y%m%dT%H%M%SZ")

        try:
            if local_due or spaces_due:
                try:
                    snapshot_path = self._create_snapshot(timestamp)
                except Exception:
                    logger.exception("Failed to create SQLite backup snapshot.")

            try:
                if local_due and snapshot_path is not None:
                    self._write_local_backup(snapshot_path, timestamp)
                self._cleanup_local_backups(now)
            except Exception:
                logger.exception("Local backup cycle failed.")

            try:
                if spaces_due and snapshot_path is not None:
                    self._write_spaces_backup(snapshot_path, timestamp)
                self._cleanup_spaces_backups(now)
            except Exception:
                logger.exception("Spaces backup cycle failed.")
        except Exception:
            logger.exception("Backup cycle failed.")
        finally:
            if snapshot_path is not None and snapshot_path.exists():
                try:
                    snapshot_path.unlink(missing_ok=True)
                except OSError:
                    logger.warning("Could not delete temporary snapshot %s", snapshot_path)

    def _create_snapshot(self, timestamp: str) -> Path:
        fd, snapshot_name = tempfile.mkstemp(
            prefix=f"{self._settings.filename_prefix}-{timestamp}-",
            suffix=".db",
        )
        os.close(fd)
        Path(snapshot_name).unlink(missing_ok=True)
        try:
            self._copy_database(Path(DB_PATH), Path(snapshot_name))
        except Exception:
            Path(snapshot_name).unlink(missing_ok=True)
            raise

        logger.info("Created SQLite backup snapshot at %s", snapshot_name)
        return Path(snapshot_name)

    def _backup_filename(self, timestamp: str) -> str:
        return f"{self._settings.filename_prefix}-{timestamp}.db"

    def _is_local_backup_due(self, now: datetime) -> bool:
        latest = self._latest_local_backup_time()
        return latest is None or now - latest > timedelta(hours=24)

    def _latest_local_backup_time(self) -> datetime | None:
        backup_dir = self._settings.local_directory
        if not backup_dir.exists():
            return None

        latest_path = None
        latest_mtime = None
        for path in backup_dir.glob(f"{self._settings.filename_prefix}-*.db"):
            modified_at = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
            if latest_mtime is None or modified_at > latest_mtime:
                latest_mtime = modified_at
                latest_path = path

        if latest_path is not None:
            logger.debug("Latest local backup found at %s", latest_path)
        return latest_mtime

    def _write_local_backup(self, snapshot_path: Path, timestamp: str) -> None:
        backup_dir = self._settings.local_directory
        backup_dir.mkdir(parents=True, exist_ok=True)
        destination = backup_dir / self._backup_filename(timestamp)

        self._copy_database(snapshot_path, destination)

        logger.info("Created local backup at %s", destination)

    def _cleanup_local_backups(self, now: datetime) -> None:
        if not self._settings.local_enabled:
            return

        backup_dir = self._settings.local_directory
        if not backup_dir.exists():
            return

        cutoff = now - timedelta(days=self._settings.retention_days)
        for path in backup_dir.glob(f"{self._settings.filename_prefix}-*.db"):
            modified_at = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
            if modified_at < cutoff:
                try:
                    path.unlink(missing_ok=True)
                    logger.info("Deleted expired local backup %s", path)
                except OSError:
                    logger.warning("Could not delete expired local backup %s", path)

    def _is_spaces_backup_due(self, now: datetime) -> bool:
        latest = self._latest_spaces_backup_time()
        return latest is None or now - latest > timedelta(hours=24)

    def _spaces_target_ready(self) -> bool:
        return self._create_spaces_client() is not None

    def _write_spaces_backup(self, snapshot_path: Path, timestamp: str) -> None:
        client = self._create_spaces_client()
        if client is None:
            return

        object_key = self._spaces_object_key(self._backup_filename(timestamp))
        client.upload_file(str(snapshot_path), self._settings.spaces_bucket, object_key)
        logger.info(
            "Uploaded backup to Spaces bucket=%s key=%s",
            self._settings.spaces_bucket,
            object_key,
        )

    def _latest_spaces_backup_time(self) -> datetime | None:
        client = self._create_spaces_client()
        if client is None:
            return None

        latest = None
        prefix = self._spaces_object_key("")

        paginator = client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self._settings.spaces_bucket, Prefix=prefix):
            for item in page.get("Contents", []):
                last_modified = item["LastModified"].astimezone(timezone.utc)
                if latest is None or last_modified > latest:
                    latest = last_modified
        return latest

    def _cleanup_spaces_backups(self, now: datetime) -> None:
        if not self._settings.spaces_enabled:
            return

        client = self._create_spaces_client()
        if client is None:
            return

        cutoff = now - timedelta(days=self._settings.retention_days)
        prefix = self._spaces_object_key("")
        paginator = client.get_paginator("list_objects_v2")

        for page in paginator.paginate(Bucket=self._settings.spaces_bucket, Prefix=prefix):
            for item in page.get("Contents", []):
                last_modified = item["LastModified"].astimezone(timezone.utc)
                if last_modified < cutoff:
                    client.delete_object(Bucket=self._settings.spaces_bucket, Key=item["Key"])
                    logger.info("Deleted expired Spaces backup %s", item["Key"])

    def _create_spaces_client(self):
        if not self._settings.spaces_enabled:
            return None

        missing = []
        if not self._settings.spaces_bucket:
            missing.append("LOGBOOK_BACKUP_SPACES_BUCKET")
        if not self._settings.spaces_access_key_id:
            missing.append("LOGBOOK_BACKUP_SPACES_KEY")
        if not self._settings.spaces_secret_access_key:
            missing.append("LOGBOOK_BACKUP_SPACES_SECRET")

        if missing:
            if not self._spaces_warning_logged:
                logger.warning(
                    "Spaces backup enabled but missing required settings: %s",
                    ", ".join(missing),
                )
                self._spaces_warning_logged = True
            return None

        if boto3 is None:
            if not self._spaces_warning_logged:
                logger.warning("Spaces backup enabled but boto3 is not installed.")
                self._spaces_warning_logged = True
            return None

        return boto3.client(
            "s3",
            region_name=self._settings.spaces_region,
            endpoint_url=self._settings.spaces_endpoint_url,
            aws_access_key_id=self._settings.spaces_access_key_id,
            aws_secret_access_key=self._settings.spaces_secret_access_key,
        )

    def _spaces_object_key(self, filename: str) -> str:
        prefix = self._settings.normalized_spaces_prefix
        if not prefix:
            return filename
        if not filename:
            return f"{prefix}/"
        return f"{prefix}/{filename}"

    def _copy_database(self, source_path: Path, destination_path: Path) -> None:
        source_conn = sqlite3.connect(str(source_path))
        dest_conn = sqlite3.connect(str(destination_path))
        try:
            source_conn.backup(dest_conn)
        finally:
            dest_conn.close()
            source_conn.close()
