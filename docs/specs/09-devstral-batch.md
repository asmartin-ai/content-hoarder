# Spec 09 — Devstral batch: offline-backend backlog tasks

A self-contained spec for tasks picked from `BACKLOG.md` + `docs/specs/parity-ideas.md`
that fit a **local Devstral codegen model**. Paste the whole file (or any single Task
section) into continue.dev.

## Status
- **Task A — HN comment-thread viewer backend: ✅ SHIPPED 2026-06-25** (`commit 92c8877`).
  `src/content_hoarder/hn_thread.py` + `tests/test_hn_thread.py` (16 tests) + the
  `/hackernews/items/<fn>/thread` route (`web.py:563`). Full suite green. Devstral executed
  the bulk; GLM-5.1 (Fireworks) finished/debugged. The thread-rendering UI is still a
  separate non-Devstral task.
- **Task B — Promote YouTube-link notes → youtube items: ✅ SHIPPED 2026-06-25** (merged to
  `origin/main`). `src/content_hoarder/note_youtube.py` + `tests/test_note_youtube.py` + the
  `migrate-note-youtube [--apply]` CLI. continue.dev authored the work in its worktree; picked up
  uncommitted, verified against this spec's acceptance criteria (new tests + full suite green,
  `py_compile` clean, no `await`), committed, merged. See `git log --grep=note-youtube`.
- **Task C — Note-body editing backend: ✅ SHIPPED 2026-06-25.**
  Adds `db.set_body`, `POST /items/<fn>/body`,
  the `body_edited_at` merge guard, and DB/web tests. The reader textarea UI shipped separately.
- **Task D — HN favorites-page auto-sync: ✅ SHIPPED 2026-06-25.**
  Adds `hn_sync.py`, the `hn-sync` CLI, high-water
  mark handling, injectable fetcher, and offline tests. The planned scheduler /
  settings UI remains out of scope.

## How these were selected (Devstral fit criteria)
Devstral does best on **pure backend, synchronous, offline-testable** work where every
integration point is already pinned to a real `file:line` (so it reads the code instead of
hallucinating). Excluded: anything needing visual/UI review, live-network verification to
implement, or an unresolved product decision. Each task below:
- reuses an established in-repo pattern (cite given) rather than inventing architecture;
- puts all network behind an **injectable fetcher** so tests are fully offline;
- has pre-decided gates (open decisions stated + resolved, not left to the model);
- touches only backend (Python/SQLite/Flask routes) — no HTML/CSS/JS.

## Ranking
- **Task A — HN comment-thread viewer backend** (Algolia → thread cache). Fully grounded.
- **Task B — Promote YouTube-link notes → youtube items** (CLI, mirrors `firefox_youtube`). Fully grounded; complete feature, no UI needed.
- **Task C — Note-body editing backend** (`db.set_body` + route + merge_upsert guard). Fully grounded; backend-half (UI separate).
- **Task D — HN favorites-page auto-sync** (CLI, mirrors `reddit_sync`). Shipped with synthetic
  favorites-page fixtures and an injectable fetcher; no live HN page is required for tests.

A and C are "backend half" features (they ship a JSON route / DB helper; the matching UI is a
separate, non-Devstral task). B and D are complete CLI-driven backend features.

---

## Devstral guardrails (apply to EVERY task)

1. **Synchronous only.** No `async`/`await`. The codebase is sync (stdlib `urllib`, Flask,
   sqlite3). Plain functions.
2. **All network behind an injectable seam** (`getf=` / `fetch=` / `fetch_bytes=` param);
   tests pass a fake that returns canned bytes/JSON. **No real network in tests.**
3. **Tests:** `python -m pytest`, `:memory:` SQLite, tiny synthetic fixtures. Add a test per
   new function/bug. The default run excludes `-m ui`; do NOT add Playwright tests here.
4. **No UI/HTML/CSS/JS.** No design decisions. No schema migrations — additive columns only,
   and only if a task explicitly calls for one (none of A/B/C do; D adds none).
5. **Connectors never touch the DB** (`import_file` only *yields* `models.new_item` dicts;
   `pipeline.py`/`db.py` own writes). Keep it.
