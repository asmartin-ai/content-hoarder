# Spec 15 — PKMS promote action (resurface-card integration)

**Status: PROPOSED — phase 1 design + prep only. No implementation in this phase.**

Governing decision: life-os ADR 0027 (Accepted 2026-07-28, Option C hybrid).
PKMS-side ingest spec in flight: `K:\Projects\PKMS\vault\projects\pkms-design\build-plan.md`
§S3, branch `feat/promotion-ingest-spec`. This spec is transport-agnostic by
design — the transport decision (file drop vs `POST /capture`) belongs to the
PKMS spec; §5 lists the exact decision points awaiting it.

Contract references (cite, don't copy): `K:\Projects\life-os\docs\contracts.md`
(`capture`, `external_item`, `resurface_card`, `source_span`, `action_receipt`,
`attention_budget`, `ledger_event`); click-tested fixture
`K:\Projects\life-os\fixtures\content-hoarder\` (issue CH#72, closed 2026-07-20):
`item-001.json`, `item-002.json`, `attention_budget.json`, `promotion-card/`,
`validate.py`.

---

## 1. End-to-end flow (triage sprint → receipt)

```
resurface proposal        explicit accept          envelope            transport            PKMS ingest            receipt
─────────────────         ───────────────          ─────────           ─────────            ───────────            ───────
GET /resurface            POST /items/<fn>/        bridge/pkms.py      PROVISIONAL          (PKMS side, S3):       metadata.promotion
(one cluster card/day,    promote  (user tap,       build_capture()     POST /capture  →     vault/inbox/<note>      {status, receipt,
 ADR 0016 rationing)      never automatic)         → capture envelope  file drop  ⬄         per its spec            delivery_ref}
```

1. **Proposal.** The CH ambient slot (`GET /resurface`) proposes the day's ONE
   cluster card (rationed to one per day inside `resurface.candidate()` via the
   `_served_on` marker — the attention-budget gate, §1.1). "Show me" opens the
   browse feed filtered to that cluster (`subreddit:`/`tag:` + `status:inbox`).
   The card itself stays cluster-shaped (locked design,
   `docs/resurfacing-card-design.md`); promote is a per-item action in the
   triage feed, not a cluster action (decision D1).
2. **Explicit accept.** The user taps **Promote** on an individual item (row
   long-press / right-click menu, alongside Share; see §7). Nothing promotes
   without this explicit per-item gesture. ADR 0027 §Decision.2: "an explicit
   accept promotes the item".
3. **Envelope construction.** `bridge/pkms.py build_capture(item)` builds the
   `capture` envelope per `contracts.md` (mapping in §3) including the two-hop
   `source_span` anchor (`raw_ref = content-hoarder:fullname:<fullname>`).
4. **Transport.** PROVISIONAL: HTTP `POST /capture` (§5). Final mechanism,
   endpoint, and auth are decided by the PKMS ingest spec (S3's open question).
5. **PKMS ingest.** PKMS appends the capture to `vault/inbox/` like every other
   ramp (Decision 0003); classification happens after. Out of CH scope.
6. **Receipt.** CH records the `action_receipt` on the item's `metadata`
   (§4) with the PKMS-side delivery reference when one exists. A transport
   failure records `status: failed` — never a silent no-op, never a partial
   receipt presented as success.

### 1.1 Where the attention-budget gate (ADR 0016) sits

The gate sits at **proposal time**, and it already exists in CH:

- `resurface.candidate()` serves at most one card per calendar day
  (`settings.resurfacing_state._served_on`), CH's instantiation of the ADR 0016
  rationing rule. No card, no promote.
- Promotion additionally requires the **explicit accept** (§1 step 2) — there
  is no auto-promote path (ADR 0027 §Decision.3 / Option B rejected).
- The `attention_budget.json` fixture (`max_cards_per_day: 1`) is a life-os-side
  policy object, not CH state. If PKMS serves the card, PKMS enforces its own
  copy of the budget. **CH needs no new budget state** (decision D3) — its
  one-card rationing + explicit accept is the complete gate on this side.

---

## 2. Integration contract: the two systems' shapes (confirmed vs inferred)

**Confirmed (read from code / docs this session):**

- CH `items` row (db.py schema, `models.ITEM_FIELDS`): `fullname` (PK
  `"<source>:<source_id>"`), `source`, `source_id`, `kind`, `title`, `body`,
  `url`, `author`, `created_utc`, `saved_utc`, `is_saved`, `first_seen_utc`,
  `last_seen_utc`, `hydrated_at`, `status`, `processed_utc`, `status_prev`,
  `search_text`, `metadata` (JSON), `raw_json`. Public shape:
  `db._row_to_public()` (metadata parsed to dict).
- CH `metadata` keys in use: `subreddit`, `channel`, `tags`, `labels`,
  `playlist`, `domain`, `ocr_text` (search blob, models.py `_META_SEARCH_KEYS`);
  plus `thumbnail`, `triage_score`, `media_type`/`media_url`, `archived_media`,
  `media_status`, `karakeep_id`, `folder`.
- CH `GET /resurface` payload (resurface.py `candidate()`):
  `{cluster, label, count, last_added_utc, reactivated, sample[3], query}` —
  `sample[]` entries are `{fullname, title, thumbnail}` (item anchors already
  present on the card).
- Existing outbound-push precedent: `cli promote` → `bridge/karakeep.py`
  `promote()` — opt-in via `KARAKEEP_BASE_URL` + `KARAKEEP_API_KEY`
  (`is_configured()` no-op when unset), idempotent via `metadata.karakeep_id`,
  stdlib `_http.request` POST, receipt-ish state written by direct
  `UPDATE items SET metadata=?` (NOT `merge_upsert`). This is the template for
  `bridge/pkms.py`.
- Life-os fixture shapes (item-001.json): `external_item.origin_ref` /
  `source_span.source_ref` = `"content-hoarder:fullname:reddit:t3_fixture001"`;
  promote envelope `tool_name: "pkms.promote_from_content_hoarder"`,
  `side_effect_class: "draft_propose"` (fixture-only; a real promote is a
  `confirmed_write`), `risk_radius: "single_item"`, `reversibility: "reversible"`;
  promote receipt `{id, action_envelope_id, actor: "user", result, occurred_at,
  reason, source_span_ids, reversibility, human_summary}`.
- PKMS S3 direction: destination `vault/inbox/`; envelope per the `capture`
  contract with `source = "content-hoarder"`; provenance two-hop — "PKMS note →
  content-hoarder item id → original URL. Never flatten to the original URL
  only; the CH hop carries tags/decay/receipt state." Transport (file drop vs
  `POST /capture`) is the declared open question; "capture path gains zero
  decisions either way".
- PKMS web service: token-gated, port 8765 (`pkms serve`); §2 of its
  delegation-roadmap pins the `POST /capture` contract as stable
  ("existing … capture `POST /capture` contract don't change without a packet").

**[INFERENCE]** PKMS `POST /capture` exists as a route today (the roadmap
references it as an existing stable contract). Exact path, auth header shape,
and response body are not verified in this session — they are decision points
DP-2/DP-3 for the PKMS spec. Nothing in §5 depends on them being final.

---

## 3. Item → `capture` envelope mapping + two-hop `source_span`

### 3.1 Field mapping (CH item → capture envelope)

`contracts.md`'s `capture` sketch is explicitly placeholder ("Treat field names
as placeholders until fixtures are created and validated"); S3 pins the CH
envelope to its six fields. Mapping:

| capture field | CH source (column / metadata key) | Notes |
|---|---|---|
| `id` | derived: `capture_<source>_<source_id>` | DP-7: PKMS may assign instead; the idempotency key is `raw_ref` regardless. |
| `captured_at` | now, ISO-8601 | Promotion time, NOT `saved_utc`/`created_utc`. |
| `source` | constant `"content-hoarder"` | Per S3. Not in contracts.md's sketch enum — new value, expected. |
| `source_account_id` | `null` | DP-8: CH has no account registry; the fixture's `acct_*` ids are life-os-side. A derived stable id (`ch:<source>`) is possible if PKMS wants one. |
| `raw_text` | `title` + `"\n\n"` + `body` (fall back to either alone; `fullname` last resort) | Text-composition precedent: `bridge/karakeep.py _payload()`. Recommended to end with the original `url` line so the note is self-contained — placement is DP-4 (envelope format). |
| `raw_ref` | `"content-hoarder:fullname:<fullname>"` | The stable two-hop anchor (fixture precedent: `origin_ref`/`source_ref`). NEVER the bare URL. |
| `context.device` | `"desktop"` (web) / `"phone"` (mobile PWA) | DP-9: cheapest truthful signal; exact detection is phase-2 detail. |
| `context.app` | `"content-hoarder"` | Constant. |

Not in the envelope (deliberately): `author`, `created_utc`, `status`,
`metadata.tags`/`labels`, `triage_score`. S3: "classification happens after";
the CH hop (`raw_ref`) is the pointer through which PKMS can later pull
tags/decay/receipt state (a future CH read API — DP-10 if PKMS wants
`tags_hint` at capture time).

### 3.2 Two-hop `source_span` construction

The span is expressed by two references; the CH pointer is authoritative, the
URL is never the primary key:

```
hop 1 (CH item)   source_type: "content-hoarder_item"
                  source_ref:  "content-hoarder:fullname:<fullname>"
                  quote:       title (or body opening if title empty)
                  location_hint: "<source> item · saved <saved_utc date>"
                  confidence:  1.0        (verbatim from the CH row)
hop 2 (original)  the item's `url` — carried in raw_text / envelope (DP-4);
                  recoverable via the CH hop, never flattened to
```

IDs are deterministic from the fullname so re-promotes are idempotent and
audit-friendly (fixture precedent `span_ch_001` style):

- `span_id = "span_ch_" + sha1(fullname)[:10]`
- `env_id  = "env_ch_" + sha1(fullname)[:10] + "_promote"`
- `receipt_id = "receipt_ch_" + sha1(fullname)[:10] + "_promote"`

---

## 4. `action_receipt` recording

**Where:** per-item `metadata` JSON column — the established extensibility
mechanism (AGENTS.md: per-source fields live in `metadata`; "adding a source
needs no schema change"). No new table in phase 1 (decision D4; a dedicated
`promotions` side table, mirroring the `reddit_unsave` state-machine pattern,
is deferred until the unsave-on-source follow-up needs queryable history).

**Proposed shape** (fixture `sample_receipts.promote` precedent + transport
state the fixture stubs couldn't carry):

```json
"metadata.promotion": {
  "status": "promoted" | "failed",
  "attempted_at": 1754000000,
  "transport": "http_post_capture" | "file_drop",
  "delivery_ref": "capture_..." | "vault/inbox/2026-07-31-<fn>.md",
  "receipt": {
    "id": "receipt_ch_<sha1[:10]>_promote",
    "action_envelope_id": "env_ch_<sha1[:10]>_promote",
    "actor": "user",
    "result": "executed" | "failed",
    "occurred_at": "2026-07-31T12:00:00Z",
    "reason": "User chose promote on the triage feed (ADR 0027).",
    "source_span_ids": ["span_ch_<sha1[:10]>"],
    "reversibility": "reversible",
    "human_summary": "Promoted to PKMS vault/inbox (capture <id>)."
  },
  "error": "..."            // only when status=failed
}
```

**Write path:** direct `UPDATE items SET metadata=?` inside the route's
`conn()` transaction — the `bridge/karakeep.py` precedent. Explicitly NOT
`merge_upsert` (that is the re-import path; gotcha #2 stays untouched).
**Idempotency:** a `status: "promoted"` receipt short-circuits re-promote to a
no-op returning the existing receipt (DP-11 if re-promote should instead be
allowed, producing a receipt list). **Ledger conventions check:** CH has no
general ledger table today; `settings` holds JSON state
(`resurfacing_state`), `reddit_unsave` is a state machine, `tag_suggestions` a
proposal log. The `ledger_event` contract is life-os-side; where its events
are written is DP-6.

---

## 5. Transport — PROVISIONAL recommendation + decision points

**Recommendation (PROVISIONAL): HTTP `POST /capture`** to the PKMS web
service, over file drop. Rationale:

1. **Contract already exists.** PKMS's roadmap pins the `POST /capture`
   contract as stable and token-gated; the envelope is JSON, so the mapping in
   §3 is a direct body, no encoding layer.
2. **Truthful receipts.** A response can carry PKMS's capture id →
   `delivery_ref`; the receipt then says "PKMS accepted", not just "file
   written". File drop has no ack channel — the receipt can only attest to a
   local write.
3. **Retry/duplicate is natural.** Idempotency key = `raw_ref` (CH fullname);
   PKMS dedups, CH retries on timeout with the existing `_http` helper
   (15 s timeout precedent in `bridge/karakeep.py`).
4. **Fewer moving parts on CH.** File drop needs a watched directory + a
   filename/encoding convention + atomic-write discipline + partial-failure
   handling, and pushes the watcher problem onto PKMS.

File drop's real advantages (works with `pkms serve` down; no token
handling; offline-friendly) matter only if the PKMS spec finds POST-hosted
capture unacceptable — that is exactly the S3 open question.

**Decision points awaiting the PKMS ingest spec** (DP-1..DP-6; each blocks a
phase-2 implementation detail):

| DP | Decision | What CH needs to know |
|---|---|---|
| DP-1 | **Transport mechanism** | file drop vs `POST /capture` (S3's declared open question). |
| DP-2 | **Endpoint** | `POST /capture` URL + host: `http://127.0.0.1:8765/...` vs tailnet host; path shape. |
| DP-3 | **Auth** | token mechanism (`Authorization: Bearer` vs `?token=` query); env var name; when PKMS serve runs token-gated, how CH obtains/rotates the token. |
| DP-4 | **Envelope delivery format** | exact field names/values (contracts.md sketch is placeholder); where the original URL travels (raw_text footer vs context field); whether `context` may grow fields. |
| DP-5 | **Retry / duplicate handling** | idempotency key semantics on PKMS (`raw_ref`); PKMS duplicate response; CH retry policy (count, backoff, when to give up and record `failed`). |
| DP-6 | **Ledger** | does PKMS return a receipt/`ledger_event` id for `delivery_ref`; where `ledger_event` records live; whether CH's receipt is the whole record or half of one. |
| (DP-f) | **File-drop shape, only if DP-1 picks it** | directory, filename convention (idempotency key), atomic write, watcher ownership, ack mechanism. |

Config on the CH side mirrors the Karakeep precedent (`config.py` + env):
`PKMS_CAPTURE_URL` + `PKMS_CAPTURE_TOKEN` (HTTP) or `PKMS_INBOX_DIR`
(file drop). Unconfigured → `is_configured()` false → UI hides/disabled,
CLI prints the "not configured" message (Karakeep behavior). Secrets never
logged or printed.

---

## 6. Out of scope (this slice, per ADR 0027)

- **Unsave-on-source** — deferred behind the receipt infra (ADR 0027
  §Decision.3). The receipts designed in §4 are the prerequisite that future
  unsave work reads; nothing un-saves here.
- **Auto-promote-on-save** — Option B rejected; no save-path hook.
- **Bulk promote** — per-item only (triage-gated; same posture as
  archive.today recovery, per-item only).
- **Porting the life-os promotion-card UI** into CH — the fixture is the
  contract reference (and its `validate.py` the offline check), not a CH
  template. CH's ambient card stays cluster-shaped (locked design); the
  promote affordance is minimal (§7).
- **Changing `resurface.py` ranking / the locked ambient-card design.**
- **Any live PKMS write in phase 1** — verification uses fakes/synthetic DB
  (§9); a real transport smoke is user-gated later.

---

## 7. Integration-point map (phase 2 hooks)

Backend:

| File | Hook | Role |
|---|---|---|
| `src/content_hoarder/bridge/pkms.py` **(new)** | `build_capture(item)`, `is_configured()`, `deliver(envelope)` (transport-agnostic: `post_capture` vs `deliver_file`), `record_receipt(conn, fullname, receipt, transport, delivery_ref)` | The whole promote pipeline, mirroring `bridge/karakeep.py` structure so the two outbound bridges stay parallel. |
| `src/content_hoarder/web.py` | **new** `POST /items/<path:fullname>/promote` | Explicit accept: `conn()` → load item → `build_capture` → `deliver` → `record_receipt` → return receipt JSON. Follows the `/items/<fn>/snooze` route pattern. |
| `src/content_hoarder/web.py` | `GET /resurface` (line ~1384) | Unchanged payload for now (D1: promote is item-level). Optionally add `"promote_configured": bool` so the UI can hide the affordance — phase-2 detail. |
| `src/content_hoarder/resurface.py` | `candidate()` | Unchanged in phase 2 start; its `sample[].fullname` already anchors any card-level promote variant (D1 alternative). |
| `src/content_hoarder/db.py` | `_row_to_public()` | Item shape consumed by `build_capture`; no schema change. |
| `src/content_hoarder/config.py` | `PKMS_CAPTURE_URL` / `PKMS_CAPTURE_TOKEN` / `PKMS_INBOX_DIR` | Env wiring, Karakeep precedent. |
| `src/content_hoarder/_http.py` | stdlib `request()` | POST transport (15 s timeout precedent). |
| `src/content_hoarder/cli.py` | `cmd_promote` | **Naming collision:** `promote` already = Karakeep push. PKMS path gets `promote-pkms` or a `--target pkms` flag — DP-12. Phase-2 minimal is web-only; CLI optional. |

Frontend:

| File | Hook | Role |
|---|---|---|
| `src/content_hoarder/static/browse/main.js` | `act(fn, act)` dispatcher | Add `"promote"` → `api.postJSON("/items/<fn>/promote")` → toast/snackbar with `receipt.human_summary` → re-render (status/menu state). |
| `src/content_hoarder/static/browse/main.js` / `render.js` | row long-press + right-click menu (Share precedent) | **D1 (recommended):** Promote joins the menu, next to Share. Desktop inline cluster stays F/A/D + IN (locked rule); mobile hides `.acts` → long-press. |
| `src/content_hoarder/static/browse/reader.js` | reader header action row (optional) | D1 variant if the reader should carry Promote too. |

Tests (phase 2): `tests/test_pkms_bridge.py` (offline: envelope-mapping golden
test per §3, receipt recording, transport fakes for both HTTP and file-drop
shapes), web-route test with `deliver` monkeypatched, `validate.py`-style
shape checks against the fixture contracts.

---

## 8. Decision registry

**Awaiting the PKMS ingest spec:** DP-1 transport, DP-2 endpoint, DP-3 auth,
DP-4 envelope format, DP-5 retry/duplicate, DP-6 ledger (+ DP-f file-drop
shape if chosen).

**CH-internal, phase 2:** D1 promote affordance placement (recommended: item
row menu, not the ambient cluster card); DP-7 capture id assignment; DP-8
`source_account_id` value; DP-9 `context.device` detection; DP-10 tags_hint
extension; DP-11 re-promote semantics (recommended: no-op + existing receipt);
DP-12 CLI naming.

**Pre-decided here (design, not open):** D2 receipt shape
(`metadata.promotion` single slot, §4); D3 no new attention-budget state in CH
(§1.1); D4 no `promotions` table in phase 1 (§4).

---

## 9. Verification plan (phase 2; nothing here runs in phase 1)

- Envelope mapping golden tests (row → capture JSON, byte-exact fields per §3).
- Receipt recording tests (success + transport-failure paths; idempotent
  re-promote).
- Web route test with a fake deliver: happy path, `not configured` 4xx/disabled
  path, transport failure → `metadata.promotion.status = failed`.
- Synthetic end-to-end (tests fixture DB): promote → fake transport captures
  envelope → receipt asserted on the row.
- Real transport smoke: user-gated (matches archive.today posture; PKMS spec
  must land first).
