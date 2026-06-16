"""Reddit OAuth2 read-only transport (installed-app, no client secret).

The sanctioned + durable + lower-risk alternative to scripting a logged-in browser session
(de-risking feature 5). Uses an *installed app* client id — a PUBLIC id such as RedReader's,
configured via ``REDDIT_OAUTH_CLIENT_ID`` — with the read-only ``read`` scope and a permanent
refresh token. There is **no client secret**.

One-time setup (interactive, via ``reddit-oauth --login``): we print an authorize URL; the user
approves it in a browser; Reddit redirects to the app's registered redirect URI (which a local
app can't actually receive — the user just copies the redirected URL out of the address bar and
pastes it back). We exchange the ``code`` for an access + refresh token; the refresh token is
stored in the local DB (``auth_tokens``, ``service='reddit_oauth'``) — never the repo. Thereafter
the short-lived access token is refreshed on expiry.

Requests hit ``https://oauth.reddit.com`` with ``Authorization: bearer <token>`` and a
Reddit-compliant descriptive User-Agent. The JSON shape matches the public ``.json`` endpoints,
so hydration parsing is unchanged. All network is injectable (``post=``/``getf=``) for offline
tests. See ``docs/reddit-derisking.md``.
"""

from __future__ import annotations

import base64
import json
import secrets
import time
import urllib.parse

from content_hoarder import _http, config
from content_hoarder.reddit_unsave import RedditNetworkError, RedditNotFoundError

AUTHORIZE_URL = "https://www.reddit.com/api/v1/authorize"
ACCESS_TOKEN_URL = "https://www.reddit.com/api/v1/access_token"  # noqa: S105 (public endpoint, not a secret)
OAUTH_API_BASE = "https://oauth.reddit.com"
ME_URL = OAUTH_API_BASE + "/api/v1/me"
DEFAULT_REDIRECT_URI = "redreader://rr_oauth_redir"  # RedReader's registered installed-app URI
SCOPE = "read"

_SERVICE = "reddit_oauth"
_ACCESS_TTL = 3600    # Reddit access tokens live ~1h
_REFRESH_SKEW = 300   # refresh this many seconds BEFORE expiry (clock-skew / latency margin)
_APP_VERSION = "0.2"


class RedditOAuthError(Exception):
    """OAuth setup/refresh failed in a way the user must act on (bad code, revoked grant, missing
    client id). Distinct from the transient ``RedditNetworkError`` so the CLI messages correctly."""


# ---------------------------------------------------------------------------
# Config helpers
# ---------------------------------------------------------------------------

def client_id() -> str:
    return config.get("REDDIT_OAUTH_CLIENT_ID").strip()


def redirect_uri() -> str:
    return config.get("REDDIT_OAUTH_REDIRECT_URI").strip() or DEFAULT_REDIRECT_URI


def oauth_user_agent(conn=None, *, username: str | None = None) -> str:
    """A Reddit-compliant descriptive UA: ``platform:appid:version (by /u/user)``. Uses the
    authed username when available (better compliance), else omits the ``(by /u/…)`` suffix."""
    if username is None and conn is not None:
        row = _row(conn)
        username = row["username"] if row else None
    suffix = f" (by /u/{username})" if username else ""
    return f"windows:content-hoarder:{_APP_VERSION}{suffix}"


# ---------------------------------------------------------------------------
# Token storage (auth_tokens, service='reddit_oauth')
# ---------------------------------------------------------------------------

def _row(conn):
    return conn.execute(
        "SELECT access_token, refresh_token, token_type, username, updated_utc "
        "FROM auth_tokens WHERE service=?", (_SERVICE,)
    ).fetchone()


def is_configured(conn) -> bool:
    """True once a refresh token is stored (i.e. the one-time login completed)."""
    row = _row(conn)
    return bool(row and row["refresh_token"])


def status(conn) -> dict:
    """Inspect summary for the CLI (no secrets in it)."""
    row = _row(conn)
    return {
        "configured": is_configured(conn),
        "client_id_set": bool(client_id()),
        "username": row["username"] if row else None,
        "redirect_uri": redirect_uri(),
    }