6. **merge_upsert is non-destructive** — never overwrite user/triage state, never move
   `first_seen_utc` forward (db.py:533-538). Task C adds one *new* guard to this; don't relax
   the existing ones.
7. **HTTP is stdlib `urllib`** via `content_hoarder/_http.py` — no `requests`/`httpx`.
8. **After coding, self-check:** `grep -rn "await " src/content_hoarder/<new>.py` (must be
   empty) and `python -m py_compile src/content_hoarder/<new>.py` for every new/changed file.

---

## Task A — HN comment-thread viewer backend  ✅ SHIPPED 2026-06-25 (`92c8877`)

**Backlog ref:** `docs/specs/parity-ideas.md` item C (HN thread viewer). `BACKLOG.md` Epic 7 (HN).
**Blast radius:** low — additive new module + one new route. Reuses the existing thread cache
table. No schema change.

### What
A backend that, for a `hackernews:<id>` item, fetches the full comment tree from the **HN
Algolia API**, parses it into the same render shape `reddit_thread.py` produces, and caches it
in the existing `reddit_threads` side table. Served by a new JSON route mirroring
`/reddit/items/<fn>/thread`. **Backend + JSON route only** — the thread-rendering UI is a
separate non-Devstral task.

### Grounding (read these before coding)
- **API (confirmed):** `GET https://hn.algolia.com/api/v1/items/<id>` → one JSON object, a
  recursive tree. Per node: `{id, title, url, text, author, points, created_at,
  created_at_i, type, parent_id, story_id, options, children[]}`. `type ∈ {"story","comment"}`.
  `created_at_i` = epoch seconds (use it, not the ISO `created_at` string). `children` is the
  recursive list. Root node has `type="story"`.
- **Mirror target — parse/render:** `src/content_hoarder/reddit_thread.py`
  - `parse_thread(raw_json, item, sort="best")` (line 76) → returns
    `{post, comments, cached, archived, item_fullname, item_kind, sort}`.
  - `_extract_comments(children, depth=0, sort="best")` (line 48).
  - `get_thread(conn, fullname, sort="best")` (line 115) — reads from cache, returns parsed or `None`.
  - `_abs_permalink` (line 16), `_resolve_media` (line 21) — HN has no media; skip/omit.
- **Cache (reuse, do NOT rename):** `db.get_reddit_thread(conn, fullname)` (db.py:1673) and
  `db.set_reddit_thread(conn, fullname, thread_json, hydrated_at=None, *, commit=True)`
  (db.py:1686). The table is `reddit_threads` keyed by `fullname` PK — **source-agnostic** (a
  `hackernews:<id>` key works unchanged). The name is a wart; reuse it as-is (renaming = a
  schema migration, out of scope). Add a comment in the new module explaining the reuse.
- **Route mirror:** `web.py:545` `reddit_thread_route(fullname)` — calls
  `reddit_hydrate.hydrate_if_missing(c, fullname)` (lazy fetch+cache), then
  `reddit_thread.get_thread(c, fullname, sort)`, 404 if `None`, attaches `hydrate_status`.
  Mirror this two-call shape for HN.
- **Transport:** `content_hoarder/_http.py` `request(url, *, method, headers, data, timeout,
  retries, backoff, sleep, user_agent, jitter, rng) -> (status, headers, raw_bytes)` — use it for
  the Algolia fetch so retries/throttle are shared. Injectable: the new module takes a `fetch=`
  param defaulting to a thin wrapper over `_http.request`; tests pass a fake returning canned
  Algolia JSON.

