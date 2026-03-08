"""
Retrieve secrets from Windows Credential Manager via the ``keyring`` library.

Secrets are encrypted at rest with DPAPI, scoped to the Windows account
that stored them.  The app reads secrets at startup; a companion CLI
(``manage_secrets.py``) handles writes.

For non-Windows platforms (or when keyring is unavailable), every lookup
falls back to an optional environment variable so the app still works in
development and CI.
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

DEFAULT_SERVICE = "SimplePilotLogbook"

# Known secret keys and their legacy env-var fallbacks.
# Extend this mapping when new secrets are added.
KNOWN_SECRETS: dict[str, str | None] = {
    "LOGBOOK_BACKUP_SPACES_KEY": "LOGBOOK_BACKUP_SPACES_KEY",
    "LOGBOOK_BACKUP_SPACES_SECRET": "LOGBOOK_BACKUP_SPACES_SECRET",
}

try:
    import keyring as _keyring
except ImportError:  # pragma: no cover
    _keyring = None  # type: ignore[assignment]


def get_secret(
    key: str,
    *,
    fallback_env: str | None = None,
    service: str = DEFAULT_SERVICE,
) -> str:
    """Return a secret value, trying keyring first then the environment.

    Parameters
    ----------
    key:
        The credential name stored in Windows Credential Manager.
    fallback_env:
        Environment variable to check when keyring is unavailable or the
        key is not found.  Defaults to *key* itself when ``None``.
    service:
        The keyring service (grouping) name.
    """
    env_name = fallback_env if fallback_env is not None else key

    if _keyring is not None:
        try:
            value = _keyring.get_password(service, key)
            if value is not None:
                return value
        except Exception:
            logger.debug("keyring lookup failed for %s/%s", service, key, exc_info=True)

    return os.getenv(env_name, "")