def _store(conn, *, refresh_token=None, access_token=None, username=None, now=None) -> None:
    """Upsert the reddit_oauth row. ``updated_utc`` marks when the ACCESS token was minted (used
    for expiry). Preserves the existing refresh_token/username when the new value is None — a
    refresh keeps the same refresh token + username (Reddit doesn't rotate refresh tokens)."""
    now = now if now is not None else int(time.time())
    conn.execute(
        "INSERT INTO auth_tokens(service, access_token, refresh_token, token_type, username, updated_utc) "
        "VALUES(?, ?, ?, 'bearer', ?, ?) "
        "ON CONFLICT(service) DO UPDATE SET "
        "access_token=excluded.access_token, "
        "refresh_token=COALESCE(excluded.refresh_token, auth_tokens.refresh_token), "
        "username=COALESCE(excluded.username, auth_tokens.username), "
        "updated_utc=excluded.updated_utc",
        (_SERVICE, access_token, refresh_token, username, now),
    )
    conn.commit()


def clear(conn) -> None:
    conn.execute("DELETE FROM auth_tokens WHERE service=?", (_SERVICE,))
    conn.commit()


# ---------------------------------------------------------------------------
# One-time authorize + code exchange
# ---------------------------------------------------------------------------

def new_state() -> str:
    return secrets.token_urlsafe(16)


def build_authorize_url(*, state: str, client_id_: str | None = None,
                        redirect_uri_: str | None = None, scope: str = SCOPE,
                        duration: str = "permanent") -> str:
    cid = client_id_ or client_id()
    if not cid:
        raise RedditOAuthError("REDDIT_OAUTH_CLIENT_ID is not set (.env or env var).")
    params = {
        "client_id": cid,
        "response_type": "code",
        "state": state,
        "redirect_uri": redirect_uri_ or redirect_uri(),
        "duration": duration,
        "scope": scope,
    }
    return AUTHORIZE_URL + "?" + urllib.parse.urlencode(params)


def parse_redirect(redirect: str, *, expected_state: str) -> str:
    """Extract the auth ``code`` from the redirected URL the user pasted (also accepts a bare
    ``key=val&…`` query or just the raw code). Validates ``state`` (CSRF) when present and
    surfaces an ``error=`` param. Returns the code; raises RedditOAuthError otherwise."""
    s = (redirect or "").strip()
    query = urllib.parse.urlsplit(s).query if "?" in s else s
    params = dict(urllib.parse.parse_qsl(query))
    if "error" in params:
        raise RedditOAuthError(f"Reddit denied authorization: {params['error']}")
    if "code" in params:
        if params.get("state") != expected_state:
            raise RedditOAuthError("state mismatch — possible CSRF; restart `reddit-oauth --login`.")
        return params["code"]
    if s and "=" not in s and "&" not in s:   # user pasted just the code
        return s
    raise RedditOAuthError("no authorization code found in the pasted redirect.")


# ---------------------------------------------------------------------------
# Token endpoint (HTTP Basic with client_id and an empty secret)
# ---------------------------------------------------------------------------

def _basic_auth(cid: str) -> str:
    return "Basic " + base64.b64encode(f"{cid}:".encode()).decode()


def _default_token_post(url: str, fields: dict, *, client_id: str) -> dict:
    """POST form-encoded ``fields`` to the access_token endpoint with HTTP Basic (client_id:'').
    Returns the parsed JSON. Injectable via the ``post=`` params for offline tests."""
    data = urllib.parse.urlencode(fields).encode("utf-8")
    try:
        _status, _headers, raw = _http.request(
            url, method="POST", data=data,
            headers={
                "Authorization": _basic_auth(client_id),
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": oauth_user_agent(),
                "Accept": "application/json",
            },
            timeout=20, retries=3, backoff=1.0, jitter=True,
        )
    except _http.HttpError as e:
        if e.status in (400, 401, 403):
            raise RedditOAuthError(
                f"token endpoint rejected the request (HTTP {e.status}) — check the client id, "
                f"redirect uri, and that the code/refresh token is valid.") from e
        raise RedditNetworkError(f"token endpoint: HTTP {e.status or e}") from e
    try:
        body = json.loads(raw.decode("utf-8", errors="replace"))
    except ValueError as e:
        raise RedditNetworkError("token endpoint: unparseable response") from e
    if isinstance(body, dict) and body.get("error"):
        raise RedditOAuthError(f"token endpoint error: {body['error']}")
    return body


