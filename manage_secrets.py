#!/usr/bin/env python
"""
Manage secrets stored in Windows Credential Manager for Simple Pilot Logbook.

Secrets are encrypted at rest via DPAPI and scoped to the Windows account
running this script.  When the app runs as a Windows service under
LocalSystem, you must execute this script **as that account** so the
credentials are accessible to the service at runtime.

Running as LocalSystem
----------------------
Use PsExec (from Sysinternals) to launch an interactive SYSTEM shell::

    PsExec64.exe -sid cmd.exe

Then run this script from that shell.  Alternatively, prefix each call::

    PsExec64.exe -s python manage_secrets.py set LOGBOOK_BACKUP_SPACES_KEY

Running as another service account
----------------------------------
If the service is configured to run as a specific user, log in as that
user (or use ``runas``) and run the script normally.

Usage examples
--------------
    python manage_secrets.py list
    python manage_secrets.py set  LOGBOOK_BACKUP_SPACES_KEY
    python manage_secrets.py set  LOGBOOK_BACKUP_SPACES_SECRET --value "s3cr3t"
    python manage_secrets.py get  LOGBOOK_BACKUP_SPACES_KEY
    python manage_secrets.py delete LOGBOOK_BACKUP_SPACES_SECRET
"""

from __future__ import annotations

import argparse
import getpass
import sys

try:
    import keyring
except ImportError:
    print(
        "Error: the 'keyring' package is required.\n"
        "Install it with:  pip install keyring",
        file=sys.stderr,
    )
    sys.exit(1)

# Must stay in sync with backend/secrets_store.py
DEFAULT_SERVICE = "SimplePilotLogbook"

KNOWN_SECRETS: dict[str, str] = {
    "LOGBOOK_BACKUP_SPACES_KEY": "DigitalOcean Spaces access key ID",
    "LOGBOOK_BACKUP_SPACES_SECRET": "DigitalOcean Spaces secret access key",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _warn_unknown_key(key: str) -> None:
    if key not in KNOWN_SECRETS:
        known = ", ".join(KNOWN_SECRETS)
        print(f"Warning: '{key}' is not a known secret key ({known})", file=sys.stderr)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_list(args: argparse.Namespace) -> None:
    """List known secret keys and whether each is set."""
    print(f"Service: {args.service}\n")
    for key, description in KNOWN_SECRETS.items():
        value = keyring.get_password(args.service, key)
        status = "SET" if value is not None else "NOT SET"
        print(f"  [{status:>7s}]  {key}  —  {description}")


def cmd_get(args: argparse.Namespace) -> None:
    """Retrieve and print a single secret."""
    _warn_unknown_key(args.key)
    value = keyring.get_password(args.service, args.key)
    if value is None:
        print(f"{args.key}: not set", file=sys.stderr)
        sys.exit(1)
    print(value)


def cmd_set(args: argparse.Namespace) -> None:
    """Store a secret.  Prompts interactively when --value is omitted."""
    _warn_unknown_key(args.key)
    value = args.value
    if value is None:
        value = getpass.getpass(f"Enter value for {args.key}: ")
        if not value:
            print("Aborted: empty value.", file=sys.stderr)
            sys.exit(1)
    keyring.set_password(args.service, args.key, value)
    print(f"{args.key}: stored in {args.service}")


def cmd_delete(args: argparse.Namespace) -> None:
    """Remove a secret from the credential store."""
    _warn_unknown_key(args.key)
    try:
        keyring.delete_password(args.service, args.key)
        print(f"{args.key}: deleted from {args.service}")
    except keyring.errors.PasswordDeleteError:
        print(f"{args.key}: not found in {args.service}", file=sys.stderr)
        sys.exit(1)


# ---------------------------------------------------------------------------
# Argument parser
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Manage secrets in Windows Credential Manager for Simple Pilot Logbook.",
    )
    parser.add_argument(
        "--service",
        default=DEFAULT_SERVICE,
        help=f"Keyring service name (default: {DEFAULT_SERVICE})",
    )

    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="Show known secrets and their status")

    p_get = sub.add_parser("get", help="Retrieve a secret")
    p_get.add_argument("key", help="Secret key name")

    p_set = sub.add_parser("set", help="Store a secret")
    p_set.add_argument("key", help="Secret key name")
    p_set.add_argument("--value", default=None, help="Secret value (prompted if omitted)")

    p_del = sub.add_parser("delete", help="Remove a secret")
    p_del.add_argument("key", help="Secret key name")

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    dispatch = {
        "list": cmd_list,
        "get": cmd_get,
        "set": cmd_set,
        "delete": cmd_delete,
    }
    dispatch[args.command](args)


if __name__ == "__main__":
    main()
