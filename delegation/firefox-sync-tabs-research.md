# Firefox sync tabs research

## Goal

Research realistic ways to reduce friction for getting currently-open Firefox tabs into `content-hoarder`, without implementing code yet.

Scope constraints:

- Keep `content-hoarder` local-first: no new cloud dependency unless clearly justified.
- Preserve connector rules: connectors parse and yield `models.new_item(...)` dicts; DB writes stay in `pipeline.py` / service layers.
- Keep tests offline and deterministic.
- Do not run live Mozilla/Firefox authentication or any external account-changing action.

Size estimate for the recommended first implementation: **medium** (roughly 1-2 focused days for a local manual-push MVP plus tests; more if packaging a real Firefox add-on).  
Concrete next action after this research: **refactor the current Firefox connector shaping into a pure helper that accepts normalized tab records, then add fixture tests for extension-style JSON input**.  
Done-when for Phase 1: **a user-triggered local snapshot imports tabs idempotently, YouTube tabs still promote, no external auth is required, and route/connector tests pass offline**.

## Implementation status (2026-06-29)

- Branch `firefox-sync-tabs-research` was promoted beyond research into a local tab-ingest slice: Firefox tab helpers, connector/CLI/route plumbing, docs, and offline tests were added.
- This is **not** a full Mozilla Firefox Sync implementation: no Mozilla account auth, encrypted Sync collection read/decrypt flow, WebExtension packaging, or live external account flow was implemented or run.
- Merged scope is local/manual tab ingestion with idempotent import behavior. Account-backed live Firefox Sync tabs remain a follow-up.

## Confirmed current state

### Existing Firefox ingestion

Confirmed from project code/docs:

- `src/content_hoarder/connectors/firefox.py` imports `.txt` files produced by the **Export Tabs URLs** extension in “Rich format” (`title` / `url` / `favicon` / `flag` under `Window:::` headers). The module docstring explicitly says OneTab / `recovery.jsonlz4` remain future inputs (`src/content_hoarder/connectors/firefox.py:1-6`).
- The connector is DB-free and yields `new_item(...)` dicts (`src/content_hoarder/connectors/firefox.py:105-150`), consistent with the connector contract (`src/content_hoarder/connectors/base.py:1-5`, `:38-40`).
- Non-YouTube tabs become:
  - `source="firefox"`
  - `kind="tab"`
  - `source_id = sha1(_norm_url(url))[:16]`
  - metadata currently includes `domain`, optional `favicon`, optional `window`, optional `pinned` (`src/content_hoarder/connectors/firefox.py:132-150`).
- URL normalization lowercases scheme+host, drops fragments, and drops trailing slash while preserving query strings (`src/content_hoarder/connectors/firefox.py:31-38`). Tests confirm same-host case/trailing-slash/fragment de-duping (`tests/test_firefox.py:49-56`).
- YouTube tabs are promoted during import into canonical `youtube:<vid>` rows, not `firefox:` rows. The connector host-guards YouTube ID extraction and rejects sentinel/non-ID embed paths (`src/content_hoarder/connectors/firefox.py:41-56`, `:132-135`; tests at `tests/test_firefox.py:85-130`).
- Promoted YouTube rows carry additive Firefox markers:
  - `metadata.open_in_firefox = true`
  - optional `metadata.firefox_window`
  - optional `metadata.firefox_pinned`
  - thumbnail URL (`src/content_hoarder/connectors/firefox.py:65-87`).
- One-time reconciliation for old Firefox-imported YouTube tabs lives in `src/content_hoarder/firefox_youtube.py`. It is intentionally not a connector and writes via DB helpers; dry-run by default (`src/content_hoarder/firefox_youtube.py:1-18`, `:60-87`). Tests pin duplicate/orphan behavior and status preservation (`tests/test_firefox_youtube_merge.py:36-115`).
- The general import pipeline materializes connector output and calls `db.merge_upsert(...)` for each item, then commits (`src/content_hoarder/pipeline.py:36-80`).
- `merge_upsert(...)` is non-destructive: it preserves triage/user state (`status`, `processed_utc`, `status_prev`, `is_saved`, `metadata.karakeep_id`), preserves `first_seen_utc`, shallow-merges metadata, and updates `last_seen_utc` on re-import (`src/content_hoarder/db.py:652-733`).
- Docs currently describe the manual flow: install Export Tabs URLs, export Rich `.txt`, run `python -m content_hoarder import "path\to\tabs.txt"`; YouTube tabs auto-promote and can be browsed with the Firefox tabs filter (`docs/IMPORTING.md:106-126`).
- Backlog confirms the shipped shape and says current live-tab integration is unchosen, with candidates: WebExtension `POST /import/firefox-tabs`, local `sessionstore`/`recovery.jsonlz4`, or bookmarklet/native messaging (`BACKLOG.md:240-251`).

