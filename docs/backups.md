# Backup Setup

The app can back up `backend/logbook.db` to both a local folder and a
DigitalOcean Spaces bucket. Each target is checked independently:

- if the newest backup is older than 24 hours, a new backup is created
- backups are append-only and use UTC timestamps in the filename
- backups older than 30 days are deleted

The app uses SQLite's online backup API to create a consistent snapshot before
copying or uploading it.

## Credentials

`LOGBOOK_BACKUP_SPACES_KEY` and `LOGBOOK_BACKUP_SPACES_SECRET` are read from
Windows Credential Manager first, falling back to environment variables. See
[secret-management.md](secret-management.md) for how to store them.

## Environment Variables

Set these before starting the app or Windows service:

| Variable | Default | Purpose |
|---|---|---|
| `LOGBOOK_BACKUP_LOCAL_ENABLED` | `true` | Enable or disable local backups |
| `LOGBOOK_BACKUP_LOCAL_DIR` | `~/Documents/SimplePilotLogbook/backups` | Local backup directory |
| `LOGBOOK_BACKUP_SPACES_ENABLED` | `false` | Enable or disable Spaces uploads |
| `LOGBOOK_BACKUP_SPACES_BUCKET` |  | Spaces bucket name |
| `LOGBOOK_BACKUP_SPACES_REGION` | `nyc3` | Spaces region |
| `LOGBOOK_BACKUP_SPACES_KEY` |  | Spaces access key ID |
| `LOGBOOK_BACKUP_SPACES_SECRET` |  | Spaces secret access key |
| `LOGBOOK_BACKUP_SPACES_PREFIX` | `logbook-backups` | Object key prefix inside the bucket |
| `LOGBOOK_BACKUP_RETENTION_DAYS` | `30` | Backup retention window |
| `LOGBOOK_BACKUP_CHECK_INTERVAL_SECONDS` | `3600` | Backup check cadence |
| `LOGBOOK_BACKUP_FILENAME_PREFIX` | `logbook` | Backup filename prefix |

## Windows Service Notes

The backup worker is hosted inside the existing `SimplePilotLogbook` Windows
service. This is the simplest way to keep the backup cadence tied to the app's
lifecycle.

If you want local backups in a OneDrive-synced `Documents` folder, make sure
the service account can access that path. Running the service as `LocalSystem`
is usually fine for Spaces uploads, but it is often the wrong choice for a
personal OneDrive folder.

If you prefer to run backups independently of the web app, Windows Task
Scheduler is the cleanest external alternative. That is not required for this
implementation.
