# Fix Retry-After handling in the Reddit unsave drain

## Model: devstral

Two stacked bugs in `src/content_hoarder/reddit_unsave.py`:

1. Response headers are converted to a **plain dict** (`dict(resp.headers)` /
   `dict(e.headers or {})`), so `headers.get("Retry-After")` is **case-sensitive**. A server
   sending `retry-after` (lowercase) silently bypasses the honored delay.
2. `float(ra)` is **unguarded**. RFC 7231 allows an HTTP-date in Retry-After
   (e.g. `Fri, 31 Dec 1999 23:59:59 GMT`); a non-numeric value raises `ValueError` and
   crashes the whole drain mid-queue.

## Context — current code (src/content_hoarder/reddit_unsave.py)

```python
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
            ra = headers.get("Retry-After") if headers else None
            sleep(float(ra) if ra else delay)
            delay *= 2
            continue
        return False, f"HTTP {status}"
    return False, "rate limited (max retries)"
```

## Requirements

1. Add a module-level helper:
   ```python
   def _retry_after_seconds(headers: dict | None) -> float | None:
       """Numeric Retry-After value from a (case-insensitively searched) header dict.
       None when absent or non-numeric (e.g. an RFC 7231 HTTP-date) — caller falls back
       to its own backoff delay."""
   ```
   - Scan `headers` keys case-insensitively (plain dicts arrive from `dict(resp.headers)`).
   - `float(...)` wrapped in try/except `(TypeError, ValueError)` → `None`.
   - Negative values → `None` (treat as malformed).
2. In `_send_with_retry`, replace the two `ra` lines with:
   `ra = _retry_after_seconds(headers)` then `sleep(ra if ra is not None else delay)`.
3. Add tests to `tests/test_reddit_unsave.py` (it already has a `_Post` recorder class whose
   `decide(fields)` returns `(status, headers)`, and tests inject `sleep` as a recording
   lambda). New tests, calling `ru._send_with_retry(...)` directly with a recording sleep:
   - lowercase `{"retry-after": "7"}` on a 429 then 200 → sleep called with `7.0`, returns ok.
   - `{"Retry-After": "Fri, 31 Dec 1999 23:59:59 GMT"}` on a 429 then 200 → **no exception**,
     sleep called with `2.0` (the default first delay), returns ok.
   - `{"Retry-After": "-5"}` → falls back to `2.0`.

## Constraints

- Do not change any function signature.
- Do not touch `_http_post` (the plain-dict conversion is fine once the lookup is
  case-insensitive).
- Keep comment style: explain *why* (HTTP-date form, case-insensitivity), one or two lines.

## Acceptance

`python -m pytest tests/test_reddit_unsave.py --basetemp .pytest-tmp -q` — all pass,
including the 3 new tests.

## Output

Unified diff only (reddit_unsave.py + test_reddit_unsave.py).