### Search/UI implications already present

- `is:firefox-tab` parses into `ParsedQuery.open_in_firefox` (`src/content_hoarder/search_query.py:40-43`, `:237-259`).
- The `/items` route passes that flag through to `db.search_items(...)` (`src/content_hoarder/web.py:260-306`).
- `db.search_items(..., open_in_firefox=True)` currently filters only `json_extract(metadata, '$.open_in_firefox') = 1` (`src/content_hoarder/db.py:1003-1006`).

Important current-state mismatch:

- Confirmed: non-YouTube `firefox:` rows emitted by `FirefoxConnector._make(...)` do **not** currently set `metadata.open_in_firefox` (`src/content_hoarder/connectors/firefox.py:136-149`).
- Confirmed: `is:firefox-tab` only matches rows with `metadata.open_in_firefox = 1` (`src/content_hoarder/db.py:1003-1006`).
- Inferred implication: today `source:firefox` catches non-YouTube Firefox tab rows, while `is:firefox-tab` catches at least promoted YouTube tab rows. If a new live sync wants one filter to mean “currently/opened in Firefox”, it should either set `open_in_firefox` for all live-imported tab rows or broaden the filter to `source='firefox' OR open_in_firefox`; that choice needs a small compatibility decision and tests.

### Existing storage for secrets/state

- The DB has a generic `settings(key, value)` table and helper functions `get_setting(...)` / `set_setting(...)` (`src/content_hoarder/db.py:65-68`, `:274-286`).
- The DB also has an `auth_tokens` table for service tokens (`src/content_hoarder/db.py:70-79`).
- Inferred recommendation: a local ingest token is closer to app configuration than an external OAuth token, so store a hash/identifier in `settings` unless/until a broader auth-token abstraction exists.

## Research findings

### Official Firefox Sync / Mozilla Sync

Confirmed from official Mozilla Sync docs:

- Firefox Sync exists to exchange browser data, including **open tabs**, between clients while preserving user security/privacy. Data is encrypted locally before it reaches the Sync server; server operators cannot read it without the user’s secret key material. Source: Mozilla Sync overview, <https://mozilla-services.readthedocs.io/en/latest/sync/overview.html>.
- The Sync server stores collections/records and public metadata such as modified times; clients can selectively fetch records changed since the last sync operation. Source: same overview.
- In storage format 5, nearly every record except `meta/global` is encrypted. `crypto/keys` stores encrypted bulk keys. Records use AES-256-CBC plus HMAC verification; clients must verify HMAC before decrypting. Source: Mozilla Sync storage format 5, <https://mozilla-services.readthedocs.io/en/latest/sync/storageformat5.html>.
- The Class-B Master Key (`kB`) is obtained through Mozilla Accounts / Sync sign-in and should never be sent to an untrusted party or stored where others can access it. Source: same storage-format doc.
- `meta/global` can contain an engine entry for `tabs`. Source: same storage-format doc example.
- The Sync `tabs` collection is documented in object formats:
  - Version 1: each client provides one record with `clientName` and `tabs[]`; each tab has `title`, `urlHistory`, `icon`, and `lastUsed`.
  - Version 2 proposal: each tab is its own record with `clientID`, `title`, `history`, `lastUsed`, `icon`, and `groupName`; the initial history element is the current URL.
  Source: Firefox object formats, <https://mozilla-services.readthedocs.io/en/latest/sync/objectformats.html>.

Interpretation:

- Confirmed: Sync has tab data, but it is stored as encrypted Sync collection records, not as cleartext account API responses.
- Inferred: there is no simple “give me my synced tabs as JSON” account endpoint suitable for this app. A true Sync implementation would need Mozilla Account auth, `kB` handling, Sync node/storage access, `meta/global`, `crypto/keys`, collection decryption, HMAC verification, and tabs-object parsing.
- Risk: implementing a Sync client from scratch would introduce sensitive credential/key handling and a sizable cryptographic protocol surface. This is disproportionate for the near-term goal of manual open-tab capture.

