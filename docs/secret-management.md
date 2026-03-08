# Secret Management

Secrets such as DigitalOcean Spaces credentials are stored in **Windows
Credential Manager** via the `keyring` library. Credentials are encrypted at
rest with DPAPI and scoped to the Windows account that created them.

Non-secret configuration (bucket name, region, retention days, etc.) is still
read from environment variables. See the
[backup docs](backups.md) or [README](../README.md) for the full variable list.

## Prerequisites

Install the `keyring` package (included in `requirements.txt`):

```
pip install keyring
```

## Storing Secrets

Use `manage_secrets.py` at the repository root. When the app runs as a
Windows service under **LocalSystem**, secrets must be stored under that
account.

### Running as LocalSystem

Use [PsExec](https://learn.microsoft.com/en-us/sysinternals/downloads/psexec)
from Sysinternals to open a SYSTEM shell:

```
PsExec64.exe -sid cmd.exe
```

Then from that shell:

```
python manage_secrets.py set LOGBOOK_BACKUP_SPACES_KEY
python manage_secrets.py set LOGBOOK_BACKUP_SPACES_SECRET
```

Each command prompts for the value (input is hidden). You can also pass
`--value "..."` to skip the prompt.

### Running as another service account

If the service runs as a specific user, log in as that user (or use `runas`)
and run the script normally.

## CLI Reference

```
python manage_secrets.py list                          # show which secrets are set
python manage_secrets.py get  LOGBOOK_BACKUP_SPACES_KEY   # print a secret
python manage_secrets.py set  LOGBOOK_BACKUP_SPACES_KEY   # store a secret (prompted)
python manage_secrets.py set  LOGBOOK_BACKUP_SPACES_KEY --value "AKID..."  # store inline
python manage_secrets.py delete LOGBOOK_BACKUP_SPACES_KEY # remove a secret
```

All commands accept `--service <name>` to override the keyring service name
(default: `SimplePilotLogbook`).

## Known Secret Keys

| Key | Description |
|---|---|
| `LOGBOOK_BACKUP_SPACES_KEY` | DigitalOcean Spaces access key ID |
| `LOGBOOK_BACKUP_SPACES_SECRET` | DigitalOcean Spaces secret access key |

New keys can be added by extending the `KNOWN_SECRETS` dict in both
`backend/secrets_store.py` and `manage_secrets.py`.

## Fallback Behavior

If `keyring` is not installed or a key is not found in the credential store,
the app falls back to reading the equivalent environment variable. This keeps
the app functional in development, CI, and non-Windows environments without
requiring the credential store.

## Design Decision

See [ADR-001](adrs/001-secret-management.md) for the full evaluation of
secret management options and the rationale for choosing Windows Credential
Manager.
