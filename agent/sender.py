"""
Delivers events to the Worker's POST /api/events.

Sender      daemon thread that drains the outbox in batches with retry/backoff.
post_now()  fire-and-forget single-event POST used for heartbeats (never queued).
post_json() the one HTTP call, stdlib urllib only (no third-party dependency).

Tokens are never logged; only HTTP status codes and response snippets are.
"""

from __future__ import annotations

import json
import logging
import random
import threading
import urllib.error
import urllib.request
from typing import Any

from config import Config
from outbox import Outbox, OutboxRow

logger = logging.getLogger(__name__)

_USER_AGENT = "simple-pilot-logbook-agent/2.0"
_MAX_BACKOFF_SECONDS = 300.0
_TOKEN_RETRY_SECONDS = 60.0


def post_json(cfg: Config, body: dict[str, Any], timeout: float) -> tuple[int, str]:
    """
    POST `body` as JSON to <WORKER_URL>/api/events.
    Returns (http_status, response_snippet); status 0 means the request never
    completed (DNS, connection, TLS or timeout error).
    """
    data = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        cfg.worker_url + "/api/events",
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {cfg.agent_token}",
            "Content-Type": "application/json",
            "User-Agent": _USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return int(response.status), _read_snippet(response)
    except urllib.error.HTTPError as exc:
        return int(exc.code), _read_snippet(exc)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return 0, f"{type(exc).__name__}: {exc}"


def _read_snippet(response: Any) -> str:
    try:
        return response.read(2048).decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001 - best effort only
        return ""


