# Distinguish network failure from "cookie expired" in unsave/sync

## Model: qwen-3.6 (thinking on) — touches reddit_unsave.py, reddit_sync.py, cli.py, tests

`_http_get` returns `{}` on **any** failure — DNS error, timeout, 429, 5xx. `_refresh_modhash`
then raises `RedditAuthError("not logged in …")`, so a transient network blip makes the
scheduled drain exit with "cookie expired" and the UI tells the user to re-paste their cookie
when nothing is wrong.

## Context — src/content_hoarder/reddit_unsave.py

```python
class RedditAuthError(Exception):
    """Cookie expired / logged out / 403 — halts the drain; surfaced loudly to the user."""


def _http_get(url: str, *, session_cookie: str, user_agent: str) -> dict:
    """GET `url` with the reddit_session cookie; parse JSON. Returns {} on any failure."""
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
            return json.loads(resp.read().decode("utf-8", errors="replace"))
    except Exception:  # noqa: BLE001 - any failure means "no usable session"
        return {}


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
```

`drain(conn, ...)` initializes
`result = {"selected": 0, "unsaved": 0, "failed": 0, "auth_error": False, "remaining": ...}`,
then:
```python
    try:
        modhash, username = _refresh_modhash(
            auth["session_cookie"], user_agent=user_agent, getf=getf
        )
    except RedditAuthError:
        result["auth_error"] = True
        return result
```

`resave(conn, fullname, ...)` calls `_refresh_modhash` inside `try/except RedditAuthError:
return False`.

## Context — src/content_hoarder/reddit_sync.py

`sync_saved_cookie` initializes
`result = {"fetched": 0, "new": 0, "updated": 0, "pages": 0, "stopped": None,
"auth_error": False, "username": None}`. It calls `_refresh_modhash` (wrapped in
`except RedditAuthError` → `auth_error=True, stopped="auth_error"`), then loops pages:
```python
        body = getf(base + "?" + urllib.parse.urlencode(params),
                    session_cookie=auth["session_cookie"], user_agent=user_agent) or {}
        data = body.get("data") or {}
        children = data.get("children") or []
        if not children:
            result["stopped"] = "empty" if page == 0 else "exhausted"
            break
```
The high-water mark only advances when `result["stopped"]` is in
`("caught_up", "exhausted", "all_known")` or it's the first sync. **An "empty"/"exhausted"
verdict caused by a network failure would be wrong** — it must become `network_error` so the
mark logic and the user see the truth.

`cli.py`: `cmd_reddit_sync` does `return 1 if res.get("auth_error") else 0`;
`cmd_reddit_unsave --drain` likewise.

## Requirements

1. `reddit_unsave.py`: add
   ```python
   class RedditNetworkError(Exception):
       """Transient transport/server failure — NOT an auth problem; retry later."""
   ```
2. Rewrite `_http_get` to distinguish:
   - `urllib.error.HTTPError` with code 401/403 → return `{}` (genuine logged-out shape);
   - any other `HTTPError` (429, 5xx, …) → raise `RedditNetworkError(f"HTTP {code}")`;
   - `URLError` / `TimeoutError` / `OSError` → raise `RedditNetworkError(str(e))`;
   - JSON parse failure of a 200 body → raise `RedditNetworkError("unparseable response")`
     (a CDN error page is not "logged out").
   Keep the signature and docstring shape; update the docstring.
3. `_refresh_modhash`: let `RedditNetworkError` propagate (no change needed beyond the
   docstring mentioning it).
4. `drain`: add `"network_error": False` to the initial result dict; wrap the
   `_refresh_modhash` call's except into two arms — `RedditAuthError` → `auth_error=True`;
   `RedditNetworkError` → `network_error=True`; both return early.
5. `resave`: also `except RedditNetworkError: return False`.
6. `reddit_sync.sync_saved_cookie`: add `"network_error": False` to its result dict; the
   `_refresh_modhash` wrap gets the same two arms (`stopped="auth_error"` /
   `stopped="network_error"`). Wrap the per-page `getf(...)` call:
   `except RedditNetworkError` → `network_error=True, stopped="network_error", break`.
   Do **not** add `network_error` to the mark-advance allowlist.
7. `cli.py`: both commands exit non-zero on `network_error` too, and print which one it was
   to stderr (e.g. `"network error — Reddit unreachable; will retry next run"` vs the
   existing cookie message).
8. Tests:
   - `tests/test_reddit_unsave.py`: a `getf` that raises `ru.RedditNetworkError("boom")` →
     `drain` returns `network_error=True, auth_error=False, selected==0` (nothing sent).
   - `tests/test_reddit_sync.py` (existing style: inject `getf`, seed the mark via
     `db.set_setting(conn, "reddit_sync_newest", ...)`): with a mark set and `getf` raising →
     `stopped == "network_error"` and the stored mark is **unchanged**.
   - Existing tests inject `getf` stubs returning `{}` for logged-out — they must still pass
     unmodified (returning `{}` keeps meaning "logged out").

## Constraints

- Injectable seams (`getf=`, `post=`, `sleep=`) keep their signatures.
- `_http_post`'s "status 0 = network error" contract is unchanged (per-item send failures
  already count as per-item failures; this prompt is about the *session check* path).
- Web routes need no changes (they serialize the result dicts as-is).

## Acceptance

`python -m pytest tests/test_reddit_unsave.py tests/test_reddit_sync.py --basetemp .pytest-tmp -q`

## Output

Unified diff only (reddit_unsave.py, reddit_sync.py, cli.py, both test files).