### WebExtension manual push

Confirmed from MDN:

- `browser.tabs.query(queryInfo)` returns a Promise of `tabs.Tab[]`; calling it with `{}` gets all tabs, and `{ currentWindow: true }` gets the current window. Source: MDN `tabs.query`, <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/query>.
- `tabs.Tab` includes useful fields for this project: `url`, `title`, `favIconUrl`, `windowId`, `index`, `pinned`, `active`, `discarded`, `lastAccessed`, `incognito`, `cookieStoreId`, `groupId`, etc. `url`, `title`, and `favIconUrl` require the `tabs` permission or matching host permissions. Source: MDN `tabs.Tab`, <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/Tab>.
- The `tabs` permission grants access to privileged tab fields (`Tab.url`, `Tab.title`, `Tab.favIconUrl`). Source: MDN permissions, <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/permissions>.
- Host permissions can allow extension pages/background scripts to `fetch` cross-origin without normal CORS restrictions. For MV3, host permissions are listed in `host_permissions`; MDN notes these privileges do **not** apply to content-script requests, but do apply to regular extension pages. Source: MDN host permissions, <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/host_permissions> and content-script XHR/fetch notes, <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts#xhr_and_fetch>.

Interpretation:

- Confirmed: a small Firefox extension can read open tabs after requesting the appropriate permission(s).
- Inferred recommended shape: a user-clicked extension action gathers tabs with `browser.tabs.query({})`, filters out private/incognito tabs by default, and sends a JSON snapshot to the local Flask app at `http://127.0.0.1:8788/import/firefox-tabs` with a local bearer token.
- This matches the backlog’s “manual ramp” requirement and avoids Mozilla account auth entirely.

### Native messaging

Confirmed from MDN:

- Native messaging lets an extension exchange JSON messages with a native app installed on the user’s computer. It requires the extension to request the `nativeMessaging` permission, and the native app manifest must allow the extension ID via `allowed_extensions`. Source: MDN Native messaging, <https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging>.
- On Windows, Firefox discovers native-messaging hosts through registry keys under `HKEY_CURRENT_USER\Software\Mozilla\NativeMessagingHosts\<name>` or `HKEY_LOCAL_MACHINE\Software\Mozilla\NativeMessagingHosts\<name>`, whose default value points at the app manifest. Source: same MDN page.
- Native messages are JSON, UTF-8 encoded, prefixed with a native-endian 32-bit length. MDN’s Python 3 example uses `python3 -u` and binary stdin/stdout. Source: same MDN page.

Interpretation:

- Confirmed: native messaging is viable, but it requires host manifest installation and Windows registry setup.
- Inferred: native messaging is unnecessary for the first version if a WebExtension can `fetch` to the local Flask server with a host permission for `http://127.0.0.1:8788/*`.
- Best use later: if direct localhost POST is unreliable across Firefox versions/profiles, or if the app is not already running and the extension should launch a native helper. That is higher friction and should not be Phase 1.

### Local Firefox profile / sessionstore

Confirmed from Mozilla Support:

- Firefox stores user data in a profile folder. On default Windows installs, profiles live under `%APPDATA%\Mozilla\Firefox\Profiles\`; Microsoft Store/MSIX installs use a different location under `%LOCALAPPDATA%\Packages\Mozilla.Firefox...\LocalCache\Roaming\Mozilla\Firefox\Profiles\`. Source: Mozilla Support profile docs, <https://support.mozilla.org/en-US/kb/profiles-where-firefox-stores-user-data>.
- The profile contains `sessionstore.jsonlz4`, described as storing the currently open tabs and windows. Source: same profile docs.
- Firefox Session Restore restores regular tabs/windows; private windows are not restored by design. Source: Mozilla Support session restore docs, <https://support.mozilla.org/en-US/kb/restore-previous-session>.

Interpretation:

- Confirmed: a local-profile reader could avoid extension packaging and Mozilla account auth.
- Inferred: parsing `sessionstore.jsonlz4` / `sessionstore-backups/recovery.jsonlz4` would require Mozilla’s JSONLZ4 decompression format and real profile-shape fixtures. The existing connector already notes `recovery.jsonlz4` as future input, so this path fits the project roadmap.
- Risk: profile/sessionstore format is more fragile than WebExtension `tabs.Tab`, may be stale while Firefox is running, and could require copying files before reading to avoid partial writes. It also captures whatever Firefox persists for restore, not necessarily a user-triggered “current tabs right now” snapshot.

### Existing browser export

Confirmed from project docs/code:

- Export Tabs URLs Rich `.txt` is already supported and tested (`docs/IMPORTING.md:106-126`; `tests/test_firefox.py`).
- This is fully offline and deterministic, but it is manual and requires a third-party extension plus file export/import.

Interpretation:

- Keep this path as the stable fallback.
- A new WebExtension JSON export/import can reuse the same tab-shaping logic and tests, so users still have a no-server file workflow if direct POST is not desired.

### Option comparison

| Option | What it gets | Auth/secrets | Privacy | Complexity | Fit |
|---|---|---|---|---|---|
| Current Export Tabs URLs `.txt` | Manual snapshot from extension-exported file | None in app | Local file contains tab URLs/titles | Already built | Keep as fallback |
| New WebExtension direct POST | User-triggered current tabs from Firefox | Local ingest token only | Sends tab URLs/titles to local app only | Medium | **Recommended Phase 1** |
| New WebExtension JSON export file | User-triggered current tabs as a file | None | Local file contains tab URLs/titles | Low-medium | Good adjunct/test fixture path |
| Local profile/sessionstore reader | Last persisted session tabs/windows | None, but profile path access | Reads sensitive local profile data | Medium-high, format-fragile | Phase 2 optional |
| Native messaging | Extension can talk to/launch local native app | Extension ID + native host manifest | Local only | High setup friction on Windows | Defer |
| Official Firefox Sync client | Cross-device synced tabs | Mozilla Account auth + Sync key material (`kB`) | Highly sensitive encrypted browser data | High/very high | Research-only / defer |

## Proposed approach

Recommendation: **do not implement official Firefox Sync first**. Build a local, user-triggered manual push using a small WebExtension plus a local authenticated Flask ingest endpoint, with a file-import fallback using the same parser.

Rationale:

1. It satisfies the real user story: “send currently-open tabs to content-hoarder on demand.”
2. It avoids Mozilla Account auth, Sync key derivation, cryptographic storage handling, and long-lived external secrets.
3. It is consistent with the backlog’s “manual ramp” and “zero-new-friction” guardrail: no background scraping, no account sync, no always-on capture.
4. It reuses the current item shape, URL hash de-duping, YouTube promotion, and `merge_upsert` idempotency.
5. It is testable offline: the backend can be tested with synthetic JSON payloads, and the extension can be small enough to inspect manually.

Recommended phases:

- **Phase 0: backend parser refactor, no new UI.** Extract current Firefox tab shaping into pure helpers that accept normalized tab records independent of `.txt` parsing.
- **Phase 1: local manual push.** Add a local Flask `POST /import/firefox-tabs` endpoint gated by a local token. Build a tiny optional WebExtension that calls `browser.tabs.query({})` on user click and POSTs a snapshot.
- **Phase 1b: JSON file fallback.** Let the same connector import extension-exported JSON files, so users can export from the extension and run `python -m content_hoarder import tabs.json --source firefox` without keeping the web app running.
- **Phase 2: local profile/sessionstore reader.** Add a CLI-only reader for `sessionstore.jsonlz4` / `recovery.jsonlz4` if a real sample confirms the JSON shape and decompression approach.
- **Phase 3: official Firefox Sync only if still needed.** Before implementation, find and evaluate a maintained Python Firefox Sync client library. If none exists, treat this as a separate security-sensitive project, not a connector-sized task.

## Data model / mapping

### Stable identity

Keep the existing identity strategy for non-YouTube tabs:

- `source = "firefox"`
- `kind = "tab"`
- `source_id = sha1(_norm_url(url)).hexdigest()[:16]`
- `fullname = "firefox:<source_id>"`

Why:

- Confirmed current tests pin stable URL-hash de-duping (`tests/test_firefox.py:44-56`).
- It makes repeated snapshots idempotent and merges with historical Export Tabs URLs imports.
- It avoids creating per-snapshot duplicates for the same tab URL.

Keep existing YouTube promotion:

- YouTube tab URL -> `youtube:<vid>` via existing `youtube_id(...)` / `yt_item(...)` logic.
- Continue to make Firefox markers additive so Watch Later metadata is not clobbered.

### Normalized input shape for WebExtension / JSON import

Proposed internal normalized tab record fields. These are project-internal, not official Firefox API fields unless marked confirmed:

- `url` — confirmed available from `tabs.Tab.url` with `tabs` or matching host permission.
- `title` — confirmed available from `tabs.Tab.title` with `tabs` or matching host permission.
- `favicon` — map from confirmed `tabs.Tab.favIconUrl`.
- `window` — map from confirmed `tabs.Tab.windowId`.
- `index` — map from confirmed `tabs.Tab.index`.
- `pinned` — map from confirmed `tabs.Tab.pinned`.
- `active` — map from confirmed `tabs.Tab.active`.
- `discarded` — map from confirmed `tabs.Tab.discarded`.
- `last_accessed_ms` — map from confirmed `tabs.Tab.lastAccessed`.
- `cookie_store_id` — map from confirmed optional `tabs.Tab.cookieStoreId` if present.
- `group_id` — map from confirmed optional `tabs.Tab.groupId` if present.
- `incognito` — map from confirmed `tabs.Tab.incognito`; default behavior should skip incognito/private tabs unless the user explicitly opts in.
- `capture_source` — internal value such as `webextension`, `json_export`, or `sessionstore`.
- `captured_at` — local Unix seconds when content-hoarder received/generated the snapshot.
- `snapshot_id` — internal per-import identifier for optional reconciliation.

### Metadata keys

For non-YouTube `firefox:` rows, preserve current keys and add only non-breaking keys:

- Existing keys to preserve:
  - `domain`
  - `favicon`
  - `window`
  - `pinned`
- Recommended additions for live/manual snapshots:
  - `open_in_firefox: true` — makes live non-YouTube tabs visible through the existing `is:firefox-tab` filter. This is a behavior choice; add a test because historical exported rows did not set it.
  - `firefox_capture_source`
  - `firefox_captured_at`
  - `firefox_snapshot_id`
  - `firefox_index`
  - `firefox_active`
  - `firefox_discarded`
  - `firefox_last_accessed_ms`
  - optional `firefox_cookie_store_id`
  - optional `firefox_group_id`

For promoted `youtube:` rows, preserve current keys and add only Firefox-prefixed metadata:

- Existing keys:
  - `open_in_firefox: true`
  - `firefox_window`
  - `firefox_pinned`
  - `thumbnail`
- Recommended additions:
  - `firefox_original_url` — preserves the actual tab URL including `list`, `index`, or timestamp query params that `yt_item(...)` currently collapses to `https://youtu.be/<vid>`.
  - `firefox_capture_source`
  - `firefox_captured_at`
  - `firefox_snapshot_id`
  - `firefox_index`
  - `firefox_active`
  - `firefox_discarded`
  - `firefox_last_accessed_ms`