### Signatures to add (new file `src/content_hoarder/hn_thread.py`)
```python
def parse_thread(raw_json: str, item: dict, sort: str = "top") -> dict:
    """Parse Algolia item JSON into the reddit_thread render shape.
    Returns {post, comments, cached, item_fullname, item_kind, sort}.
    `item` is the items-table row (for title fallback / fullname / kind)."""

def _extract_comments(children: list, depth: int = 0, sort: str = "top") -> list[dict]:
    """Recursive. Each comment: {id, author, text, points, created_utc, depth, children}."""

def get_thread(conn, fullname: str, sort: str = "top") -> dict | None:
    """Read cached Algolia JSON via db.get_reddit_thread, parse, return shape or None."""

def hydrate_if_missing(conn, fullname: str, *, fetch=None) -> dict | None:
    """If no cached thread, fetch Algolia (fetch= injectable), db.set_reddit_thread, return
    {status: "hydrated"|"cached"|"not_found"|"error"}."""
```
Sort handling: HN has no native "best". Accept `("top","new","default")`; map `best`→`top`
for frontend parity. `top` sorts children by `points` desc; `new` by `created_at_i` desc;
`default` preserves Algolia's given order. Mirror how `reddit_thread._extract_comments` sorts.

### Route to add (in `web.py`, near line 545)
```python
@app.get("/hackernews/items/<path:fullname>/thread")
def hn_thread_route(fullname):
    from content_hoarder import hn_thread
    sort = request.args.get("sort", "top")
    if sort not in ("top", "new", "default", "best"):
        sort = "top"
    no_fetch = request.args.get("nofetch") == "1"
    with conn() as c:
        if db.get_item(c, fullname) is None:
            return jsonify({"error": "not found"}), 404
        hres = None if no_fetch else hn_thread.hydrate_if_missing(c, fullname)
        res = hn_thread.get_thread(c, fullname, sort)
        if res is None:
            return jsonify({"error": "not found"}), 404
        if hres is not None:
            res["hydrate_status"] = hres.get("status")
    return jsonify(res)
```

### Injectable seam / offline tests
`hydrate_if_missing(conn, fullname, *, fetch=None)` — `fetch(fullname) -> str|None` returns
canned Algolia JSON (or `None` for not-found). `get_thread` reads only the cache (no network).
Tests:
1. `test_hn_parse_thread`: feed a small synthetic Algolia tree (root story + 2 nested
   comments) → assert `post.title/points/created_utc`, `len(comments)`, nesting depth, sort
   order for `top` vs `new`.
2. `test_hn_hydrate_and_cache`: `:memory:` DB, insert a `hackernews:42` item, call
   `hydrate_if_missing` with a fake `fetch` → assert `set_reddit_thread` wrote gzip blob, a
   second call returns `status="cached"` and does NOT call `fetch`.
3. `test_hn_route`: Flask test client, fake `fetch` (monkeypatch `hn_thread.hydrate_if_missing`
   or inject) → `GET /hackernews/items/hackernews:42/thread` returns 200 + parsed JSON; unknown
   fullname → 404.

### Acceptance
- `parse_thread` output keys match `reddit_thread.parse_thread` (so a future UI can reuse
  rendering): `post, comments, cached, item_fullname, item_kind, sort`.
- Cache hit serves without network; first open hydrates once, second is cached.
- `created_at_i` (epoch) is used for `created_utc`, not the ISO string.
- All tests green with zero real network calls. `py_compile` clean. No `await`.

---

## Task B — Promote standalone YouTube-link notes → youtube items  ✅ SHIPPED 2026-06-25 (merged to `origin/main`)

**Backlog ref:** `BACKLOG.md` Epic 11 P2. **Blast radius:** low — new CLI module mirroring
`firefox_youtube.py`; additive `metadata` stamps only. No schema change, no connector DB writes.

### What
Keep notes and Obsidian notes whose **body** contains a YouTube URL often *are* saved videos
in disguise. Promote them: for each note with a YouTube id in its body/url, either (a) create a
keyless `youtube:<id>` item (orphan — no existing youtube item) and mark the note as its
companion, or (b) if the `youtube:<id>` item already exists, just attach the note as a companion
+ stamp the note. Delivered as a **CLI command `migrate-note-youtube`** with dry-run default,
exactly like `migrate-firefox-tabs` / `consolidate`.

### Grounding (read these before coding)
- **Direct mirror:** `src/content_hoarder/firefox_youtube.py`
  - `plan(conn) -> dict` (line 26) — read-only classify; `vid = youtube_id(url or "")` (line 35).
  - `_firefox_marker_mutator(ff_meta)` (line 49) — stamps the source note's metadata.
  - `migrate(conn, *, apply=False) -> dict` (line 60) — **dry-run default**.
  - `from content_hoarder.connectors.firefox import youtube_id, yt_item` (line 22).