def exchange_code(code: str, *, client_id_: str | None = None,
                  redirect_uri_: str | None = None, post=None) -> dict:
    """Exchange an authorization ``code`` for an access + refresh token."""
    cid = client_id_ or client_id()
    post = post or _default_token_post
    return post(
        ACCESS_TOKEN_URL,
        {"grant_type": "authorization_code", "code": code,
         "redirect_uri": redirect_uri_ or redirect_uri()},
        client_id=cid,
    )


def refresh_access_token(refresh_token: str, *, client_id_: str | None = None, post=None) -> dict:
    """Mint a fresh access token from the stored refresh token."""
    cid = client_id_ or client_id()
    post = post or _default_token_post
    return post(
        ACCESS_TOKEN_URL,
        {"grant_type": "refresh_token", "refresh_token": refresh_token},
        client_id=cid,
    )


# ---------------------------------------------------------------------------
# Runtime: read transport + access-token management
# ---------------------------------------------------------------------------

def oauth_get(url: str, *, bearer: str, user_agent: str, sleep=time.sleep) -> dict:
    """GET an oauth.reddit.com URL with a bearer token; parse JSON. Same contract as the cookie
    ``_http_get``: ``{}`` for 401/403 (token invalid -> re-auth), RedditNotFoundError for 404,
    RedditNetworkError for transient/429/5xx (after Retry-After + full-jitter backoff). ``sleep``
    is injectable so the backoff is testable offline."""
    try:
        _status, _headers, raw = _http.request(
            url, method="GET",
            headers={
                "Authorization": f"bearer {bearer}",
                "Accept": "application/json",
                "User-Agent": user_agent,
            },
            timeout=20, retries=4, backoff=1.0, jitter=True, sleep=sleep,
        )
    except _http.HttpError as e:
        if e.status in (401, 403):
            return {}
        if e.status == 404:
            raise RedditNotFoundError(f"HTTP {e.status}") from e
        if e.status is not None:
            raise RedditNetworkError(f"HTTP {e.status}") from e
        raise RedditNetworkError(str(e.__cause__)) from e
    try:
        return json.loads(raw.decode("utf-8", errors="replace"))
    except ValueError as e:
        raise RedditNetworkError("unparseable response") from e


def access_token(conn, *, post=None, now=None) -> str | None:
    """Return a valid bearer access token, refreshing on (near-)expiry. ``None`` when not
    configured or a refresh permanently fails (the caller then falls back to the cookie). A
    transient refresh failure reuses the current token if one is still cached."""
    row = _row(conn)
    if not row or not row["refresh_token"]:
        return None
    now = now if now is not None else int(time.time())
    minted = row["updated_utc"] or 0
    if row["access_token"] and (now - minted) < (_ACCESS_TTL - _REFRESH_SKEW):
        return row["access_token"]
    try:
        tok = refresh_access_token(row["refresh_token"], post=post)
    except RedditOAuthError:
        return None                              # grant revoked / bad client -> cookie fallback
    except RedditNetworkError:
        return row["access_token"] or None       # transient -> reuse current token if any
    access = tok.get("access_token")
    if not access:
        return row["access_token"] or None
    _store(conn, refresh_token=tok.get("refresh_token"), access_token=access, now=now)
    return access


def _fetch_username(token: str, *, getf=None) -> str | None:
    """Best-effort: the authed username from /api/v1/me (for the compliant UA). None on any error."""
    getf = getf or oauth_get
    try:
        me = getf(ME_URL, bearer=token, user_agent=oauth_user_agent())
    except (RedditNetworkError, RedditNotFoundError):
        return None
    return (me.get("name") or None) if isinstance(me, dict) else None


def login(conn, redirect_response: str, *, expected_state: str, post=None, getf=None,
          now=None) -> str:
    """Complete the one-time flow: validate + exchange the pasted redirect, fetch the username for
    the compliant UA, and store the refresh + access token. Returns the username ('' if unknown)."""
    code = parse_redirect(redirect_response, expected_state=expected_state)
    tok = exchange_code(code, post=post)
    refresh = tok.get("refresh_token")
    access = tok.get("access_token")
    if not refresh or not access:
        raise RedditOAuthError(
            "token response missing a refresh/access token — request duration=permanent + scope=read.")
    username = _fetch_username(access, getf=getf)
    _store(conn, refresh_token=refresh, access_token=access, username=username, now=now)
    return username or ""
