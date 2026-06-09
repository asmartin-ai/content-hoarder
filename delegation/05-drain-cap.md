# Cap the web drain route per request

## Model: devstral

`POST /reddit/unsave/drain` in `src/content_hoarder/web.py` drains the **entire** queue in one
HTTP request at ~1 req/sec — a 2,000-item queue is a 30+ minute request (the UI's button hangs
and times out). Also, `int(mx)` on a malformed JSON value raises an unhandled 500.

## Context — current code (src/content_hoarder/web.py)

```python
def _int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default
```
```python
    @app.post("/reddit/unsave/drain")
    def reddit_unsave_drain():
        from content_hoarder import reddit_unsave as ru
        body = request.get_json(silent=True) or {}
        mx = body.get("max")
        with conn() as c:
            res = ru.drain(c, limit=int(mx) if mx else None)
        return jsonify(res)
```

`ru.drain(conn, limit=...)` already accepts a limit and its result dict already includes
`"remaining"` (pending count after the run), so a caller can loop until 0.

## Requirements

1. Replace the body of `reddit_unsave_drain`:
   - `limit = _int(body.get("max"), 50)` — default cap 50 (≈50 s of throttled requests; the
     CLI/scheduled job is the right tool for big drains — say so in a short comment).
   - Clamp to `1..500`: `limit = min(max(limit, 1), 500)`.
   - Pass `limit=limit` always (never `None`).
2. Tests in `tests/test_web.py` (existing style: build the app with
   `web.create_app(tmp_db)`, use `app.test_client()`):
   - `POST /reddit/unsave/drain` with body `{"max": "garbage"}` → **200**, not 500 (auth is
     unconfigured in the test DB so the result has `auth_error: True`; the point is no crash).
   - With no body at all → 200.

## Constraints

- Only this route changes; `/reddit/sync`'s similar `int(mp)` is a **separate** prompt
  (delegation/06) — do not touch it here.
- `ru.drain` itself is untouched.

## Acceptance

`python -m pytest tests/test_web.py --basetemp .pytest-tmp -q`

## Output

Unified diff only (web.py + test_web.py).
