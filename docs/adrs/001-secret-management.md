# ADR-001: Secret Management

**Status:** Accepted
**Date:** 2026-03-07

## Context

The app needs to manage secrets such as DigitalOcean credentials for the daily backup feature, with more secrets likely in the future. The app runs as a Windows service on a single machine. Secrets are consumed as environment variables at runtime.

We need a solution that:
- Encrypts secrets at rest
- Works reliably under a Windows service account
- Is straightforward to set and update
- Scales to a handful of secrets without extra infrastructure

## Options Considered

### 1. `.env` file with `python-dotenv`

A plaintext `.env` file loaded at startup, gitignored, with restricted NTFS permissions.

- **Pros:** Zero setup, standard Python pattern, works identically for `start.bat` and the Windows service.
- **Cons:** Not encrypted at rest. Anyone with file access can read secrets in the clear.

### 2. Windows Credential Manager via `keyring`

Secrets stored in Windows Credential Manager, encrypted at rest via DPAPI and scoped to the service account.

- **Pros:** Encrypted at rest, no external infrastructure, secrets scoped to the account running the service.
- **Cons:** Slightly more friction to set/update secrets (requires a helper script or CLI). Credentials are tied to the Windows account, so they must be set under the same account that runs the service.

### 3. Remote secret store (Azure Key Vault, HashiCorp Vault, etc.)

Secrets fetched from a managed cloud service at startup.

- **Pros:** Secret rotation, audit logs, access policies, multi-machine support.
- **Cons:** Overkill for a single-machine local app. Adds network dependency, auth bootstrapping complexity, and cost.

## Decision

**Option 2 — Windows Credential Manager via `keyring`.**

Encryption at rest is important for this app. The `keyring` library provides a clean Python interface to Windows Credential Manager, which encrypts secrets using DPAPI tied to the service account. This meets our security requirement without adding external infrastructure or cloud dependencies.

A helper script will be provided so secrets can be set and updated from the command line under the appropriate account context.
