"""Unsave reddit items from the user's Reddit Saved list via reddit_session-cookie auth.

No OAuth: we POST to the same web endpoints the browser uses (`/api/unsave`), authenticated
by the `reddit_session` cookie + a modhash CSRF token read from `/api/me.json`. The work queue
(`reddit_unsave` table) is drained on demand — a CLI/scheduled job or the "Sync now" button —
so triage stays instant and a flaky/expired cookie never blocks a local "Done". All network is
injectable (`post=`/`getf=`/`sleep=`) so the module is fully unit-testable offline.
"""

from __future__ import annotations

import json
import time
import urllib.parse

from content_hoarder import _http, config

UNSAVE_URL = "https://www.reddit.com/api/unsave"
SAVE_URL = "https://www.reddit.com/api/save"
ME_URL = "https://www.reddit.com/api/me.json"
# OAuth write endpoints (oauth.reddit.com) — used when the sanctioned save-scope path is configured.
OAUTH_UNSAVE_URL = "https://oauth.reddit.com/api/unsave"
OAUTH_SAVE_URL = "https://oauth.reddit.com/api/save"

# Per-row drain-failure cap: a permanently-erroring item (e.g. Reddit answers 400 for it
# forever) flips to state='failed' instead of re-consuming the ~1 req/s throttle every run.
MAX_ATTEMPTS = 5


class RedditAuthError(Exception):
    """Cookie expired / logged out / 403 — halts the drain; surfaced loudly to the user."""


class RedditNetworkError(Exception):
    """Transient transport/server failure — NOT an auth problem; retry later. Kept distinct
    so a network blip never tells the user to re-paste a perfectly good cookie."""


class RedditNotFoundError(RedditNetworkError):
    """HTTP 404 — the post/thread was deleted or removed. Subclass of RedditNetworkError
    so existing catch-all blocks still work, but callers can distinguish for archive fallback."""


# ---------------------------------------------------------------------------
# Live HTTP helpers (the defaults for the injectable post=/getf= params)
# ---------------------------------------------------------------------------

def _http_get(url: str, *, session_cookie: str, user_agent: str, sleep=time.sleep) -> dict:
    """GET `url` with the reddit_session cookie; parse JSON.

    Returns {} only for a genuine logged-out response (401/403) — the shape
    `_refresh_modhash` maps to RedditAuthError. Anything transient (timeouts, DNS,
    429/5xx, an unparseable CDN error page) raises RedditNetworkError instead.

    Honors a 429/5xx ``Retry-After`` and otherwise backs off with full jitter
    (de-risking §B) for a few attempts before giving up — so hydration stops hammering a
    rate-limited Reddit instead of treating the first 429 as a hard failure. ``sleep`` is
    injectable so the backoff is testable offline."""
    try:
        _status, _headers, raw = _http.request(
            url,
            method="GET",
            headers={
                "Cookie": f"reddit_session={session_cookie}",
                "Accept": "application/json",
                "User-Agent": user_agent,
            },
            timeout=20,
            retries=4, backoff=1.0, jitter=True, sleep=sleep,
        )
    except _http.HttpError as e:
        if e.status in (401, 403):
            return {}
        if e.status == 404:
            raise RedditNotFoundError(f"HTTP {e.status}") from e
        # Mirror the old messages: an HTTP error keeps "HTTP <code>"; transport
        # failures surface the underlying error string.
        if e.status is not None:
            raise RedditNetworkError(f"HTTP {e.status}") from e
        raise RedditNetworkError(str(e.__cause__)) from e
    try:
        return json.loads(raw.decode("utf-8", errors="replace"))
    except ValueError as e:
        raise RedditNetworkError("unparseable response") from e


def _http_post(url: str, fields: dict, *, session_cookie: str, modhash: str,
               user_agent: str) -> tuple[int, dict]:
    """POST urlencoded `fields`. Returns (status_code, response_headers); status 0 = network error."""
    data = urllib.parse.urlencode(fields).encode("utf-8")
    try:
        status, headers, _raw = _http.request(
            url,
            method="POST",
            data=data,
            headers={
                "Cookie": f"reddit_session={session_cookie}",
                "X-Modhash": modhash or "",
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": user_agent,
            },
            timeout=20,
        )
        return status, headers
    except _http.HttpError as e:
        # An HTTP error response is data here, not a failure: hand back its status +
        # headers (so 403 halts the drain, 429 carries Retry-After). Only a true
        # transport failure (no status) collapses to the (0, {}) sentinel.
        if e.status is not None:
            return e.status, e.headers
        return 0, {}