class Sender(threading.Thread):
    """Background thread that ships queued events to the Worker."""

    def __init__(self, cfg: Config, outbox: Outbox) -> None:
        super().__init__(daemon=True, name="event-sender")
        self.cfg = cfg
        self.outbox = outbox
        self.wake = threading.Event()  # set by the producer after enqueue()
        self._stop_event = threading.Event()
        self._batch_size = max(1, cfg.batch_size)
        self._consecutive_failures = 0
        self._prune_countdown = 0

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def stop(self) -> None:
        self._stop_event.set()
        self.wake.set()

    def post_events(self, events: list[dict[str, Any]], timeout: float = 15.0) -> tuple[int, str]:
        return post_json(self.cfg, {"events": events}, timeout)

    def post_now(self, event: dict[str, Any]) -> bool:
        """Send one event immediately without queuing (heartbeats). Never raises."""
        try:
            status, text = post_json(self.cfg, {"events": [event]}, timeout=5.0)
        except Exception as exc:  # noqa: BLE001
            logger.debug("post_now failed: %s", exc)
            return False
        ok = 200 <= status < 300
        if not ok:
            logger.debug("post_now %s -> HTTP %s %s", event.get("type"), status, text[:200])
        return ok

    # ------------------------------------------------------------------
    # Thread body
    # ------------------------------------------------------------------

    def run(self) -> None:
        self._prune()
        while not self._stop_event.is_set():
            batch = self.outbox.next_batch(self._batch_size)
            if not batch:
                self.wake.wait(5.0)
                self.wake.clear()
                self._prune_countdown += 1
                if self._prune_countdown >= 720:  # roughly hourly while idle
                    self._prune()
                continue

            delay = self._deliver(batch)
            if delay > 0:
                self._stop_event.wait(delay)

    def _prune(self) -> None:
        self._prune_countdown = 0
        try:
            removed = self.outbox.prune()
            if removed:
                logger.info("Pruned %d stale outbox row(s).", removed)
        except Exception:  # noqa: BLE001
            logger.exception("Outbox prune failed")

    def _deliver(self, batch: list[OutboxRow]) -> float:
        """Send one batch. Returns how long to wait before the next attempt (0 = go on)."""
        seqs = [row.seq for row in batch]
        try:
            events = [json.loads(row.body) for row in batch]
        except ValueError as exc:
            self.outbox.mark_dead(seqs, f"corrupt body: {exc}")
            logger.error("Dead-lettered %d corrupt outbox row(s): %s", len(seqs), exc)
            return 0.0

        status, text = self.post_events(events)

        if 200 <= status < 300:
            self.outbox.ack(seqs)
            self._consecutive_failures = 0
            # Grow back towards the configured size after a 413 or a rejected-batch shrink.
            self._batch_size = min(self.cfg.batch_size, max(1, self._batch_size * 2))
            logger.info("Delivered %d event(s): %s", len(events), _summarise(events))
            return 0.0

        self._consecutive_failures += 1

        if status in (400, 422):
            error_body = _worker_error_body(text)
            if error_body is not None:
                return self._handle_rejected(batch, status, text, error_body)
            # A 400 that is not the Worker's JSON error (proxy, captive portal, edge
            # error page) says nothing about the events: treat it as transient below.

        if status == 413:
            self._batch_size = max(1, self._batch_size // 2)
            self.outbox.fail(seqs, text)
            logger.warning("Batch too large (HTTP 413); reducing batch size to %d.", self._batch_size)
            return 1.0

        if status in (401, 403):
            self.outbox.fail(seqs, "token rejected")
            logger.error(
                "Worker rejected AGENT_TOKEN (HTTP %d). Check agent/.env. Retrying in %.0f s.",
                status, _TOKEN_RETRY_SECONDS,
            )
            return _TOKEN_RETRY_SECONDS

        self.outbox.fail(seqs, text or "network error")
        delay = min(_MAX_BACKOFF_SECONDS, 2.0 ** min(self._consecutive_failures, 8)) + random.uniform(0.0, 1.0)
        logger.warning(
            "Delivery failed (%s). %d event(s) queued; retrying in %.0f s.",
            f"HTTP {status}" if status else text[:200], self.outbox.pending_count(), delay,
        )
        return delay

    def _handle_rejected(
        self, batch: list[OutboxRow], status: int, text: str, error_body: dict[str, Any]
    ) -> float:
        """
        The Worker validates a request atomically, so one malformed event fails the
        whole batch. Dead-letter only the offending event and let the others retry.

        - The Worker's 400 body carries the failing event's `index`: dead-letter that row.
        - No index and more than one event: shrink the batch so the culprit is isolated
          on the next pass (batch size grows back after the next success).
        - A single rejected event is dead-lettered.
        """
        index = error_body.get("index")
        if isinstance(index, bool) or not isinstance(index, int):
            index = None
        if index is not None and 0 <= index < len(batch):
            bad = batch[index]
            self.outbox.mark_dead([bad.seq], text)
            logger.error(
                "Worker rejected event %s as invalid (HTTP %d): %s. Dead-lettered it; "
                "%d other event(s) in the batch will be retried.",
                bad.event_id, status, text[:300], len(batch) - 1,
            )
            return 0.0

        if len(batch) > 1:
            self._batch_size = max(1, len(batch) // 2)
            self.outbox.fail([row.seq for row in batch], text)
            logger.warning(
                "Worker rejected a %d-event batch (HTTP %d) without naming the event: %s. "
                "Retrying in batches of %d to isolate it.",
                len(batch), status, text[:200], self._batch_size,
            )
            return 0.0

        self.outbox.mark_dead([batch[0].seq], text)
        logger.error(
            "Worker rejected event %s as invalid (HTTP %d): %s. Dead-lettered.",
            batch[0].event_id, status, text[:300],
        )
        return 0.0


def _worker_error_body(text: str) -> dict[str, Any] | None:
    """
    Return the parsed body when it is the Worker's own validation error
    (`{"error": "...", "index"?: n}`), else None for any other 400-ish response.
    """
    try:
        body = json.loads(text)
    except ValueError:
        return None
    if not isinstance(body, dict) or not isinstance(body.get("error"), str):
        return None
    return body


def _summarise(events: list[dict[str, Any]]) -> str:
    counts: dict[str, int] = {}
    for event in events:
        counts[event.get("type", "?")] = counts.get(event.get("type", "?"), 0) + 1
    return ", ".join(f"{k} x{v}" for k, v in sorted(counts.items()))