### Saved/current semantics

Do **not** treat missing-from-latest-snapshot as delete/archive/done in Phase 1.

Recommended Phase 1 semantics:

- Importing a snapshot means “I saw this tab open at `captured_at`.”
- Re-importing the same tab updates `last_seen_utc` via `merge_upsert(...)` and merges metadata.
- Triage status remains user-owned and preserved.
- No rows are removed or marked closed automatically.

Optional Phase 2 reconciliation semantics, only with dry-run/apply:

- Record `settings.firefox_last_snapshot_id` and `settings.firefox_last_snapshot_at`.
- For rows with old `metadata.firefox_snapshot_id`, optionally set `metadata.firefox_current = false` or `metadata.firefox_closed_seen_at = <now>`.
- Never change `status` automatically.
- Make this dry-run by default and reversible enough to clear metadata.

### Firefox Sync mapping, if ever implemented

Confirmed Sync tabs object fields:

- Version 1 tab record: `clientName`, `tabs[]`, each with `title`, `urlHistory`, `icon`, `lastUsed`.
- Version 2 proposal: `clientID`, `title`, `history`, `lastUsed`, `icon`, `groupName`; first `history` element is current URL.

If implemented later:

- Use current URL from actual observed payload. Confirm with a fixture before coding. For version 1, docs only say `urlHistory` is page URLs in history; do not assume order without a real decrypted fixture or source confirmation.
- Store Sync provenance in metadata, e.g. `firefox_sync_client_name`, `firefox_sync_record_id`, `firefox_sync_modified`, `firefox_last_used`.
- Store incremental collection modified timestamp in `settings`, e.g. `firefox_sync_tabs_since`, only after a complete successful fetch/decrypt/import.