# ---------------------------------------------------------------------------
# Auth (auth_tokens table, service='reddit_web')
# ---------------------------------------------------------------------------

def get_auth(conn) -> dict | None:
    row = conn.execute(
        "SELECT access_token, refresh_token, username FROM auth_tokens WHERE service='reddit_web'"
    ).fetchone()
    if not row or not row["access_token"]:
        return None
    return {
        "session_cookie": row["access_token"],
        "modhash": row["refresh_token"],
        "username": row["username"],
    }


def set_auth(conn, *, session_cookie: str, modhash: str | None = None,
             username: str | None = None) -> None:
    """Upsert the reddit_web auth row. Preserves the existing modhash/username when the new
    value is None (so a drain's modhash refresh doesn't wipe the username, and vice versa)."""
    now = int(time.time())
    conn.execute(
        "INSERT INTO auth_tokens(service, access_token, refresh_token, token_type, username, updated_utc) "
        "VALUES('reddit_web', ?, ?, 'cookie', ?, ?) "
        "ON CONFLICT(service) DO UPDATE SET "
        "access_token=excluded.access_token, "
        "refresh_token=COALESCE(excluded.refresh_token, auth_tokens.refresh_token), "
        "username=COALESCE(excluded.username, auth_tokens.username), "
        "updated_utc=excluded.updated_utc",
        (session_cookie, modhash, username, now),
    )
    conn.commit()


def is_configured(conn) -> bool:
    return get_auth(conn) is not None


def cookie_user_agent() -> str:
    """User-Agent for the reddit_session-cookie transport: a real browser string
    (``REDDIT_BROWSER_USER_AGENT``) so an authenticated session blends in, rather than the
    generic script UA that still serves archives/youtube/karakeep. De-risking feature 3."""
    return config.get("REDDIT_BROWSER_USER_AGENT")


def login(conn, session_cookie: str, *, getf=None, user_agent: str | None = None) -> str:
    """Validate a reddit_session cookie via /api/me.json, store it, return the username.
    Raises RedditAuthError if the cookie is logged out or invalid."""
    user_agent = user_agent or cookie_user_agent()
    modhash, username = _refresh_modhash(session_cookie, user_agent=user_agent, getf=getf)
    set_auth(conn, session_cookie=session_cookie, modhash=modhash, username=username)
    return username


def count_pending(conn) -> int:
    return conn.execute(
        "SELECT COUNT(*) FROM reddit_unsave WHERE state='pending'"
    ).fetchone()[0]


def count_failed(conn) -> int:
    return conn.execute(
        "SELECT COUNT(*) FROM reddit_unsave WHERE state='failed'"
    ).fetchone()[0]


# ---------------------------------------------------------------------------
# Reddit web-session protocol
# ---------------------------------------------------------------------------

def _refresh_modhash(session_cookie: str, *, user_agent: str, getf=None) -> tuple[str, str]:
    """GET /api/me.json with the cookie -> (modhash, username). Raises RedditAuthError if the
    session is logged out or no modhash is returned."""
    getf = getf or _http_get
    body = getf(ME_URL, session_cookie=session_cookie, user_agent=user_agent) or {}
    data = body.get("data") or {}
    name = data.get("name")
    modhash = data.get("modhash")
    if not name:
        raise RedditAuthError("not logged in (reddit_session cookie missing or expired)")
    if not modhash:
        raise RedditAuthError("logged in but no modhash returned — cannot authorize unsave")
    return modhash, name


def _retry_after_seconds(headers: dict | None) -> float | None:
    """Numeric Retry-After value from a (case-insensitively searched) header dict.
    Delegates to the shared ``_http.retry_after_seconds`` (kept as a module-local name
    so ``_send_with_retry`` and the existing tests still reach it here): None when
    absent or non-numeric (e.g. an RFC 7231 HTTP-date), negative treated as absent."""
    return _http.retry_after_seconds(headers)


