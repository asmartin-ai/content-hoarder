# archive.today Recovery Provider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `archive.today` (archive.ph) as a last-resort, per-item media-recovery provider that runs *after* the existing PullPush/Arctic metadata chain in `recover_one()`, downloading still-surviving image bytes for items whose originals are already 404.

**Architecture:** A new `ArchiveTodayProvider` in `archival/providers.py` — *not* a subclass of the id-keyed `ArchiveProvider` (that contract is reddit-id + JSON + metadata-only; archive.today is URL-keyed + HTML + media-bytes). It exposes a single method `recover_media(item) -> {url, bytes, mime, ...}` and plugs into `recover_one()` as an explicit **post-chain** step. Bytes flow through the existing `media_store.store()` (content-addressed, dedup, same-origin `/media/<blob>`), recorded on `metadata.archived_media` like the `media_archive.py` pass — so the frontend's prefer-local + 404-fallback already works with **zero frontend change**. Fetcher + HTML parser are injectable → fully offline tests.

**Tech Stack:** Python 3.12, stdlib `urllib` (via existing `content_hoarder._http`), `html.parser` / regex for snapshot parsing, existing `media_store` blob store. No new deps.

---

## Background — why this shape, not "a new provider in the chain"

The existing recovery chain (`archival/providers.py`) is reddit-**id**-keyed:
`recover_one()` → loop `[PullPush, Arctic]` → first that returns `meaningful=True` (a real
title/body) wins, by **bare base36 id**. Metadata only.

`archive.today` is a **different beast**:
- **URL-keyed**, not id-keyed. Its entry point is `https://archive.ph/newest/<original_url>`
  (a redirect to the latest snapshot).
- Returns **HTML**, not JSON.
- Stores the **original page with inlined images** — i.e. it can recover **media bytes** the
  metadata archives never had. This is its unique value: for the ~2,394 `media_status='gone'`
  items, PullPush/Arctic give us *nothing* (they store metadata + dead preview URLs); archive.today
  *may* hold the actual image bytes.
- **Cloudflare-gated, rate-limited, no bulk API.** → per-item only, never a bulk pass. This is why
  it wires into the on-demand `recover_one()` ("↻ Recover" button), NOT `recover()` (the bulk CLI).

So it runs as a **post-chain step in `recover_one()`**: after PullPush/Arctic have done their
metadata best (and `media_status` is still `gone`), try archive.today for the bytes. If PullPush
already recovered a live image, archive.today is a no-op (we have a better source).

## What "recovery" means here, concretely

For a reddit image post whose `i.redd.it`/`preview.redd.it` URLs are all 404
(`media_status='gone'`), archive.today recovery produces:
- **`metadata.archived_media[<snapshot_img_url>] = <blob_id>`** — the bytes stored locally via
  `media_store`, served same-origin at `/media/<blob>`.
- **`metadata.media_status = 'recovered_archive_today'`** — so the item visibly moves out of `gone`.
- The frontend `core/media.js` already prefers `archived_media` and falls back to it on remote 404
  → **the image just starts rendering again**, no UI change.

It does **not** touch title/body — those are PullPush/Arctic's job (already done by the time
archive.today runs).

## File Structure

- **Modify:** `src/content_hoarder/archival/providers.py` — add `ArchiveTodayProvider` class +
  `default_media_providers()` factory. (Lives with the other providers; shares `_http` + `ArchiveError`.)
- **Modify:** `src/content_hoarder/archival/service.py` — add `_try_archive_today()` helper, call it
  from `recover_one()` as a post-chain step; extend the returned dict.
- **Create:** `tests/test_archive_today.py` — provider + service tests, all offline (injected
  fetchers/parsers).
- **No change to:** `web.py` (the `POST /items/<fn>/recover` route already calls `recover_one`),
  `cli.py` (no new bulk pass — per-item only by design), any frontend file.

No new files in `src/` — the provider belongs in the existing `archival/` package.