- **Promotion primitives:** `src/content_hoarder/consolidate.py`
  - `PROMOTE_MARKER = "consolidate"` (line 40) — define a NEW marker `"note_youtube"` (don't reuse).
  - `_promote_item(rec) -> dict` (line 132) — builds a keyless `youtube:<id>` item from the vid
    alone; sets `metadata.promoted_by = PROMOTE_MARKER` (line 150). Mirror this for the orphan
    case with `promoted_by = "note_youtube"`.
  - `_companion_record(row, md) -> dict` (line 44) + `_append_companion(yt_md, comp) -> bool`
    (line 69) — the note becomes a companion entry on the youtube item's `metadata.companions`.
  - `migrate(conn, *, apply=False)` (line 181), `unconsolidate(conn, *, apply=False)` (line 217).
- **YouTube id extraction (reuse, do NOT rewrite):** `connectors/firefox.py` `youtube_id(url)` —
  host-guarded (`_video_id_from_url`), 11-char check. Import it.
- **The gaps that make this needed (confirmed):**
  - `connectors/keep.py:90` — `m = re.search(r"https?://\S+", text_content)` captures the
    **first** URL only, so a note whose body mentions a YouTube link that isn't the first URL
    never surfaces it.
  - `connectors/obsidian.py:116` — `url = fm.get("url") or fm.get("source") or ""` takes URL
    from **frontmatter only**; a YouTube link in the markdown body is never captured.
  - **Design decision (resolved):** the promotion does NOT depend on re-importing. It extracts
    YouTube ids at plan/migrate time by scanning `item["body"]` + `item["url"]` +
    `metadata.urls` (if present) directly from the already-imported row. So existing notes work
    with no re-import. (Optional, secondary: also patch keep.py/obsidian.py to populate
    `metadata.urls = re.findall(...)` on *future* imports — additive, backward-compatible, keeps
    the single `url` field unchanged. Mark this optional; the promotion works without it.)

### Signatures to add (new file `src/content_hoarder/note_youtube.py`)
```python
from content_hoarder.connectors.firefox import youtube_id

NOTE_PROMOTE_MARKER = "note_youtube"

def _note_yt_ids(item: dict) -> list[str]:
    """Distinct YouTube ids found in item['body'], item['url'], metadata['urls'].
    Uses connectors.firefox.youtube_id (host-guarded, 11-char) per candidate URL."""

def plan(conn) -> dict:
    """Read-only. Scan source in ('keep','obsidian') notes. Return
    {orphan: [{fullname, vid, ...}], companion: [{fullname, vid, existing_yt_fullname}],
     counts: {...}}. orphan = vid with no existing youtube:<id> item;
     companion = vid whose youtube:<id> already exists."""

def _note_marker_mutator(note_md: dict, vid: str):
    """Stamp note metadata: promoted_to = 'youtube:<vid>' (+ source marker)."""

def migrate(conn, *, apply: bool = False) -> dict:
    """Dry-run default. For each note: for each yt id —
       orphan -> build keyless youtube:<vid> via the _promote_item pattern
                 (promoted_by=NOTE_PROMOTE_MARKER), db.merge_upsert it,
                 _append_companion on the yt item, stamp the note (merge_upsert note).
       companion -> _append_companion on existing yt item, stamp the note.
       Skip notes already stamped promoted_to (idempotent).
       Returns {promoted, attached, skipped, already_done, ...}."""
```
**Decided gates:** a note with multiple distinct YouTube ids promotes **each** id (one note →
possibly several youtube items + several companion stamps). A note already stamped
`promoted_to` for a given vid is skipped for that vid (idempotent re-run). Only `keep` +
`obsidian` sources are scanned (not reddit/youtube/hackernotes).

### CLI (in `cli.py`, mirror `migrate-firefox-tabs` / `consolidate`)
```python
def cmd_migrate_note_youtube(args) -> int:
    conn = db.connect(...)
    if not args.apply:
        print("DRY RUN — no writes. Pass --apply to promote.")
    res = note_youtube.migrate(conn, apply=args.apply)
    # print res counts; commit only if args.apply
    return 0
# sub.add_parser("migrate-note-youtube"); add --apply flag; set_defaults(func=cmd_migrate_note_youtube)
```

### Injectable seam / offline tests
No network at all (pure DB + regex). Tests on `:memory:` DB:
1. `test_note_yt_ids_extraction`: note body `"see https://youtu.be/dQw4w9WgXcQ and
   https://www.youtube.com/watch?v=aaaaaaaaaaa"` → both 11-char ids returned; non-youtube URLs
   ignored; host-guarded (a fake `youtube.com`-looking host that isn't) rejected.
2. `test_plan_orphan_vs_companion`: insert a keep note with a yt link (no youtube item) →
   `plan` lists it under `orphan`; insert the matching `youtube:<vid>` item first → lists under
   `companion`.
3. `test_migrate_dry_run_writes_nothing`: `migrate(apply=False)` → DB unchanged, counts returned.
4. `test_migrate_apply_creates_and_stamps`: `migrate(apply=True)` on orphan → a `youtube:<vid>`
   row exists with `metadata.promoted_by == "note_youtube"`, the note has
   `metadata.promoted_to == "youtube:<vid>"`, and the yt item's `metadata.companions` includes
   the note. Re-run → `already_done` increments, no duplicate rows.
5. `test_migrate_companion_attach`: existing youtube item + note → `migrate(apply=True)` → no
   new youtube row, companion appended, note stamped.

### Acceptance
- `plan` is strictly read-only (assert no DB diff). `migrate(apply=False)` writes nothing.
- Idempotent: a second `migrate(apply=True)` creates no new rows.
- Promoted youtube items are keyless (`source="youtube"`, `source_id=<vid>`,
  `fullname="youtube:<vid>"`) with `promoted_by="note_youtube"`, mirroring `consolidate._promote_item`.
- `merge_upsert` preserves the note's existing triage state (status etc.) when stamping
  (gotcha #2 — the stamp is a metadata overlay, not a state overwrite).
- All tests green. `py_compile` clean. No `await`. No network.

---

## Task C — Note-body editing backend  ✅ SHIPPED

> Status update: this task is complete. The implementation lives in `db.set_body`,
> the `/items/<fn>/body` route, and the merge-upsert guard that preserves
> `metadata.body_edited_at` rows. The dossier below is retained as historical implementation context.

**Backlog ref:** `BACKLOG.md` Epic 15 P2 (note editing). **Blast radius:** medium — touches
`db.merge_upsert` (adds a guard) + adds `db.set_body` + one route. merge_upsert is core; the
guard is strictly additive (only changes behavior when a new metadata flag is present), pinned
by a new test.

### What
The backend half of letting a user edit a note's `body`: a `db.set_body` helper that updates
`body` + regenerates `search_text` + stamps `metadata.body_edited_at`, and a `POST
/items/<fn>/body` route. **Plus a merge_upsert guard** so a later re-import does NOT clobber the
user's edit. **Backend only** — the textarea/edit-button UI is a separate non-Devstral task.

### Grounding (read these before coding)
- **The clobber risk (confirmed):** `db.py:462` `_OVERLAY_FIELDS = ("title","body","url","author")`
  and `db.py:487-489` overlay incoming non-empty `body` over existing. So a re-import today
  **overwrites** a hand-edited body. The fix: if `existing.metadata.body_edited_at` is set, do
  NOT overlay incoming `body` (user edit wins). This is the one new guard.
- **FTS stays in sync automatically (confirmed):** `db.py:111-127` defines `items_ai`/`items_ad`/
  `items_au` AFTER INSERT/DELETE/UPDATE **triggers** on `items` that sync `items_fts`. So a plain
  `UPDATE items SET body=?, search_text=? WHERE fullname=?` auto-refreshes the FTS index — no
  manual FTS work, no `rebuild`. (Gotcha #1's `rebuild` is only for the one-time initial build.)
- **search_text regeneration:** `models.build_search_text(item, metadata)` (models.py) — call it
  with the updated row + parsed metadata to recompute `search_text` before the UPDATE.
- **Direct-UPDATE precedent:** `db.set_status`/`bulk_set_status` do direct UPDATEs (not
  merge_upsert) for user-state changes — mirror that style for `set_body`.
- **Metadata helpers:** `db.parse_metadata` / `db._update_metadata` (used at db.py:453) or just
  `json.loads`/`json.dumps` the metadata column, merge in `body_edited_at`, write back.
- **Route precedent:** `web.py:314` `POST /items/<fn>/recover`, `:344` category, `:358` tags —
  same `<path:fullname>` shape, JSON body, 404 if missing, commit + return the updated public row.

### Signatures to add
```python
# db.py
def set_body(conn, fullname: str, body: str) -> dict | None:
    """Set item.body, regenerate search_text via build_search_text, stamp
    metadata.body_edited_at = int(time.time()). Direct UPDATE (bypasses merge_upsert overlay).
    Returns the updated _row_to_public dict, or None if fullname not found.
    FTS auto-syncs via the items_au trigger (db.py:123)."""
```
```python
# merge_upsert guard — inside db.py merge_upsert, in the _OVERLAY_FIELDS loop (db.py:487):
#   skip overlaying 'body' when the EXISTING row already has metadata.body_edited_at set.
#   i.e. compute `emd` (existing metadata) BEFORE the overlay loop (it's currently computed
#   at db.py:503 — move/hoist that parse above the loop), and guard:
#     for f in _OVERLAY_FIELDS:
#         if f == "body" and emd.get("body_edited_at"):
#             continue  # user edit wins; don't clobber with incoming re-import body
#         if item.get(f):
#             merged[f] = item[f]
```
**Decided gate:** only `body` gets the edit-wins guard. `title`/`url`/`author` keep overlaying
(incoming non-empty wins) — editing those is out of scope for this task. An empty incoming
`body` already does nothing (the `if item.get(f)` guard at db.py:488).

### Route to add (in `web.py`, near line 344)
```python
@app.post("/items/<path:fullname>/body")
def set_body_route(fullname):
    data = request.get_json(silent=True) or {}
    body = str(data.get("body") or "")
    with conn() as c:
        if db.get_item(c, fullname) is None:
            return jsonify({"error": "not found"}), 404
        updated = db.set_body(c, fullname, body)
        c.commit()
    return jsonify(updated)
```

### Injectable seam / offline tests
No network. Tests on `:memory:` DB:
1. `test_set_body_updates_and_searches`: insert an item with body "old"; `set_body(...,"new
   body words")` → DB row body == "new body words", `metadata.body_edited_at` set, and
   `db.search_items("new body words")` finds it (proves FTS + search_text refreshed via trigger).
2. `test_set_body_missing_returns_none`: unknown fullname → `None`, no crash.
3. **`test_merge_upsert_preserves_edited_body` (the guard, load-bearing):** insert item; import
   it (merge_upsert) with body="original"; `set_body(...,"my edit")`; now `merge_upsert` the
   SAME item with body="original re-import" → assert DB body is still **"my edit"** (not
   overwritten) AND `body_edited_at` preserved. Then a row with NO `body_edited_at` still
   overlays normally (regression guard for the existing behavior).
4. `test_set_body_route`: Flask test client → `POST /items/<fn>/body {"body":"x"}` returns 200 +
   updated row; unknown → 404.

### Acceptance
- `set_body` updates body + search_text + `body_edited_at` in one UPDATE; FTS finds the new text
  (evidence: the search test passes, relying on the `items_au` trigger).
- merge_upsert does NOT overwrite a `body_edited_at`-guarded body on re-import (the pinned test),
  and STILL overlays body normally when no edit flag exists (no regression — record the
  pre-change pass/fail of the existing merge_upsert tests as your baseline).
- Existing `tests/test_db*` / merge_upsert tests all still pass (run them; record baseline first).
- All tests green. `py_compile` clean. No `await`. No network.

---

## Task D — HN favorites-page auto-sync  ✅ SHIPPED

**Backlog ref:** `BACKLOG.md` Epic 7 P2. **Blast radius:** low-medium — new CLI module mirroring
`reddit_sync`; no schema change. Reuses the existing HN HTML id-extraction + Firebase enrich.
**Status:** shipped 2026-06-25.

### Build note
The original plan asked for a real saved favorites HTML fixture before coding the "More" link
parser. The shipped implementation instead keeps the parser small, follows the actual link text / href, and
pins it with synthetic offline fixtures in `tests/test_hn_sync.py`. A live Harmonic smoke remains a
workflow check, not a unit-test prerequisite.

### What
Turn the one-shot "import a saved favorites HTML file" flow into an incremental **auto-sync** of
the user's HN favorites: fetch `favorites?id=<user>` pages, extract item ids, enrich titles via
the existing Firebase `enrich()`, `merge_upsert` new ones, stop at a high-water mark. Mirrors
`reddit_sync.sync_saved`. Delivered as CLI `hn-sync` (+ optional debounced auto-scheduler, same
shape as reddit_sync — keep the scheduler OUT of scope for this batch; ship the `hn-sync` CLI +
`sync_saved` only).

### Grounding (read these before coding)
- **Direct mirror:** `src/content_hoarder/reddit_sync.py`
  - `sync_saved(conn, *, max_pages=3, stop_on_known=True, per_page=100, throttle=1.0, sleep=None,
    getf=None, user_agent=None, progress=None, reconcile=False, reconcile_dry_run=False) -> dict`
    (line 60). Result dict shape at line 97: `{fetched, new, updated, pages, stopped,
    auth_error, network_error, ...}`.
  - High-water mark: `_MARK_KEY = "reddit_sync_newest"` (line 42), `_MARK_DEPTH = 25` (line 43),
    `_load_mark(value) -> list[str]` (line 46). Mirror with `_HN_MARK_KEY = "hn_sync_newest"`.
  - Write call: `db.merge_upsert(conn, item)` → `"inserted"`/`"updated"` (reddit_sync.py:211).
- **HN HTML id extraction (reuse, do NOT rewrite):** `connectors/hackernews.py`
  - `_ITEM_ID = re.compile(r"item\?id=(\d+)")` (line 26), `_ATHING` (line 27).
  - `import_file` HTML branch (line 124-126): `ids = _ITEM_ID.findall(text) or
    _ATHING.findall(text)`. Reuse `_ITEM_ID.findall(html)` on each fetched page.
  - `new_item(source="hackernews", source_id=sid, kind="story", title="",
    url=_hn_url(sid), metadata={"hn_url": _hn_url(sid)})` (line 142) — the bare item the sync
    yields; titles arrive via `enrich`.
  - `enrich(items)` (line 206) — hits Firebase `_FIREBASE` per item to fill title/score/etc. The
    sync calls the connector's `enrich` on the newly-inserted sparse rows (or leaves them for the
    existing `enrich` CLI pass — **decided gate: leave enrichment to the existing `enrich`
    command/flow; `hn-sync` only inserts bare ids + sets `metadata.hn_list="saved"`.** This keeps
    `hn-sync` fast and offline-testable without mocking Firebase.)
- **Pagination:** HN list pages paginate via a "More" link. Follow the **href of the "More"
  link** parsed from each page (more robust than guessing `?p=N`). Stop when no "More" link, or
  high-water mark re-reached, or `max_pages`.
- **Ordering:** HN favorites list newest-favorited-first (standard HN listing order). The
  high-water mark = the newest `_MARK_DEPTH` `hackernews:<id>` fullnames seen; any one re-seen
  means caught up (same rationale as reddit_sync's list-mark — unsaving/favoriting shifts the
  top, so a single-name mark would silently degrade).

### Signatures to add (new file `src/content_hoarder/hn_sync.py`)
```python
_HN_MARK_KEY = "hn_sync_newest"
_HN_MARK_DEPTH = 25

def _extract_ids(html: str) -> list[str]:
    """Reuse connectors.hackernews._ITEM_ID.findall(html); distinct, order-preserving."""

def _extract_next(html: str) -> str | None:
    """href of the 'More' pagination link, or None. Fixture-grounded."""

def sync_saved(conn, *, user: str, max_pages: int = 5, stop_on_known: bool = True,
               throttle: float = 1.0, sleep=None, getf=None, user_agent: str | None = None,
               progress=None) -> dict:
    """Fetch favorites?id=<user>, walk 'More' pages, merge_upsert bare hackernews items
    (hn_list='saved'), stop at high-water mark. getf(url)->(status,bytes) injectable.
    Returns {fetched, new, updated, pages, stopped, network_error}.
    stopped in {caught_up, all_known, max_pages, exhausted, empty, network_error}."""
```
**`getf` seam:** `getf(url) -> tuple[int, bytes]` (status, body) — mirrors reddit_sync's `getf`.
Default wraps `_http.request`; tests pass a fake mapping url→canned HTML (page1 with ids + a
"More" href, page2 with ids + no "More").

### CLI (in `cli.py`, mirror `reddit-sync`)
```python
def cmd_hn_sync(args) -> int:
    conn = db.connect(...)
    res = hn_sync.sync_saved(conn, user=args.user, max_pages=args.max_pages,
                             stop_on_known=not args.full, apply=...)  # apply via commit
    # print res; commit
    return 0
# sub.add_parser("hn-sync"); args: --user (required), --max-pages, --full (stop_on_known=False)
```

### Injectable seam / offline tests
1. `test_extract_ids`: feed a synthetic favorites HTML snippet with three `item?id=NNN` links →
   the 3 ids, distinct, order kept.
2. `test_extract_next`: HTML with `<a href="/favorites?id=x&p=2">More</a>` → returns that href;
   HTML with no More → `None`.
3. `test_sync_walks_pages_and_stops_at_mark`: `:memory:` DB, seed a high-water mark containing
   one id from fake-page-1; fake `getf` returns page-1 (ids A,B,marked) + page-2 (ids C,D, no
   More). `sync_saved(stop_on_known=True)` → stops `caught_up`, inserts only the new ids before
   the mark, advances the mark. Assert no call beyond the stop page.
4. `test_sync_first_run_no_mark`: no mark → walks to `max_pages` or `exhausted`, inserts all,
   sets the mark to the top `_HN_MARK_DEPTH` ids.
5. `test_sync_network_error_soft`: `getf` raises/returns 5xx → `stopped="network_error"`, no
   crash, no partial mark advance (mirror reddit_sync: mark only advances on a real boundary).

### Acceptance
- `sync_saved` is fully offline via `getf=`; zero real network in tests.
- High-water mark prevents O(history) work on routine syncs (O(new) only); mark advances only on
  a real boundary (`caught_up`/`all_known`/`exhausted`), never on `max_pages` truncation.
- New items inserted bare (`title=""`, `hn_list="saved"`); enrichment deferred to the existing
  `enrich` flow (no Firebase mocking needed here).
- Idempotent re-run with no new favorites → `new=0`, mark unchanged.
- All tests green. `py_compile` clean. No `await`.

---

## Verification checklist (run before declaring any task done)
- [ ] `python -m pytest` (default, offline) — all green, with new tests included.
- [ ] `python -m py_compile` on every new/changed file.
- [ ] `grep -rn "await " src/content_hoarder/<new files>` — empty.
- [ ] For Task C: record the pre-change `tests/test_db*` pass/fail baseline first, then confirm
      no regression after the merge_upsert guard.
- [ ] No `*.db`, exports, or real user data committed. Only synthetic fixtures.
- [ ] No public-internet exposure added (routes are local-only, same as existing).

## Out of scope for this batch (explicitly)
- Any UI/HTML/CSS/JS (thread viewer rendering, body-edit textarea, settings UI).
- HN-sync auto-scheduler daemon (ship the `hn-sync` CLI only).
- Renaming `reddit_threads` → `threads` (schema migration; reuse as-is).
- Enrichment-inside-hn-sync (defer to the existing `enrich` flow).
- keep.py/obsidian.py `metadata.urls` connector patch (optional secondary in Task B).