def _send_with_retry(post, url: str, reddit_id: str, *, session_cookie: str, modhash: str,
                     user_agent: str, sleep, max_retries: int = 3) -> tuple[bool, str | None]:
    """POST one save/unsave with 429 backoff. Returns (ok, error); raises RedditAuthError on 403."""
    fields = {"id": reddit_id, "uh": modhash}
    delay = 2.0
    for attempt in range(max_retries + 1):
        status, headers = post(
            url, fields, session_cookie=session_cookie, modhash=modhash, user_agent=user_agent
        )
        if status in (200, 201):
            return True, None
        if status == 403:
            raise RedditAuthError("Reddit returned 403 — cookie/modhash likely expired")
        if status == 429 and attempt < max_retries:
            ra = _retry_after_seconds(headers)
            sleep(ra if ra is not None else delay)
            delay *= 2
            continue
        return False, f"HTTP {status}"
    return False, "rate limited (max retries)"


def _oauth_write_transport(conn):
    """If OAuth is configured with a mintable access token, return a write transport tuple
    ``(post, user_agent)`` for the sanctioned save-scope path; else ``None`` (caller uses the
    cookie). The returned ``post`` matches ``_http_post``'s signature so ``_send_with_retry`` stays
    transport-agnostic — it ignores the cookie/modhash kwargs and authorizes with the bearer
    (which is also the CSRF token, so no modhash). Imported lazily: ``reddit_oauth`` imports from
    this module, so a top-level import would be circular.

    WRITES are the elevated-risk lane, so the OAuth path (Reddit's sanctioned programmatic budget)
    is strictly preferable to scripting the logged-in web endpoints with the session cookie."""
    from content_hoarder import reddit_oauth
    if not reddit_oauth.is_configured(conn):
        return None
    bearer = reddit_oauth.access_token(conn)          # None on a permanent refresh failure
    if not bearer:
        return None
    ua = reddit_oauth.oauth_user_agent(conn)

    def post(url, fields, *, session_cookie=None, modhash=None, user_agent=None):
        return reddit_oauth.oauth_post(url, {"id": fields["id"]}, bearer=bearer,
                                       user_agent=user_agent or ua)

    return post, ua


# ---------------------------------------------------------------------------
# Drain (batch, throttled, resumable) + undo re-save
# ---------------------------------------------------------------------------