---

## Local-LLM delegation strategy

Two tasks are pure, well-specified codegen with no judgment calls and are ideal for the local
LLM bridge (Devstral/Qwen) to preserve cloud quota — they're marked **[DELEGATE]** below. The
rest needs the agent's codebase judgment (wiring, test design, verification).

| Task | Delegate? | Why |
|------|-----------|-----|
| Task 1: `ArchiveTodayProvider` class | **[DELEGATE]** | Self-contained, exact spec given (method signature, regex, return shape). Pure codegen. |
| Task 2: service wiring (`_try_archive_today` + `recover_one` edit) | No | Touches existing control flow; needs care to keep PullPush/Arctic semantics intact. |
| Task 3: tests | No | Test design taste + must mirror the real `recover_one` flow. |
| Task 4: live smoke + docs | No | Judgment + verification. |

**Delegate guardrails** (from AGENTS.md): after any delegated code → `python -m py_compile` the
file + grep for un-awaited async calls (N/A here — synchronous code, but still compile-check).
The delegate gets the exact surrounding code as context.

---

## Task 1: `ArchiveTodayProvider` class  **[DELEGATE to local LLM]**

**Files:**
- Modify: `src/content_hoarder/archival/providers.py` (append at end of file, before `default_providers`)

A URL-keyed provider that recovers **media bytes** for an item from archive.today snapshots. It does
NOT subclass `ArchiveProvider` (that's id-keyed + JSON). Self-contained: one public method.

**Exact spec for the delegate** (paste to the local-LLM bridge along with the file's existing
`_http` import + `ArchiveError` usage + `_PLACEHOLDERS`):

```python
class ArchiveTodayProvider:
    """Recover media bytes for a reddit item from archive.today snapshots.

    archive.today stores the original page with inlined images, so it can recover
    the actual bytes for images whose i.redd.it / preview.redd.it originals are now
    404 (media_status='gone') — something the PullPush/Arctic metadata archives
    cannot do (they store metadata + dead preview URLs only).

    URL-keyed (not id-keyed), HTML (not JSON), Cloudflare-gated, no bulk API →
    per-item only, wired into recover_one() as a post-chain step. Fetcher + HTML
    parser are injectable for offline tests.
    """
    name = "archive_today"
    NEWEST = "https://archive.ph/newest/{url}"
    # og:image meta + inlined <img src>. archive.today stores images on its own CDN
    # (101010...) or proxies the original host. We collect candidate image URLs and
    # let the caller fetch+validate them.
    _OG_IMAGE = re.compile(r'<meta\b[^>]*property=["\']og:image["\'][^>]*>', re.I)
    _IMG_SRC = re.compile(r'<img\b[^>]*\bsrc=["\']([^"\']+)["\']', re.I)

    def __init__(self, user_agent, *, min_interval=2.0, sleep=time.sleep,
                 fetch_html=None, max_retries=2):
        self.user_agent = user_agent
        self.min_interval = min_interval
        self._sleep = sleep
        self._fetch_html = fetch_html or self._default_fetch_html
        self.max_retries = max_retries

    def _default_fetch_html(self, url, *, timeout=20.0):
        """GET url → HTML text. Raises ArchiveError on HTTP/network failure (Cloudflare
        challenge pages surface as 403/429). Reuses the shared transport."""
        try:
            _status, _headers, raw = _http.request(
                url, method="GET",
                headers={"User-Agent": self.user_agent, "Accept": "text/html"},
                timeout=timeout, retries=self.max_retries, sleep=self._sleep,
            )
        except _http.HttpError as e:
            raise ArchiveError(f"HTTP error for {url}: {e}", status=e.status,
                               retry_after=e.retry_after) from e
        return raw.decode("utf-8", errors="replace")

    def _snapshot_url(self, original_url):
        """archive.ph/newest/<url> redirects to the latest snapshot. Quoted so a URL with
        query params doesn't break the path."""
        return self.NEWEST.format(url=urllib.parse.quote(original_url, safe=""))

    def recover_media(self, item, *, want_gallery=True):
        """Recover image bytes for one reddit item from its newest archive.today snapshot.

        Returns a list of dicts (one per recovered image, ordered as in the snapshot):
          [{"url": <snapshot_img_url>, "title": <og:title or "">}]
        The CALLER does the actual byte fetch via media_archive's injected fetcher +
        stores via media_store — this method only resolves WHICH image URLs the snapshot
        holds, keeping it cheap + cacheable + testable without real network.

        Returns [] when: no original media URL to look up, no snapshot exists, snapshot
        has no recoverable images, or any network/Cloudflare error (loud-fail tolerant —
        recover_one swallows it per provider).
        """
        urls = self._item_image_urls(item, want_gallery=want_gallery)
        if not urls:
            return []
        results = []
        for orig in urls:
            try:
                html = self._fetch_html(self._snapshot_url(orig))
            except ArchiveError:
                continue  # this image had no snapshot / was Cloudflare-blocked → skip
            if self._made_request_throttle:
                pass  # placeholder satisfied by _fetch_html path below
            found = self._extract_images(html, orig)
            results.extend(found)
        return results

    # -- helpers -------------------------------------------------------------
    @staticmethod
    def _item_image_urls(item, *, want_gallery=True):
        """The original image URLs to look up on archive.today, from the item's media
        metadata. Prefers the direct media_url; galleries add each frame. These are the
        URLs that were 404 (gone) — archive.today may have snapshotted them while live."""
        md = item.get("metadata") or {}
        if isinstance(md, str):
            md = json.loads(md) if md else {}
        out = []
        u = md.get("media_url") or ""
        if u and u.startswith("http"):
            out.append(u)
        if want_gallery:
            out += [g for g in (md.get("gallery") or []) if isinstance(g, str) and g.startswith("http")]
        # de-dupe, preserve order
        seen = set()
        return [x for x in out if not (x in seen or seen.add(x))]

    def _extract_images(self, html_text, original_url):
        """From a snapshot's HTML, the candidate image URLs that match what we lost.
        Prefer og:image (the canonical hero image); fall back to inlined <img src>s whose
        host matches the original. Returns [{url, title}]."""
        out = []
        title = ""
        m = self._OG_IMAGE.search(html_text)
        og_url = ""
        if m:
            cm = re.search(r'content=["\']([^"\']+)["\']', m.group(0), re.I)
            if cm:
                og_url = html.unescape(cm.group(1))
        # <title> or og:title for a recovered title hint (informational only here)
        for cand in ([og_url] if og_url else []) + [s.group(1) for s in self._IMG_SRC.finditer(html_text)]:
            cand = html.unescape(cand)
            if cand.startswith("http"):
                out.append({"url": cand, "title": title})
        # de-dupe by url
        seen = set()
        uniq = []
        for c in out:
            if c["url"] not in seen:
                seen.add(c["url"])
                uniq.append(c)
        return uniq

    # throttle flag mirror (the shared _http.request already sleeps on retry; min_interval
    # spaces successive snapshot lookups in a multi-image gallery)
    _made_request_throttle = True
```

> **Note for the reviewer:** the `_made_request_throttle` placeholder is a code smell — the
> delegate should implement `min_interval` spacing between successive `recover_media` snapshot
> fetches (mirror `ArchiveProvider._request`'s `if self._made_request and self.min_interval > 0:
> self._sleep(...)` pattern). Flag this in the delegate prompt explicitly so it's not left as a
> dangling placeholder. The spec above deliberately keeps the throttle logic for the delegate to
> fill in correctly rather than risk a subtle bug.

- [ ] **Step 1: Delegate the class to the local LLM**

  Use `mcp__local-llm-bridge__delegate_to_local_llm` with the Devstral model (or Qwen fallback).
  Prompt: "Implement `ArchiveTodayProvider` per this spec. Fix the `_made_request_throttle`
  placeholder to properly space successive snapshot fetches by `min_interval` (mirror the
  `ArchiveProvider._request` throttle pattern at the top of this file). Use only stdlib + the
  existing `_http`, `ArchiveError`, `re`, `html`, `time`, `urllib.parse`, `json` imports already
  in the file. Return ONLY the new class + the `default_media_providers` factory from Task 1b."

- [ ] **Step 2: Verify the delegated code compiles**

  Run: `python -m py_compile src/content_hoarder/archival/providers.py`
  Expected: exit 0, no output. **If it fails, fix manually — do not re-delegate blindly.**

- [ ] **Step 3: Add the factory** (Task 1b — small enough to do inline after delegation)

  Append to `providers.py`:
  ```python
  def default_media_providers(user_agent, *, throttle=True):
      """archive.today media-recovery provider (last-resort bytes). ``throttle`` spaces
      snapshot lookups; pass False for a snappy single on-demand fetch."""
      return [ArchiveTodayProvider(user_agent, min_interval=2.0 if throttle else 0.0)]
  ```
  And add `json` + `urllib.parse` to the file's imports if the delegate didn't.

- [ ] **Step 4: Commit**

  ```bash
  git add src/content_hoarder/archival/providers.py
  git commit -m "feat(archival): add ArchiveTodayProvider (URL-keyed media-byte recovery)"
  ```

---

## Task 2: Wire archive.today into `recover_one()` as a post-chain step

**Files:**
- Modify: `src/content_hoarder/archival/service.py:192-223` (the `recover_one` function) + add `_try_archive_today` helper near `_collect`.

The chain runs PullPush → Arctic for **metadata** (unchanged). *Then*, if the item's media is
still `gone` (no recovered live image), try archive.today for the **bytes**. This ordering is the
whole point: don't burn an archive.today request when PullPush already gave us a live thumbnail.

- [ ] **Step 1: Write the failing test** (in `tests/test_archive_today.py`)

  ```python
  import json
  from content_hoarder import db, models
  from content_hoarder.archival import service as archival
  from content_hoarder.archival.providers import ArchiveTodayProvider


  def _seed_gone(conn):
      db.merge_upsert(conn, models.new_item(
          source="reddit", source_id="t3_gone", kind="post",
          title="Some title", body="text",
          metadata={"permalink": "/r/x/comments/gone/t/",
                    "media_url": "https://i.redd.it/dead.jpg",
                    "media_status": "gone"}))
      conn.commit()


  def _fake_snapshot_html(img_url):
      return (f'<html><head><meta property="og:image" content="{img_url}">'
              f'<title>Archived Page</title></head>'
              f'<body><img src="{img_url}"></body></html>')


  def _fake_fetch_bytes(url, *, max_bytes=15728640):
      # the media_archive byte-fetcher returns (bytes, mime)
      return (b"\x89PNG\r\n\x1a\nFAKEIMAGEBYTES", "image/png")


  def test_recover_one_archives_bytes_when_media_gone(tmp_db, monkeypatch):
      conn = db.connect(tmp_db)
      _seed_gone(conn)

      # archive.today snapshot resolves + the image bytes are fetchable
      at = ArchiveTodayProvider(
          "ua", min_interval=0.0,
          fetch_html=lambda url, **kw: _fake_snapshot_html(
              "https://archive.ph/img/abc.jpg"))

      res = archival.recover_one(
          conn, "reddit:t3_gone",
          media_providers=[at], fetch_bytes=_fake_fetch_bytes, apply_bytes=True)
      assert res["bytes_archived"] >= 1

      md = json.loads(db.get_item(conn, "reddit:t3_gone")["metadata"])
      assert md["media_status"] == "recovered_archive_today"
      assert md["archived_media"]  # {original_or_snapshot_url: blob_id}

      # the blob is on disk + servable
      from content_hoarder import media_store
      for blob in md["archived_media"].values():
          assert media_store.path_for(blob) is not None


  def test_recover_one_skips_archive_today_when_media_live(tmp_db):
      """If PullPush already recovered a live image, archive.today must NOT be hit."""
      conn = db.connect(tmp_db)
      db.merge_upsert(conn, models.new_item(
          source="reddit", source_id="t3_live", kind="post",
          title="T", body="b",
          metadata={"media_url": "https://i.redd.it/live.jpg",
                    "media_status": "ok"}))  # NOT gone → skip archive.today
      conn.commit()

      called = {"n": 0}

      class Boom(ArchiveTodayProvider):
          def recover_media(self, *a, **k):
              called["n"] += 1
              return []

      res = archival.recover_one(conn, "reddit:t3_live", media_providers=[Boom("ua")],
                                 fetch_bytes=lambda *a, **k: (None, ""), apply_bytes=True)
      assert called["n"] == 0  # never consulted — media wasn't gone
      assert res.get("bytes_archived", 0) == 0
  ```

- [ ] **Step 2: Run the test — verify it fails**

  Run: `python -m pytest tests/test_archive_today.py -v`
  Expected: FAIL — `recover_one()` got an unexpected keyword `media_providers` /
  `fetch_bytes` / `apply_bytes` (TypeError), and `bytes_archived` isn't in the result.

- [ ] **Step 3: Implement `_try_archive_today` + extend `recover_one`**

  In `service.py`, add after `_collect`:

  ```python
  def _try_archive_today(conn, item, *, providers, fetch_bytes, apply_bytes) -> int:
      """Post-chain media-byte recovery from archive.today. Only runs when the item's media
      is still 'gone' (PullPush/Arctic didn't recover a live image). Fetches the snapshot's
      image URLs, then the bytes, stores them via media_store, records archived_media +
      flips media_status. Returns the count of bytes-blobs archived (0 if nothing/skipped)."""
      md = item.get("metadata") or {}
      if isinstance(md, str):
          import json as _json
          md = _json.loads(md) if md else {}
      if md.get("media_status") != "gone":
          return 0  # we have a live image (or it was never media) → don't burn archive.today

      from content_hoarder import media_store
      arch = dict(md.get("archived_media") or {})
      n = 0
      for prov in providers:
          try:
              candidates = prov.recover_media(item)
          except Exception:  # noqa: BLE001 — any provider failure is a soft miss
              continue
          if not candidates:
              continue
          for c in candidates:
              url = c.get("url")
              if not url or url in arch:
                  continue
              if not apply_bytes:
                  n += 1
                  continue
              data, mime = fetch_bytes(url)
              if data is None:
                  continue
              blob = media_store.store(data, mime=mime, url=url)
              arch[url] = blob
              n += 1
          if n:
              break  # first provider that found anything wins
      if n and apply_bytes:
          import json as _json
          conn.execute(
              "UPDATE items SET metadata=json_set(json_set(metadata, "
              "'$.archived_media', json(?)), '$.media_status', 'recovered_archive_today') "
              "WHERE fullname=?",
              (_json.dumps(arch), item["fullname"]))
          conn.commit()
      return n
  ```

  Then modify `recover_one`'s signature + tail (add the three kwargs + the post-chain call):

  ```python
  def recover_one(conn, fullname: str, *, providers=None,
                  user_agent: str = DEFAULT_USER_AGENT,
                  media_providers=None, fetch_bytes=None, apply_bytes=True) -> dict | None:
      """On-demand recovery of a single reddit item (throttle off, for a UI button).

      Returns ``{recovered, title, body, url, bytes_archived}`` (post-recovery values),
      or None if it isn't a recoverable reddit item. After the metadata chain
      (PullPush/Arctic) runs, archive.today is tried for media bytes when the image is
      still ``media_status='gone'``.
      """
      item = db.get_item(conn, fullname)
      if not item or item.get("source") != "reddit":
          return None
      sid = item.get("source_id") or ""
      if not sid.startswith(("t1_", "t3_")):
          return None
      providers = providers or default_providers(user_agent, throttle=False)
      by_sid = {sid: item}
      recovered: dict = {}
      bare = sid[3:]
      for prov in providers:
          try:
              found = prov.fetch_posts([bare]) if sid.startswith("t3_") else prov.fetch_comments([bare])
          except ArchiveError:
              continue
          if _collect(found, sid[:3], by_sid, recovered):
              break
      update = {"fullname": fullname, "hydrated_at": int(time.time())}
      update.update(recovered.get(sid, {}))
      db.merge_upsert(conn, update)
      conn.commit()

      # post-chain: try archive.today for media bytes when still 'gone'
      bytes_n = 0
      if media_providers:
          from content_hoarder.media_archive import default_fetch
          fb = fetch_bytes or default_fetch
          fresh = db.get_item(conn, fullname) or {}
          bytes_n = _try_archive_today(conn, fresh, providers=media_providers,
                                       fetch_bytes=fb, apply_bytes=apply_bytes)

      fresh = db.get_item(conn, fullname) or {}
      return {"recovered": bool(recovered) or bool(bytes_n),
              "title": fresh.get("title"), "body": fresh.get("body"),
              "url": fresh.get("url"), "bytes_archived": bytes_n}
  ```

  > **Triage-state safety:** `_try_archive_today` writes only `archived_media` + `media_status`
  > via a direct `json_set` UPDATE — it does **not** touch `status`/`processed_utc`/`status_prev`
  > (mirrors `media_archive.py:140`'s "no last_seen bump, no search_text rebuild" discipline).

- [ ] **Step 4: Run the tests — verify they pass**

  Run: `python -m pytest tests/test_archive_today.py -v`
  Expected: both tests PASS.

- [ ] **Step 5: Run the FULL suite to confirm no regressions**

  Run: `python -m pytest -q`
  Expected: all green (baseline = current pass count; the existing `test_archival.py` +
  `test_archive_fallback.py` must be unchanged). Record the count.

- [ ] **Step 6: Commit**

  ```bash
  git add src/content_hoarder/archival/service.py tests/test_archive_today.py
  git commit -m "feat(archival): wire archive.today byte-recovery into recover_one (post-chain)"
  ```

---

## Task 3: Robustness + provider tests

**Files:**
- Modify: `tests/test_archive_today.py` — add the offline provider-level tests + the failure paths.

These pin the contract the delegate's code must honor, independent of `recover_one`.

- [ ] **Step 1: Add provider unit tests**

  ```python
  def test_provider_no_media_url_returns_empty():
      p = ArchiveTodayProvider("ua", fetch_html=lambda *a, **k: "")
      assert p.recover_media({"metadata": {"media_status": "gone"}}) == []  # no url to look up


  def test_provider_extracts_og_image_and_inline_imgs():
      html = ('<meta property="og:image" content="https://archive.ph/a.jpg">'
              '<img src="https://i.redd.it/orig.jpg">')
      p = ArchiveTodayProvider("ua", fetch_html=lambda *a, **k: html)
      res = p.recover_media({"metadata": {
          "media_url": "https://i.redd.it/orig.jpg", "media_status": "gone"}})
      urls = [c["url"] for c in res]
      assert "https://archive.ph/a.jpg" in urls
      assert "https://i.redd.it/orig.jpg" in urls


  def test_provider_cloudflare_403_skips_silently():
      from content_hoarder.archival._http import ArchiveError
      def boom(url, **kw):
          raise ArchiveError("HTTP 403 (Cloudflare)", status=403)
      p = ArchiveTodayProvider("ua", fetch_html=boom)
      res = p.recover_media({"metadata": {
          "media_url": "https://i.redd.it/x.jpg", "media_status": "gone"}})
      assert res == []  # loud-fail tolerant: a blocked snapshot is a soft miss, not a crash


  def test_provider_gallery_looks_up_each_frame():
      seen = []
      def fake(url, **kw):
          seen.append(url)
          return '<img src="' + url + '">'  # echo back
      p = ArchiveTodayProvider("ua", fetch_html=fake)
      res = p.recover_media({"metadata": {
          "media_url": "https://i.redd.it/main.jpg", "media_status": "gone",
          "gallery": ["https://i.redd.it/g1.jpg", "https://i.redd.it/g2.jpg"]}})
      # all three originals queried
      assert any("main.jpg" in s for s in seen)
      assert any("g1.jpg" in s for s in seen)
      assert any("g2.jpg" in s for s in seen)


  def test_recover_one_dry_run_counts_without_fetching_bytes(tmp_db):
      conn = db.connect(tmp_db)
      _seed_gone(conn)
      at = ArchiveTodayProvider("ua", min_interval=0.0,
                                fetch_html=lambda *a, **k: _fake_snapshot_html(
                                    "https://archive.ph/img/x.jpg"))
      res = archival.recover_one(conn, "reddit:t3_gone", media_providers=[at],
                                 fetch_bytes=lambda *a, **k: (b"x", "image/png"),
                                 apply_bytes=False)  # dry-run
      assert res["bytes_archived"] >= 1
      md = json.loads(db.get_item(conn, "reddit:t3_gone")["metadata"])
      assert "archived_media" not in md or not md["archived_media"]  # nothing written
      assert md["media_status"] == "gone"  # unchanged
  ```

- [ ] **Step 2: Run — verify all pass**

  Run: `python -m pytest tests/test_archive_today.py -v`
  Expected: all 7 tests PASS (2 from Task 2 + 5 here).

- [ ] **Step 3: Commit**

  ```bash
  git add tests/test_archive_today.py
  git commit -m "test(archival): archive.today provider unit + failure-path tests"
  ```

---

## Task 4: Live smoke (manual, gated) + docs

**This is the only network step.** Per AGENTS.md "hard rules" + the backlog item's own warning:
archive.today is Cloudflare-gated. Verify it works against ONE real `gone` item, by hand, not in CI.

- [ ] **Step 1: Find a real `gone` item to smoke against**

  Run (against a **COPY** of the live DB):
  ```bash
  cp data/app.db data/app.smoke.db
  python -c "import sqlite3; c=sqlite3.connect('data/app.smoke.db'); \
    print(c.execute(\"SELECT fullname, json_extract(metadata,'\$.media_url') FROM items \
    WHERE source='reddit' AND json_extract(metadata,'\$.media_status')='gone' \
    AND json_extract(metadata,'\$.media_url') LIKE '%i.redd.it%' LIMIT 3\").fetchall())"
  ```
  Pick one `fullname` from the output.

- [ ] **Step 2: Smoke via the existing UI button (preferred — tests the real path)**

  ```bash
  python -m content_hoarder init-db --db data/app.smoke.db  # no-op if exists
  python -m content_hoarder serve --db data/app.smoke.db
  ```
  Open the item in the browser, click **"↻ Recover from archives"**. Watch the server log for
  archive.today fetches. Confirm the image renders (frontend prefers `archived_media`).

- [ ] **Step 3: Smoke via CLI (alternative / if the UI button isn't easily reachable)**

  ```bash
  python -c "
  from content_hoarder import db, config
  from content_hoarder.archival.service import recover_one
  config.override_db('data/app.smoke.db')
  c = db.connect('data/app.smoke.db')
  print(recover_one(c, '<PICKED_FULLNAME>', apply_bytes=True))
  "
  ```
  Expected: `bytes_archived >= 1` and `media_status` flips to `recovered_archive_today`. If the
  item genuinely wasn't archived on archive.today, `bytes_archived == 0` is a valid (non-bug) result —
  try 2-3 items before concluding the fetch path is broken.

- [ ] **Step 4: Verify the stored blob is real + servable**

  ```bash
  python -c "
  import sqlite3, json
  from content_hoarder import media_store
  c = sqlite3.connect('data/app.smoke.db')
  md = json.loads(c.execute('SELECT metadata FROM items WHERE fullname=?',
               ('<PICKED_FULLNAME>',)).fetchone()[0])
  for url, blob in md.get('archived_media', {}).items():
      p = media_store.path_for(blob)
      print(blob, p, p.stat().st_size if p else 'MISSING')
  "
  ```
  Expected: blob path exists, size > 0 (a real image, not a Cloudflare challenge HTML page — spot
  check the first bytes are `PNG`/`JFIF` if unsure).

- [ ] **Step 5: Clean up the smoke DB**

  ```bash
  rm data/app.smoke.db
  ```

- [ ] **Step 6: Update BACKLOG.md**

  In `BACKLOG.md` Epic 4 (line ~112), mark the item shipped with a dated note:
  ```markdown
  - [x] ~~**P2 — `archive.today` (archive.ph) as a recovery provider.**~~ Shipped 2026-06-24:
    `ArchiveTodayProvider` (URL-keyed, HTML, recovers media BYTES the metadata archives never had)
    wired into `recover_one()` as a post-chain step — runs only when `media_status='gone'` after
    PullPush/Arctic, fetches the `archive.ph/newest/<url>` snapshot, extracts og:image + inlined
    imgs, stores bytes via `media_store` (→ `metadata.archived_media` + `media_status='recovered_archive_today'`).
    Per-item only (Cloudflare-gated, no bulk API); 7 offline tests. Live smoke: <N/3 recovered>.
  ```

- [ ] **Step 7: Commit docs**

  ```bash
  git add BACKLOG.md
  git commit -m "docs(backlog): mark archive.today recovery provider shipped"
  ```

---

## Self-Review (run before declaring done)

1. **Spec coverage** — backlog item Epic 4 line 112: "query `archive.ph/newest/<original_url>`" ✓
   (Task 1 `_snapshot_url`); "parse the snapshot for the og:image / inlined media" ✓ (Task 1
   `_extract_images`); "if the bytes resolve, store them via `media_store`" ✓ (Task 2
   `_try_archive_today`); "wire it into the existing `recover_one()` path, NOT a bulk pass" ✓
   (Task 2 post-chain); "Fetcher stays injectable for offline tests" ✓ (Task 3).

2. **Placeholder scan** — the one placeholder (`_made_request_throttle`) is explicitly flagged for
   the delegate to fill; no TBD/TODO/handle-edge-cases in the agent-executed steps.

3. **Type/name consistency** — `recover_media(item) -> list[dict]` (Task 1) is called as
   `prov.recover_media(item)` (Task 2 `_try_archive_today`) ✓; `media_providers`/`fetch_bytes`/
   `apply_bytes` kwargs match across the signature (Task 2 Step 3) and both call sites (Task 2
   test, Task 3 test) ✓; `bytes_archived` in the return dict (Task 2 Step 3) matches all test
   assertions ✓.

4. **Non-destructive** — `_try_archive_today` writes only `archived_media` + `media_status` via
   `json_set` (mirrors `media_archive.py`); triage state untouched ✓. `recover_one`'s existing
   metadata path is unchanged above the new block ✓.

## Out of scope (icebox)

- A bulk `enrich --source reddit --archive-today` pass — explicitly rejected (Cloudflare, no bulk
  API); per-item via the Recover button is the design.
- archive.today as a **text** (title/body) recovery source — PullPush/Arctic already cover that
  better; archive.today's value is uniquely the bytes.
- Caching snapshot lookups across runs — not needed at per-item volume; revisit if it ever gets
  called from a bulk surface.
