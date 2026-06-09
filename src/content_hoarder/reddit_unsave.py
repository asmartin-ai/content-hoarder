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
import urllib.error
import urllib.parse
import urllib.request

from content_hoarder import config

UNSAVE_URL = "https://www.reddit.com/api/unsave"
SAVE_URL = "https://www.reddit.com/api/save"
ME_URL = "https://www.reddit.com/api/me.json"

# Per-row drain-failure cap: a permanently-erroring item (e.g. Reddit answers 400 for it
# forever) flips to state='failed' instead of re-consuming the ~1 req/s throttle every run.
MAX_ATTEMPTS = 5


class RedditAuthError(Exception):
    """Cookie expired / logged out / 403 — halts the drain; surfaced loudly to the user."""


class RedditNetworkError(Exception):
    """Transient transport/server failure — NOT an auth problem; retry later. Kept distinct
    so a network blip never tells the user to re-paste a perfectly good cookie."""


# ---------------------------------------------------------------------------
# Live HTTP helpers (the defaults for the injectable post=/getf= params)
# ---------------------------------------------------------------------------

def _http_get(url: str, *, session_cookie: str, user_agent: str) -> dict:
    """GET `url` with the reddit_session cookie; parse JSON.

    Returns {} only for a genuine logged-out response (401/403) — the shape
    `_refresh_modhash` maps to RedditAuthError. Anything transient (timeouts, DNS,
    429/5xx, an unparseable CDN error page) raises RedditNetworkError instead."""
    req = urllib.request.Request(
        url,
        headers={
            "Cookie": f"reddit_session={session_cookie}",
            "Accept": "application/json",
            "User-Agent": user_agent,
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            return {}
        raise RedditNetworkError(f"HTTP {e.code}") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise RedditNetworkError(str(e)) from e
    try:
        return json.loads(body)
    except ValueError as e:
        raise RedditNetworkError("unparseable response") from e


def _http_post(url: str, fields: dict, *, session_cookie: str, modhash: str,
               user_agent: str) -> tuple[int, dict]:
    """POST urlencoded `fields`. Returns (status_code, response_headers); status 0 = network error."""
    data = urllib.parse.urlencode(fields).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Cookie": f"reddit_session={session_cookie}",
            "X-Modhash": modhash or "",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": user_agent,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return getattr(resp, "status", 200) or 200, dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {})
    except (urllib.error.URLError, TimeoutError, OSError):
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


def login(conn, session_cookie: str, *, getf=None, user_agent: str | None = None) -> str:
    """Validate a reddit_session cookie via /api/me.json, store it, return the username.
    Raises RedditAuthError if the cookie is logged out or invalid."""
    user_agent = user_agent or config.get("USER_AGENT")
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
    None when absent or non-numeric (e.g. an RFC 7231 HTTP-date) — caller falls back
    to its own backoff delay. Case-insensitive because the headers arrive as a plain
    dict (``dict(resp.headers)``) with whatever casing the server sent."""
    if not headers:
        return None
    ra = next((v for k, v in headers.items() if k.lower() == "retry-after"), None)
    if not ra:
        return None
    try:
        seconds = float(ra)
    except (TypeError, ValueError):
        return None
    return seconds if seconds >= 0 else None


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


# ---------------------------------------------------------------------------
# Drain (batch, throttled, resumable) + undo re-save
# ---------------------------------------------------------------------------

def drain(conn, *, limit: int | None = None, throttle: float = 1.0, sleep=time.sleep,
          post=None, getf=None, user_agent: str | None = None, progress=None) -> dict:
    """Unsave pending queue rows on Reddit (~1 req/sec). Refreshes the modhash once up front and
    fails fast (auth_error, nothing sent) on a dead cookie. Returns a summary dict."""
    post = post or _http_post
    getf = getf or _http_get
    user_agent = user_agent or config.get("USER_AGENT")
    result = {"selected": 0, "unsaved": 0, "failed": 0, "auth_error": False,
              "network_error": False, "remaining": count_pending(conn)}

    auth = get_auth(conn)
    if not auth:
        result["auth_error"] = True
        return result
    try:
        modhash, username = _refresh_modhash(
            auth["session_cookie"], user_agent=user_agent, getf=getf
        )
    except RedditAuthError:
        result["auth_error"] = True
        return result
    except RedditNetworkError:
        result["network_error"] = True  # Reddit unreachable — queue intact, retry later
        return result
    set_auth(conn, session_cookie=auth["session_cookie"], modhash=modhash, username=username)

    sql = "SELECT fullname, reddit_id FROM reddit_unsave WHERE state='pending' ORDER BY enqueued_utc"
    rows = (conn.execute(sql + " LIMIT ?", (limit,)) if limit else conn.execute(sql)).fetchall()
    result["selected"] = len(rows)

    for i, row in enumerate(rows):
        if i:  # throttle between requests; don't pre-sleep the first
            sleep(throttle)
        fullname, reddit_id = row["fullname"], row["reddit_id"]
        try:
            ok, err = _send_with_retry(
                post, UNSAVE_URL, reddit_id, session_cookie=auth["session_cookie"],
                modhash=modhash, user_agent=user_agent, sleep=sleep,
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
    post = post or _http_post
    getf = getf or _http_get
    user_agent = user_agent or config.get("USER_AGENT")
    auth = get_auth(conn)
    if not auth:
        return False

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

    try:
        modhash, username = _refresh_modhash(
            auth["session_cookie"], user_agent=user_agent, getf=getf
        )
    except (RedditAuthError, RedditNetworkError):
        return False
    try:
        ok, _err = _send_with_retry(
            post, SAVE_URL, reddit_id, session_cookie=auth["session_cookie"],
            modhash=modhash, user_agent=user_agent, sleep=time.sleep,
        )
    except RedditAuthError:
        return False
    if ok:
        conn.execute("UPDATE items SET is_saved=1 WHERE fullname=?", (fullname,))
        conn.execute("DELETE FROM reddit_unsave WHERE fullname=?", (fullname,))
        conn.commit()
    return ok