def drain(conn, *, limit: int | None = None, throttle: float = 1.0, sleep=time.sleep,
          post=None, getf=None, user_agent: str | None = None, progress=None) -> dict:
    """Unsave pending queue rows on Reddit. Refreshes the modhash once up front and fails fast
    (auth_error, nothing sent) on a dead cookie. Returns a summary dict.

    Elevated-risk path (de-risking feature 6): programmatic WRITES are what Reddit's automated
    enforcement actually targets, so this is treated more cautiously than reads — it stays behind
    the approve-scope gate (``reddit_unsave_on_done`` + the enqueue step), paces with a *jittered*
    throttle floored at the global rate cap (no exact-interval fingerprint, never above ~100 QPM),
    honors ``Retry-After``, and 403-halts. Keep drains modest rather than mass-draining in one run."""
    # An injected post/getf (the cookie golden tests) forces the cookie path; check BEFORE the
    # `or _http_*` fallbacks reassign them. OAuth ships DORMANT — engages only after `--login`.
    injected = post is not None or getf is not None
    user_agent = user_agent or cookie_user_agent()
    throttle = max(throttle, _http.MIN_THROTTLE)
    result = {"selected": 0, "unsaved": 0, "failed": 0, "auth_error": False,
              "network_error": False, "transport": None, "remaining": count_pending(conn)}

    oauth = None if injected else _oauth_write_transport(conn)
    if oauth:
        # Sanctioned OAuth save path: bearer is the auth + CSRF, so no cookie/modhash refresh.
        send_post, ua = oauth
        unsave_url, session_cookie, modhash = OAUTH_UNSAVE_URL, "", ""
        result["transport"] = "oauth"
    else:
        send_post = post or _http_post
        getf = getf or _http_get
        ua = user_agent
        auth = get_auth(conn)
        if not auth:
            result["auth_error"] = True
            return result
        try:
            modhash, username = _refresh_modhash(
                auth["session_cookie"], user_agent=ua, getf=getf
            )
        except RedditAuthError:
            result["auth_error"] = True
            return result
        except RedditNetworkError:
            result["network_error"] = True  # Reddit unreachable — queue intact, retry later
            return result
        set_auth(conn, session_cookie=auth["session_cookie"], modhash=modhash, username=username)
        unsave_url, session_cookie = UNSAVE_URL, auth["session_cookie"]
        result["transport"] = "cookie"

    sql = "SELECT fullname, reddit_id FROM reddit_unsave WHERE state='pending' ORDER BY enqueued_utc"
    rows = (conn.execute(sql + " LIMIT ?", (limit,)) if limit else conn.execute(sql)).fetchall()
    result["selected"] = len(rows)

    for i, row in enumerate(rows):
        if i:  # jittered throttle between requests; don't pre-sleep the first
            sleep(_http.jittered_throttle(throttle))
        fullname, reddit_id = row["fullname"], row["reddit_id"]
        try:
            ok, err = _send_with_retry(
                send_post, unsave_url, reddit_id, session_cookie=session_cookie,
                modhash=modhash, user_agent=ua, sleep=sleep,
            )
        except RedditAuthError:
            result["auth_error"] = True
            break
        now = int(time.time())
        if ok:  # 200 incl. no-op for an already-unsaved item
            conn.execute("UPDATE reddit_unsave SET state='done', updated_utc=? WHERE fullname=?",
                         (now, fullname))
            conn.execute("UPDATE items SET is_saved=0 WHERE fullname=?", (fullname,))
            conn.commit()
            result["unsaved"] += 1
            if progress:
                progress(f"unsaved {reddit_id}")
        else:
            conn.execute(  # the CASE flip retires exhausted rows from future drains
                "UPDATE reddit_unsave SET attempts=attempts+1, last_error=?, updated_utc=?, "
                "state=CASE WHEN attempts+1 >= ? THEN 'failed' ELSE state END "
                "WHERE fullname=?", (err, now, MAX_ATTEMPTS, fullname))
            conn.commit()
            result["failed"] += 1
            if progress:
                progress(f"failed {reddit_id}: {err}")

    result["remaining"] = count_pending(conn)
    return result


def resave(conn, fullname: str, *, post=None, getf=None, user_agent: str | None = None) -> bool:
    """Best-effort re-save (undo of a drained 'done'). Returns True if Reddit accepted the save."""
    user_agent = user_agent or cookie_user_agent()
    injected = post is not None or getf is not None

    row = conn.execute(
        "SELECT reddit_id FROM reddit_unsave WHERE fullname=?", (fullname,)
    ).fetchone()
    if row and row["reddit_id"]:
        reddit_id = row["reddit_id"]
    else:  # fall back to the item's source_id (already carries the t3_/t1_ prefix)
        item = conn.execute(
            "SELECT source, source_id FROM items WHERE fullname=?", (fullname,)
        ).fetchone()
        if not item or item["source"] != "reddit":
            return False
        reddit_id = item["source_id"]

    # Same transport selection as drain: re-save over OAuth when configured (so undo works for an
    # OAuth-only setup), else the cookie. An injected post/getf forces the cookie path (golden).
    oauth = None if injected else _oauth_write_transport(conn)
    if oauth:
        send_post, ua = oauth
        save_url, session_cookie, modhash = OAUTH_SAVE_URL, "", ""
    else:
        send_post = post or _http_post
        getf = getf or _http_get
        ua = user_agent
        auth = get_auth(conn)
        if not auth:
            return False
        try:
            modhash, _username = _refresh_modhash(
                auth["session_cookie"], user_agent=ua, getf=getf
            )
        except (RedditAuthError, RedditNetworkError):
            return False
        save_url, session_cookie = SAVE_URL, auth["session_cookie"]

    try:
        ok, _err = _send_with_retry(
            send_post, save_url, reddit_id, session_cookie=session_cookie,
            modhash=modhash, user_agent=ua, sleep=time.sleep,
        )
    except RedditAuthError:
        return False
    if ok:
        conn.execute("UPDATE items SET is_saved=1 WHERE fullname=?", (fullname,))
        conn.execute("DELETE FROM reddit_unsave WHERE fullname=?", (fullname,))
        conn.commit()
    return ok