## Implementation plan

### Phase 0 — Refactor current Firefox shaping

Likely files touched:

- `src/content_hoarder/connectors/firefox.py`
- `tests/test_firefox.py`

Plan:

1. Keep `FirefoxConnector.can_import(...)` and current `.txt` behavior intact.
2. Extract a pure helper such as `item_from_tab_record(record: dict) -> dict | None` or `items_from_tab_records(records: Iterable[dict]) -> Iterable[dict]`.
3. Keep `_norm_url(...)`, `_domain(...)`, `youtube_id(...)`, `_clean_yt_tab_title(...)`, and `yt_item(...)` behavior byte-compatible where tests already pin it.
4. Convert existing `.txt` parser output into the normalized record shape, then call the helper.
5. Add JSON fixture tests before adding any web route.

Notes:

- Do not move DB writes into the connector.
- Do not import heavy optional dependencies at module import time.
- If adding `open_in_firefox` to non-YouTube live records, consider whether `.txt` imports should also receive it going forward. My recommendation: set it for all Firefox tab inputs going forward, because it means “this came from an open-tab capture,” but explicitly test the filter behavior.

### Phase 1 — Local authenticated ingest endpoint

Likely files touched:

- `src/content_hoarder/web.py`
- `src/content_hoarder/pipeline.py` or a new small service module such as `src/content_hoarder/firefox_tabs.py`
- `src/content_hoarder/db.py` only if token helpers/settings wrappers are needed
- `tests/test_firefox.py` and/or new `tests/test_firefox_tabs_ingest.py`
- `docs/IMPORTING.md` after implementation

Endpoint shape:

- `POST /import/firefox-tabs`
- Bind remains local-only with the existing Flask app default (`127.0.0.1:8788`). Do not expose publicly.
- Require one of:
  - `Authorization: Bearer <local-token>`, preferred, or
  - `X-Content-Hoarder-Token: <local-token>` if simpler for extension code.
- Accept JSON payload with:
  - `schema: "content-hoarder.firefox-tabs.v1"`
  - `captured_at`
  - `source: "webextension"`
  - `tabs: [...]`
- Response JSON should include counts: `imported`, `skipped`, `errors`, maybe `youtube_promoted`, and a small sample.

Token model:

- Generate a random local token with Python `secrets` in a CLI/setup command or first-run UI action.
- Store only a hash in `settings`, e.g. `firefox_ingest_token_sha256`, if feasible.
- Show/copy the raw token once for extension configuration.
- Never hardcode tokens in source or docs.
- Do not reuse Mozilla/Firefox account credentials.

Security behavior:

- Reject missing/invalid token with 401/403.
- Reject non-JSON or malformed schema with 400.
- Skip `incognito` tabs by default even if the extension sends them.
- Ignore non-http(s) URLs initially unless a decision is made for `about:`, `file:`, `moz-extension:`, etc. Recommended default: skip them and report count, because current connector only imports `http(s)` URLs.
- Do not enable CORS globally for the app. If direct extension `fetch` requires CORS in practice despite host permissions, add the narrowest possible handling for this endpoint and document why.

### Phase 1a — Tiny WebExtension

Likely new files after implementation decision:

- A small directory such as `extensions/firefox-tabs/` or `tools/firefox-tabs-extension/`.
- Files likely include `manifest.json`, background script, options page or popup, and README.

Extension behavior:

1. User clicks “Send tabs to content-hoarder.”
2. Extension calls `browser.tabs.query({})` or offers current-window/all-windows toggle.
3. Extension filters out `tab.incognito` by default.
4. Extension maps `tabs.Tab` fields to the backend schema.
5. Extension POSTs to `http://127.0.0.1:8788/import/firefox-tabs` with the configured token.
6. Extension shows success/failure counts.

Minimum extension permissions:

- `tabs` permission, confirmed needed for `url`, `title`, `favIconUrl` without broad host permissions.
- Host permission for `http://127.0.0.1:8788/*` or the configured local app origin.
- Avoid `<all_urls>` unless a specific browser compatibility issue forces it.

Open packaging question:

- Confirm whether this should be a temporary/developer-loaded extension, a private signed `.xpi`, or just a reference snippet. Packaging/signing is outside backend MVP scope.

### Phase 1b — JSON file import fallback

Likely files touched:

- `src/content_hoarder/connectors/firefox.py`
- `tests/test_firefox.py`
- `docs/IMPORTING.md`

Plan:

- Extend `FirefoxConnector.can_import(...)` to recognize a clearly namespaced JSON schema such as `schema = "content-hoarder.firefox-tabs.v1"`.
- `import_file(...)` should dispatch internally: existing `.txt` parser vs new JSON parser.
- This makes extension output importable without running the Flask app and gives deterministic fixtures for tests.

### Phase 2 — Local profile/sessionstore reader

Likely files touched:

- `src/content_hoarder/connectors/firefox.py` or a new `src/content_hoarder/firefox_sessionstore.py`
- `tests/test_firefox_sessionstore.py`
- `docs/IMPORTING.md`

Plan:

1. First obtain a synthetic or user-sanitized sample of `sessionstore.jsonlz4` / `recovery.jsonlz4`.
2. Confirm decompression approach and JSON shape from source/sample before coding field paths.
3. Implement as CLI/import path only, not background scanning.
4. Lazy-import any optional decompression dependency.
5. Copy the sessionstore file to a temp path before reading if Firefox may be writing it.
6. Parse tabs into the same normalized record shape as Phase 0.

Do not guess paths such as `windows[].tabs[].entries[]` until verified by a real sample or official/source docs.

### Phase 3 — Official Firefox Sync client research

Only pursue if the user explicitly needs cross-device synced tabs without a local extension/profile.

Before coding:

1. Search for a maintained Python Firefox Sync client library.
2. Confirm current Mozilla Account auth flow and whether it is supported for third-party/CLI clients.
3. Confirm how to obtain and securely store/access `kB`.
4. Confirm storage endpoint discovery for current Firefox Sync.
5. Build a standalone proof-of-concept against a throwaway test account, never the user’s real account first.
6. Threat-model local storage of Sync key material.

Expected files if it ever proceeds:

- `src/content_hoarder/firefox_sync.py` for protocol/client logic.
- Possibly `src/content_hoarder/connectors/firefox.py` only for mapping decrypted tabs to items.
- `tests/test_firefox_sync_mapping.py` with synthetic decrypted records; cryptography tests should use official test vectors if available.
- Config/docs for opt-in credentials.

## Tests and validation

Backend tests should remain offline and deterministic.

Recommended tests:

1. **Existing regression tests stay green**
   - `tests/test_firefox.py`
   - `tests/test_firefox_youtube_merge.py`
2. **Normalized record parser**
   - Given extension-style records, emits same `firefox:<url-hash>` item as `.txt` import for the same URL.
   - Preserves `domain`, `favicon`, `window`, `pinned`.
   - Adds live metadata only where intended.
   - Skips empty/malformed/non-http URLs with counted errors/skips.
3. **YouTube promotion from extension records**
   - `watch?v=`, `youtu.be`, and Shorts still promote to `youtube:<vid>`.
   - Non-YouTube host with `?v=` does not promote.
   - `firefox_original_url` is preserved if added.
4. **Import idempotency**
   - Import same JSON twice; item fullnames are identical.
   - Triage status is preserved on second import.
   - Metadata shallow merge does not erase manual/programmatic tags.
5. **Ingest route auth**
   - Missing token rejected.
   - Wrong token rejected.
   - Valid token imports and returns counts.
   - Malformed schema rejected.
6. **Search/filter behavior**
   - If live non-YouTube rows get `open_in_firefox`, `is:firefox-tab` returns both `firefox:` rows and promoted `youtube:` rows.
   - If filter broadens instead, test exact SQL/search behavior so older rows are covered intentionally.
7. **Optional sessionstore tests**
   - Use a tiny synthetic compressed fixture or dependency-injected decompressor.
   - Confirm parser handles missing optional fields.
   - No real profile files in fixtures.
8. **Extension manual QA**
   - Temporary install in Firefox desktop.
   - Configure token.
   - Send current window and all windows.
   - Confirm counts and visible rows in `content-hoarder`.
   - Confirm incognito/private tabs are not imported by default.

Validation commands after implementation:

- `python -m pytest tests/test_firefox.py tests/test_firefox_youtube_merge.py`
- Add route-specific tests, then run them directly.
- If route touches broad web behavior, run the default suite: `python -m pytest`.
- For UI-visible filter behavior, consider the existing UI tests if a visible UI affordance changes; backend-only endpoint work should not require Playwright unless the browse filter/UI changes.

## Risks / open questions

### Key risks

- **Firefox Sync complexity:** confirmed encrypted collections and `kB` handling make official Sync far more sensitive than a connector. Avoid until there is a compelling cross-device need.
- **Local endpoint exposure:** any localhost POST endpoint must be token-gated. Do not rely on “localhost only” as the sole protection; malicious local webpages can try to talk to localhost services.
- **CORS/extension differences:** MDN indicates extension pages with host permissions can fetch cross-origin; content scripts and MV3 have different behavior. Implement extension POST from a background/extension context, not a content script.
- **Filter semantics mismatch:** existing `is:firefox-tab` is marker-based, while non-YouTube `firefox:` rows historically lack the marker. Decide and test whether to add markers going forward or broaden the filter.
- **Profile/sessionstore fragility:** official support confirms the file exists, but not its internal JSON shape. Do not implement path-specific parsing without a sample/source confirmation.
- **Extension packaging/signing:** a local/private extension may be easy for the user but awkward to distribute. Decide whether this is personal tooling or a project-supported extension.
- **Sensitive data:** tab URLs/titles can include private project names, tokens in query strings, and account pages. Default to manual action, clear preview/counts, no background capture.
- **Incognito/private tabs:** `tabs.Tab.incognito` is available; skip by default. Confirm behavior in Firefox where extension access to private windows depends on user settings.
- **Mobile Firefox:** if Pixel 6 / Firefox Android support is desired, verify that the needed extension APIs and installation path are available on the target device before promising support.

### Open questions

1. Should “Firefox tabs” mean:
   - all historical Firefox-imported tabs (`source:firefox`),
   - currently-open/live-imported tabs (`metadata.open_in_firefox`), or
   - both?
2. Should the WebExtension send all windows or only the current window by default?
3. Should closed-tab reconciliation exist at all, or is “last seen open” enough for triage?
4. Where should the local ingest token be created/displayed: CLI command, settings page, or app startup log?
5. Should extension JSON export be supported before direct POST to simplify testing and onboarding?
6. Should non-http(s) URLs be skipped or stored? Current connector effectively only handles `http(s)`.
7. If official Sync is ever revisited, what threat model is acceptable for storing/accessing `kB` locally?

## Suggested delegation slices

1. **Backend parser/refactor slice**
   - Files: `src/content_hoarder/connectors/firefox.py`, `tests/test_firefox.py`.
   - Deliverable: pure normalized-tab-to-item helper; existing `.txt` tests pass; new JSON-style helper tests pass.
   - No web route, no extension.

2. **JSON import slice**
   - Files: `src/content_hoarder/connectors/firefox.py`, `tests/test_firefox.py`, `docs/IMPORTING.md`.
   - Deliverable: connector recognizes `content-hoarder.firefox-tabs.v1` JSON export and imports it idempotently.

3. **Authenticated ingest endpoint slice**
   - Files: `src/content_hoarder/web.py`, small service module if needed, route tests.
   - Deliverable: `POST /import/firefox-tabs` with token auth, offline route tests, no CORS broadening unless proven necessary.

4. **Search/filter semantics slice**
   - Files: `src/content_hoarder/search_query.py`, `src/content_hoarder/db.py`, relevant tests, maybe UI operator hints.
   - Deliverable: intentional, tested definition of `is:firefox-tab` covering live non-YouTube and promoted YouTube rows.

5. **WebExtension MVP slice**
   - Files: new `extensions/firefox-tabs/` or similar.
   - Deliverable: manually installed extension with button, token setting, current/all windows toggle, success/error counts.
   - Manual QA required in Firefox; backend tests remain offline.

6. **Sessionstore research/prototype slice**
   - Files: isolated research notes first; code only after sample confirmation.
   - Deliverable: documented sample shape and decompression approach, then optional CLI/import reader with synthetic fixture tests.

7. **Firefox Sync feasibility slice**
   - Research only unless separately approved.
   - Deliverable: maintained-library search, current auth-flow confirmation, security review, and go/no-go recommendation before any code.