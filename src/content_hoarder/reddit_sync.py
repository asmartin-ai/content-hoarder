"""Incremental sync of the user's Reddit *saved* list.

Prefers the sanctioned OAuth read path (``oauth.reddit.com/user/<me>/saved``, ``history`` scope)
when it's configured, else the ``reddit_session`` cookie
(``www.reddit.com/user/<username>/saved.json``) — the same transport selection as
``reddit_hydrate.hydrate_one``. Reddit returns the saved listing **newest-saved-first**, so we walk from the
top and stop the moment we re-reach an item from the previous sync's **high-water mark** — the
newest ``_MARK_DEPTH`` fullnames, stored as a JSON list in ``settings['reddit_sync_newest']``.
The mark is a *list*, not a single name, because the unsave drain (and the user, on reddit.com)
removes items from the saved listing: a single-name mark that gets unsaved would never be
re-found, silently degrading every future sync to a full ``max_pages`` walk. Any one of the K
names re-appearing counts as "caught up". A routine sync therefore does O(new-items) work — not
O(whole-history) — which sidesteps the rate-limit bottleneck.

The very first sync (no mark yet) has no precise boundary, so it pulls ``max_pages`` deep; use the
``--full`` CLI flag (``stop_on_known=False``) for a thorough first catch-up. All network is
injectable (``getf=``/``sleep=``) so this is fully unit-testable offline. Normalization is shared
with the importer via ``connectors.reddit.child_to_item``.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import urllib.parse

from content_hoarder import _http, db, reddit_oauth

logger = logging.getLogger(__name__)
from content_hoarder.reddit_unsave import (
    RedditAuthError,
    RedditNetworkError,
    _http_get,
    _refresh_modhash,
    cookie_user_agent,
    get_auth,
)

SAVED_URL = "https://www.reddit.com/user/{user}/saved.json"
_MARK_KEY = "reddit_sync_newest"   # JSON list of the newest fullnames seen last sync
_MARK_DEPTH = 25                   # how many top-of-listing names the mark keeps (see module doc)


def _load_mark(value) -> list[str]:
    """Parse the stored mark. Accepts the current JSON-list form and the legacy single
    bare-fullname string (pre-list DBs) — the next successful sync rewrites it as a list."""
    if not value:
        return []
    s = str(value).strip()
    if s.startswith("["):
        try:
            return [str(x) for x in json.loads(s) if x]
        except (ValueError, TypeError):
            return []
    return [s]


def sync_saved(
    conn,
    *,
    max_pages: int = 3,
    stop_on_known: bool = True,
    per_page: int = 100,
    throttle: float = 1.0,
    sleep=None,
    getf=None,
    user_agent: str | None = None,
    progress=None,
    reconcile: bool = False,
    reconcile_dry_run: bool = False,
) -> dict:
    """Pull newest saved items into the local DB. Returns a summary dict:
    ``{fetched, new, updated, pages, stopped, auth_error, username}``.

    ``reconcile=True`` flips this into a *full-walk census* run: it forces ``stop_on_known=False``
    (so the whole current saved set is seen, not just the new top), records every listed fullname
    by kind, and after the walk feeds that census into :func:`db.reconcile_reddit_saves` — flagging
    previously-saved items now MISSING from Reddit as ``is_saved=0`` and promoting any still in the
    inbox to ``done`` (see :func:`_reconcile_present`). The result then carries a ``"reconcile"`` key.
    A reconcile only acts on a walk that reached a complete boundary below the listing cap, so a
    partial view can never trigger a false unsave.

    ``stopped`` ∈ {``caught_up`` (re-reached the high-water mark), ``all_known`` (a page had 0
    new and there's no mark yet), ``max_pages``, ``exhausted`` (no more pages), ``empty``,
    ``auth_error``}. The high-water mark only advances when the run reached a real boundary
    (``caught_up``/``all_known``/``exhausted``) or it's the first sync (no mark yet) — never on
    a ``max_pages`` truncation, which could otherwise skip the items below the cutoff forever.
    """
    # NOTE: do NOT reassign ``getf`` here — the transport selector below tests ``getf is None``
    # to decide cookie-vs-OAuth (an injected getf forces the cookie path, keeping every existing
    # test on it). The cookie branch falls back to ``_http_get`` at the call site instead.
    sleep = sleep or time.sleep
    user_agent = user_agent or cookie_user_agent()
    throttle = max(throttle, _http.MIN_THROTTLE)
    result = {"fetched": 0, "new": 0, "updated": 0, "pages": 0,
              "stopped": None, "auth_error": False, "network_error": False,
              "username": None, "transport": None}
    if reconcile:
        stop_on_known = False  # a census MUST see the whole saved set, not stop at the new top
    present_by_kind: dict[str, set] = {"post": set(), "comment": set()}

    # Transport selection (mirrors reddit_hydrate.hydrate_one): prefer the sanctioned OAuth read
    # path when it's configured (refresh token present + an access token mintable + a username to
    # address /user/<me>/saved) AND the caller injected no cookie getf. Otherwise the cookie path,
    # which also serves as the OAuth fallback. OAuth ships DORMANT — is_configured stays False
    # until `reddit-oauth --login`, so until then this is the cookie path byte-for-byte.
    oauth_token = None
    if getf is None and reddit_oauth.is_configured(conn):
        tok = reddit_oauth.access_token(conn)        # None on a permanent refresh failure
        if tok:
            uname = reddit_oauth.status(conn).get("username") or reddit_oauth.fetch_username(tok)
            if uname:                                # need the username to address the listing
                oauth_token, username = tok, uname
                ua = reddit_oauth.oauth_user_agent(conn, username=uname)
                base = "https://oauth.reddit.com/user/" + urllib.parse.quote(uname) + "/saved"
                result["transport"] = "oauth"
            elif not get_auth(conn):
                # OAuth token is valid but the username couldn't be resolved to address
                # /user/<me>/saved, and there's no cookie to fall back to. Report the REAL cause
                # (OAuth) rather than letting the cookie branch below mislabel it 'cookie expired'.
                result["auth_error"] = True
                result["stopped"] = "auth_error"
                return result

    if not oauth_token:                              # cookie path (also the OAuth fallback)
        ua = user_agent
        auth = get_auth(conn)
        if not auth:
            result["auth_error"] = True
            result["stopped"] = "auth_error"
            return result
        username = auth.get("username")
        if not username:  # learn it from /api/me.json if the stored row predates it
            try:
                _modhash, username = _refresh_modhash(
                    auth["session_cookie"], user_agent=ua, getf=getf
                )
            except RedditAuthError:
                result["auth_error"] = True
                result["stopped"] = "auth_error"
                return result
            except RedditNetworkError:
                result["network_error"] = True
                result["stopped"] = "network_error"
                return result
        base = SAVED_URL.format(user=urllib.parse.quote(username))
        result["transport"] = "cookie"
    result["username"] = username

    from content_hoarder.connectors.reddit import child_to_item
    snapshot_utc = int(time.time())  # provenance marker for this saved-list snapshot

    marks = _load_mark(db.get_setting(conn, _MARK_KEY))
    mark_set = set(marks)
    top_names: list[str] = []  # current top of the listing, in order — becomes the next mark
    synced: list[str] = []     # fullnames upserted this run, newest-first (for monotonic saved_utc)
    after = ""
    hit_mark = False

    for page in range(max_pages):
        if page:
            sleep(_http.jittered_throttle(throttle))  # jittered politeness between pages
        params = {"limit": per_page, "raw_json": 1}
        if after:
            params["after"] = after
        url = base + "?" + urllib.parse.urlencode(params)
        try:
            if oauth_token:
                body = reddit_oauth.oauth_get(url, bearer=oauth_token, user_agent=ua) or {}
            else:
                body = (getf or _http_get)(
                    url, session_cookie=auth["session_cookie"], user_agent=ua) or {}
        except RedditNetworkError:
            # Not a real boundary — never advances the mark (unlike empty/exhausted).
            result["network_error"] = True
            result["stopped"] = "network_error"
            break
        data = body.get("data")
        if data is None:
            # The {} sentinel from oauth_get/_http_get means 401/403 — the token/cookie is invalid.
            # A real saved listing (even an empty one) always carries a "data" envelope, so a missing
            # "data" is a DEAD SESSION, not "no saved items". Surface auth_error (and don't advance
            # the mark) instead of silently reporting 'empty'/'exhausted' on a green run.
            result["auth_error"] = True
            result["stopped"] = "auth_error"
            break
        children = data.get("children") or []
        if not children:
            result["stopped"] = "empty" if page == 0 else "exhausted"
            break

        result["pages"] += 1
        page_new = 0
        for ch in children:
            name = (ch.get("data") or {}).get("name")
            if name and len(top_names) < _MARK_DEPTH and name not in top_names:
                top_names.append(name)  # incl. a matched mark item — it's still listed
            if reconcile and name:  # full census of the live saved set (every kind, every page)
                present_by_kind["post" if name.startswith("t3_") else "comment"].add(name)
            if mark_set and name in mark_set and not reconcile:  # last sync's boundary (skip in census)
                hit_mark = True
                break
            item = child_to_item(ch, saved_seen_utc=snapshot_utc)
            if not item:
                continue
            result["fetched"] += 1
            # merge_upsert already does one existence lookup internally and reports the
            # outcome, so trust its return rather than a second get_item round-trip.
            if db.merge_upsert(conn, item) == "inserted":
                result["new"] += 1
                page_new += 1
            else:
                result["updated"] += 1
            synced.append(item["fullname"])
        conn.commit()
        if progress:
            progress(f"page {page + 1}: +{page_new} new ({len(children)} items)")

        if hit_mark:
            result["stopped"] = "caught_up"
            break
        after = data.get("after") or ""
        if not after:
            result["stopped"] = "exhausted"
            break
        # Without a mark yet, a fully-known page is the best boundary heuristic. Once a mark
        # exists it's authoritative, so this fallback is disabled (avoids stopping early at a
        # known *prefix* that still has new items behind it).
        if stop_on_known and not marks and page_new == 0:
            result["stopped"] = "all_known"
            break
    else:
        result["stopped"] = "max_pages"

    # Advance the high-water mark ONLY when we contiguously covered the top of the saved
    # list down to a real boundary: the previous mark (caught_up), a fully-known page
    # (all_known), or the end of the list (exhausted). On a `max_pages` truncation there can
    # be new items BELOW what we fetched but ABOVE the old mark; advancing past them here
    # would skip them on every future sync (silent data gap). The very first sync (no mark
    # yet) sets the initial baseline — run `reddit-sync --full` for a thorough first catch-up.
    # Synthesize a monotonic saved_utc for this snapshot's items (newest-first), sharing the same
    # persistent counter as file imports so "sort by saved newest" is coherent across BOTH ingest
    # paths — child_to_item leaves saved_utc=0, so without this a fresh sync would sort oldest.
    # Folded into the final commit below (atomic with the mark advance).
    if synced:
        top = db.allocate_saved_order(conn, len(synced), commit=False)
        for i, fn in enumerate(synced):
            conn.execute("UPDATE items SET saved_utc=? WHERE fullname=?", (top - i, fn))
    if top_names and (not marks or result["stopped"] in ("caught_up", "exhausted", "all_known")):
        db.set_setting(conn, _MARK_KEY, json.dumps(top_names), commit=False)
    conn.commit()
    if reconcile:
        result["reconcile"] = _reconcile_present(
            conn, present_by_kind, stopped=result["stopped"], dry_run=reconcile_dry_run)
    return result


# Reddit's saved listing historically caps at ~1000 items, but some accounts (incl. this one — a
# dry-run walked 1200+ with the cursor still advancing) paginate well past it. So the count is NOT a
# reliable completeness signal — reaching the END of the listing (after==null -> stopped 'exhausted')
# is. The one genuinely ambiguous case is a walk that ENDS right at the legacy ~1000 boundary: that
# could be the real end OR the cap hiding older saves, so we refuse to reconcile in that band only. A
# walk ending well below (a small saved list) or well above (an account that paginates past 1000) it
# is treated as complete.
LEGACY_CAP_LO = 990
LEGACY_CAP_HI = 1010


def _reconcile_present(conn, present_by_kind: dict, *, stopped: str | None,
                       dry_run: bool = False) -> dict:
    """Reconcile a full-walk census against the local DB (the "infer unsaved + unsave locally" step).

    Feeds the live-saved census into :func:`db.reconcile_reddit_saves` (which clears ``is_saved`` for
    previously-snapshot-seen items now absent — a Reddit-side unsave; it never writes to Reddit), then
    promotes the freshly-unsaved items that are still in the INBOX to ``done`` (the unsave decided it).
    Items already in a decided local state (``keep``/``archived``/``done``) only lose ``is_saved`` —
    their status stands. The done-promotion passes ``queue_unsave=False`` so it never re-enqueues a
    no-op Reddit unsave for an item that's already gone server-side.

    SAFETY: reconciles NOTHING (``ran=False``) unless the walk reached the END of the listing
    (``exhausted``/``empty``) — a ``max_pages`` truncation is a partial view. And if it ended in the
    ambiguous legacy-cap band (~1000) we also skip, since a hidden cap there would look like the end.
    ``dry_run`` previews the would-unsave set without writing.
    """
    total = sum(len(v) for v in present_by_kind.values())
    if stopped not in ("exhausted", "empty"):
        return {"ran": False, "skipped": "incomplete_walk", "stopped": stopped, "present": total}
    if LEGACY_CAP_LO <= total <= LEGACY_CAP_HI:
        return {"ran": False, "skipped": "ambiguous_cap", "present": total}
    # Reached the listing's end, clear of the ambiguous band -> this census IS the current saved set.
    rec = db.reconcile_reddit_saves(
        conn, present_by_kind, dry_run=dry_run,
        truncated_by_kind={"post": False, "comment": False})
    unsaved_fns = [fn for k in ("post", "comment") for fn in rec.get(k, {}).get("fullnames", [])]
    promoted = 0
    if not dry_run and unsaved_fns:
        for fn in unsaved_fns:
            row = conn.execute("SELECT status FROM items WHERE fullname=?", (fn,)).fetchone()
            if row and row["status"] == "inbox":  # undecided -> the Reddit unsave decided it
                db.set_status(conn, fn, "done", queue_unsave=False)
                promoted += 1
        conn.commit()
    return {"ran": True, "present": total, "by_kind": rec, "dry_run": dry_run,
            "unsaved": len(unsaved_fns), "promoted_done": promoted}


# Backward-compatible name: this was cookie-only before the OAuth read path was added. The public
# entry point is now ``sync_saved`` (transport-aware); the old name stays as an alias so existing
# callers/tests keep working. With an injected ``getf`` it is the cookie path, unchanged.
sync_saved_cookie = sync_saved


# --- Automatic sync orchestration (the background scheduler + PWA-open hook share this one path) ---

_ENABLED_KEY = "reddit_autosync_enabled"        # "1" arms the background scheduler + PWA-open trigger
_LAST_RUN_KEY = "reddit_autosync_last_run"      # epoch of the last non-debounced auto run (any mode)
_LAST_RECON_KEY = "reddit_autosync_last_reconcile"  # epoch of the last completed reconcile

MIN_RUN_INTERVAL = 90        # debounce: triggers within this window no-op (PWA-open spam collapses to 1)
RECONCILE_INTERVAL = 6 * 3600  # how often the heavy unsave-reconcile runs; cheap imports run between
RECONCILE_MAX_PAGES = 60     # up to ~6000 items — the saved list can paginate well past 1000; the
                             # reconcile MUST reach the listing's end (after==null) or it can't run


def _to_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def is_autosync_enabled(conn) -> bool:
    """Whether the background scheduler + PWA-open auto path are armed (opt-in, default off)."""
    return db.get_setting(conn, _ENABLED_KEY, "0") == "1"


def set_autosync_enabled(conn, enabled: bool) -> None:
    db.set_setting(conn, _ENABLED_KEY, "1" if enabled else "0", commit=True)


def auto_sync(conn, *, now=None, force: bool = False, reconcile_dry_run: bool = False,
              min_interval: int = MIN_RUN_INTERVAL, reconcile_interval: int = RECONCILE_INTERVAL,
              getf=None, sleep=None, user_agent: str | None = None, progress=None) -> dict:
    """The single entry point the background scheduler AND the PWA-open hook both call.

    Debounced (a trigger within ``min_interval`` of the last run no-ops — so opening the app
    repeatedly costs one sync, not ten) and two-speed: when a reconcile is due it does ONE full-walk
    run that imports new saves AND reconciles Reddit-side unsaves; otherwise just a cheap incremental
    top-walk import. ``force`` bypasses the debounce and forces the reconcile. Never raises — auth /
    network failure is reported inside the inner ``result``. ``reconcile_dry_run`` previews the
    reconcile (no ``is_saved``/status writes), and does NOT advance the reconcile high-water mark.
    """
    now = now if now is not None else int(time.time())
    last_run = _to_int(db.get_setting(conn, _LAST_RUN_KEY, "0"))
    if not force and now - last_run < min_interval:
        return {"skipped": "debounced", "since_last": now - last_run, "mode": None}

    last_recon = _to_int(db.get_setting(conn, _LAST_RECON_KEY, "0"))
    due = force or (now - last_recon >= reconcile_interval)
    if due:
        res = sync_saved(conn, reconcile=True, reconcile_dry_run=reconcile_dry_run,
                         max_pages=RECONCILE_MAX_PAGES, stop_on_known=False,
                         getf=getf, sleep=sleep, user_agent=user_agent, progress=progress)
        out = {"mode": "reconcile", "result": res}
        if not reconcile_dry_run and (res.get("reconcile") or {}).get("ran"):
            db.set_setting(conn, _LAST_RECON_KEY, str(now), commit=True)
    else:
        res = sync_saved(conn, max_pages=3, stop_on_known=True,
                         getf=getf, sleep=sleep, user_agent=user_agent, progress=progress)
        out = {"mode": "incremental", "result": res}

    db.set_setting(conn, _LAST_RUN_KEY, str(now), commit=True)
    out["transport"] = res.get("transport")
    return out


def _timer_scheduler(delay, fn):
    """Default scheduler: a one-shot daemon Timer (mirrors reddit_trickle). Returns a ``.cancel()``
    handle. Injected in tests so the scheduler is driven synchronously with no real threads."""
    t = threading.Timer(delay, fn)
    t.daemon = True
    t.start()
    return t


class SyncScheduler:
    """Periodic, single-flight background driver of :func:`auto_sync`.

    Always re-arms after a fire, and each fire re-checks :func:`is_autosync_enabled`, so the
    scheduler can be toggled at runtime (the next tick simply no-ops while disabled) without an app
    restart. Modeled on :class:`reddit_trickle.TrickleDrainer`: a daemon Timer, a single-flight lock
    so overlapping ticks can't double-sync, and its OWN per-fire DB connection (``db.connect`` is
    per-call, hence thread-safe). Inject ``scheduler`` / ``sync_fn`` in tests."""

    def __init__(self, conn_factory, *, interval: float = 600.0,
                 scheduler=_timer_scheduler, sync_fn=None):
        self._conn_factory = conn_factory          # () -> context manager yielding a db connection
        self._interval = interval
        self._scheduler = scheduler
        self._sync_fn = sync_fn or auto_sync
        self._run_lock = threading.Lock()          # single-flight: at most one sync at a time
        self._timer_lock = threading.Lock()
        self._timer = None
        self._stopped = False

    def start(self) -> "SyncScheduler":
        self._arm()
        return self

    def _arm(self) -> None:
        with self._timer_lock:
            if self._stopped:
                return
            self._timer = self._scheduler(self._interval, self.fire)

    def stop(self) -> None:
        with self._timer_lock:
            self._stopped = True
            if self._timer is not None:
                self._timer.cancel()

    def fire(self):
        """Run one auto_sync tick if armed + opted-in. Single-flight; always re-arms. Returns the
        auto_sync summary, or ``None`` when skipped (a sync already running, or autosync disabled)."""
        if not self._run_lock.acquire(blocking=False):
            return None                            # a sync is in flight; the next tick will retry
        res = None
        try:
            with self._conn_factory() as conn:
                if not is_autosync_enabled(conn):
                    return None                    # opt-in off — cheap no-op tick
                res = self._sync_fn(conn)
        except Exception:                          # a daemon-thread crash must not kill the timer
            logger.exception("reddit autosync tick failed")
        finally:
            self._run_lock.release()
            self._arm()
        # No user is in the loop on a daemon tick, so surface a dead token/cookie or connectivity blip.
        inner = (res or {}).get("result") or {} if isinstance(res, dict) else {}
        if inner.get("auth_error") or inner.get("network_error"):
            logger.warning("reddit autosync halted (%s error) — re-authenticate or check connectivity",
                           "auth" if inner.get("auth_error") else "network")
        return res
