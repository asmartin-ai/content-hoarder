"""In-app async unsave *trickle*.

Marking a Reddit item Done enqueues instantly (``db.set_status`` → ``reddit_unsave`` queue); this
module then drains a SMALL capped batch shortly after triage activity settles, so processing the
inbox quietly shrinks the real Reddit Saved list without a "Done" ever waiting on the network.

It is the small-blast *continuous* lane, distinct from the big-blast manual bulk drain (which keeps
its ``--live --yes`` money-action gate). Its consent is the one-time opt-in (``reddit_unsave_on_done``)
plus the bound (a small per-fire cap + the jitter/rate-cap inside ``drain`` + the ``unsave-audit.jsonl``
trail) — NOT a per-fire confirmation, which would be impossible for an auto-drain. See
``docs/reddit-derisking.md``.

Threading is deliberately thin and the policy is injectable so it is unit-testable with no real
threads or network:
- ``note_enqueue()`` (called from the request thread after a Done) only (re)arms an idle-debounce
  timer and returns immediately — triage never blocks. Each new Done resets the timer, so the drain
  fires once activity *settles*, never mid-burst.
- ``fire()`` runs on the timer thread: single-flight (a drain already running → skip; a later Done
  re-arms), opens its OWN connection (``db.connect`` is per-call, so thread-safe), re-checks the
  opt-in, and drains a capped batch via ``reddit_unsave.drain`` (OAuth-preferred, audited).
"""

from __future__ import annotations

import logging
import threading

from content_hoarder import db as _db, reddit_unsave as _ru

logger = logging.getLogger(__name__)

DEFAULT_IDLE_SECONDS = 30.0   # fire ~30s after the last Done — past a triage burst, not during it
DEFAULT_CAP = 25              # small per-fire cap (matches the bulk-hydrate cap); resumable anyway


def _timer_scheduler(delay, fn):
    """Default scheduler: a one-shot daemon Timer. Returns a handle with ``.cancel()``."""
    t = threading.Timer(delay, fn)
    t.daemon = True
    t.start()
    return t


class TrickleDrainer:
    """Idle-debounced, single-flight background unsave drainer. Inject ``scheduler`` / ``drain_fn``
    in tests to drive it synchronously."""

    def __init__(self, conn_factory, *, audit=None, idle_seconds: float = DEFAULT_IDLE_SECONDS,
                 cap: int = DEFAULT_CAP, scheduler=_timer_scheduler, drain_fn=None):
        self._conn_factory = conn_factory      # () -> context manager yielding a db connection
        self._audit = audit
        self._idle = idle_seconds
        self._cap = cap
        self._scheduler = scheduler
        self._drain_fn = drain_fn or _ru.drain
        self._run_lock = threading.Lock()      # single-flight: at most one drain at a time
        self._timer_lock = threading.Lock()
        self._timer = None

    def note_enqueue(self) -> None:
        """(Re)arm the idle debounce. Returns immediately; safe to call from a request thread."""
        with self._timer_lock:
            if self._timer is not None:
                self._timer.cancel()
            self._timer = self._scheduler(self._idle, self.fire)

    def fire(self):
        """Drain one small capped batch, if still opted in. Single-flight; returns the drain summary,
        or ``None`` when skipped (a drain already running, or unsave-on-done turned off)."""
        if not self._run_lock.acquire(blocking=False):
            return None                        # another drain is in flight; a later Done re-arms
        try:
            with self._conn_factory() as conn:
                if _db.get_setting(conn, "reddit_unsave_on_done", "0") != "1":
                    return None                # opt-in withdrawn since the timer armed
                res = self._drain_fn(conn, limit=self._cap, audit=self._audit)
        finally:
            self._run_lock.release()
        # Surface auth/network failures: fire() runs on a daemon timer thread with no user in the
        # loop, so an error buried in the result dict would otherwise vanish silently (the queue
        # just stops draining). Log it so a dead token/cookie or connectivity blip is visible.
        if isinstance(res, dict) and (res.get("auth_error") or res.get("network_error")):
            kind = "auth" if res.get("auth_error") else "network"
            logger.warning(
                "unsave trickle halted (%s error): %d unsaved, %d remaining — "
                "re-authenticate or check connectivity",
                kind, res.get("unsaved", 0), res.get("remaining", 0))
        # Keep trickling while idle until the backlog clears: re-arm only if this fire made progress
        # (unsaved > 0) AND items remain. The unsaved>0 guard stops a stuck/auth-failed queue from
        # looping forever (a dead cookie returns unsaved=0). Each fire still honors the small cap.
        if isinstance(res, dict) and res.get("unsaved", 0) > 0 and res.get("remaining", 0) > 0:
            self.note_enqueue()
        return res
