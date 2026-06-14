# Spec 02 — Unify the 4 HTTP timeout/retry helpers

BACKLOG: Epic 19 #540. Branch: `feat/http-unify`. Touches: new `src/content_hoarder/_http.py`,
`archival/_http.py`, `reddit_unsave.py`, `youtube_recover.py`, `bridge/karakeep.py`.

## Goal

Replace 4 hand-rolled urllib helpers with **one shared transport primitive + thin per-caller
adapters**, deduplicating retry/`Retry-After` parsing — **without changing any caller's signature,
return shape, or error policy**, and **without breaking the offline injection seams**.

The 4 today (file:line):
- `archival/_http.py:25` `get_json(url, user_agent, timeout=20.0) -> (status, headers, json)`, raises `ArchiveError`.
- `reddit_unsave.py:42` `_http_get(url, *, session_cookie, user_agent) -> dict` (401/403→`{}`, else raise `RedditNetworkError`).
- `reddit_unsave.py:72` `_http_post(url, fields, *, session_cookie, modhash, user_agent) -> (int, dict)` (net err→`(0,{})`, never raises).
- `youtube_recover.py:40` `_http_get(url, ua=DEFAULT_USER_AGENT, timeout=20.0) -> str` (propagates errors).
- `bridge/karakeep.py:41` `_post(payload) -> dict|None` (`except Exception: return None`).

## Acceptance criteria

- New `content_hoarder/_http.py` with ONE primitive `request(...) -> (status, headers, raw_bytes)`
  and `retry_after_seconds(headers) -> float|None` (moved from `reddit_unsave.py:175`).
- All 5 helpers above keep their **exact names, signatures, return shapes, and error policies** —
  they become thin wrappers over `request`.
- The injection seams are unchanged (see below). All of `test_reddit_unsave.py`,
  `test_reddit_sync.py`, `test_reddit_hydrate.py`, `test_youtube_recover.py`, `test_archival.py`,
  `test_bridge_karakeep.py` stay green with NO edits.
- `ArchiveError` import paths (`providers.py:163`, `service.py:15`) still resolve.
- No new network in tests; full suite green vs the recorded baseline.

## Implementation

### New `_http.py` (top-level, sibling to config.py — NOT under archival/, which is "optional/removable")
```python
class HttpError(Exception):
    def __init__(self, msg, *, status=None, retry_after=None): ...
def retry_after_seconds(headers) -> float | None: ...   # case-insensitive; ignore HTTP-date/negative
def request(url, *, method="GET", headers=None, data=None, timeout=20.0,
            retries=0, backoff=2.0, sleep=time.sleep, user_agent=None) -> tuple[int, dict, bytes]:
    ...  # urllib Request+urlopen; on retries>0 retry 429/5xx with Retry-After-aware backoff
```

### Adapters (keep as the injectable defaults — names/sigs UNCHANGED)
- `archival/_http.py`: keep `get_json` + `ArchiveError` here (re-export `HttpError` as `ArchiveError`
  or subclass), wrapping `request`; preserve the `(status, headers, json)` triple and the
  status/retry_after carrying. Keep `providers._request`'s caller-side 429 loop as-is for now.
- `reddit_unsave._http_get/_http_post`: wrap `request`; preserve `{}`/401-403 and `(0,{})` sentinels
  (they are **semantically meaningful**, not just "empty"). Keep `_send_with_retry` and
  `_retry_after_seconds` — but have `_retry_after_seconds` delegate to `_http.retry_after_seconds`.
- `youtube_recover._http_get`: wrap `request`, `return raw.decode("utf-8","replace")`. **Keep
  positional `ua`** (stubs call `get(url)` and `get(url, ua, timeout)`).
- `karakeep._post`: wrap `request` (build URL + bearer inside), JSON-or-`None`.

## Injection seams that MUST survive (do not change these shapes)
- `reddit_unsave`: `post=post or _http_post`, `getf=getf or _http_get` (`:222-223,285-286`);
  `_send_with_retry(post, ..., sleep)` tested directly (`test_reddit_unsave.py:232-251`).
- `reddit_sync.py:74` / `reddit_hydrate.py:36`: `getf = getf or _http_get`. **`reddit_hydrate._http_get`
  is monkeypatched as a module attribute** (`test_reddit_hydrate.py:181`) — keep it importable there.
- `youtube_recover`: `get=_http_get` def-time default; stubs are positional incl. 1-arg `get(url)`.
- `archival/providers.py:138,142`: `get_json=get_json or _http.get_json`.
- `karakeep`: `monkeypatch.setattr(karakeep, "_post", ...)` (`test_bridge_karakeep.py:38`).

## Tests
- Baseline FIRST: `python -m pytest tests/test_archival.py tests/test_reddit_unsave.py
  tests/test_reddit_sync.py tests/test_reddit_hydrate.py tests/test_youtube_recover.py
  tests/test_bridge_karakeep.py` — record counts.
- Add unit tests for `_http.request` + `retry_after_seconds` (offline; inject a fake opener or test
  `retry_after_seconds` purely). Do not add network tests.

## Gotchas / scope guard
- **Return-shape divergence is the trap.** Do NOT collapse to a single return type — keep the adapters.
  Flag/abort any approach that changes a caller's return.
- **Do NOT fold `_send_with_retry` into `request(retries=)` in this pass** — it encodes a protocol
  (403→halt drain, per-row attempt cap, auth-vs-network UX). That's a riskier follow-up; out of scope here.
- UA inconsistency (youtube's `DEFAULT_USER_AGENT` vs `config.USER_AGENT`) — preserve per-caller UA;
  do NOT silently unify (it would change youtube's UA string).
- Fold the `providers._request:165` `float(e.retry_after)` (no date/negative guard) onto the shared
  `retry_after_seconds` as a deliberate, noted fix.
- Keep `archival/_http.py`'s "optional/removable" docstring true (re-export shim, or update the note).

## Risk
Backlog explicitly says "refactor risk > current pain — do opportunistically." Keep the diff
behavior-preserving and lean on the 6 test files as the safety net. If any test needs editing to pass,
STOP and reconsider — that signals a contract change.
