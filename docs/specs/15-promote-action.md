# Spec 15 — PKMS promote action (resurface-card integration)

**Status: SHIPPED — merged to `main` (2026-08-08); review-fixed; CI green.
Transport CHOSEN; implementation history below (`feat/promote-action` commits).**

Governing decision: life-os ADR 0027 (Accepted 2026-07-28, Option C hybrid).
The PKMS-side ingest spec LANDED (Slice 9 of
`K:\Projects\khaos\PKMS\vault\projects\pkms-design\build-plan.md`, branch
`feat/promotion-ingest-spec`): transport = **extended `POST /capture`** (file
drop rejected). §5 now records the finalized contract and the DP-1..6
resolutions; the phase-1 PROVISIONAL text is replaced, not kept alongside.

Contract references (cite, don't copy): `K:\Projects\khaos\life-os\docs\contracts.md`
(`capture`, `external_item`, `resurface_card`, `source_span`, `action_receipt`,
`attention_budget`, `ledger_event`); click-tested fixture
`K:\Projects\khaos\life-os\fixtures\content-hoarder\` (issue CH#72, closed 2026-07-20):
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

**[CONFIRMED phase 2]** PKMS `POST /capture` exists and was read directly
(`capture_service.py do_POST`): token-gated, JSON/form/raw bodies, 200
`saved ✓ <name>` / 403 `bad token` / 400 `empty capture`. The Slice 9 extended
fields and the `already saved ✓` replay body land in PKMS's own build packet;
CH sends them now (additive, ignored by the current build).

---

## 3. Item → `capture` envelope mapping + two-hop `source_span`

### 3.1 Field mapping (CH item → capture envelope) — CHOSEN

Finalized Slice 9 envelope, field names verbatim (implemented in
`bridge/pkms.py build_capture()`):

```json
{
  "text": "<title>\n\n<summary>\n\n<url>",
  "source_account_id": "acct_content_hoarder_<source>",
  "raw_ref": "<original url>",
  "context": {"device": "desktop"|"phone", "app": "content-hoarder"},
  "ch_item_id": "ext_ch_<sha1(fullname)[:10]>",
  "ch_origin_ref": "content-hoarder:fullname:<fullname>",
  "ch_captured_at": "<first_seen_utc ISO-8601>"
}
```

| field | CH source (column / metadata key) | Notes |
|---|---|---|
| `text` | `title` + `"\n\n"` + `summary` + `"\n\n"` + `url`, joined over non-empty parts | Raw markdown, no headings, zero pre-shaping. `summary` = first non-empty of `metadata.{summary,description,selftext,text}`, else the `body` column, else empty. |
| `source_account_id` | derived `acct_content_hoarder_<source>` | DP-8 resolved: deterministic CH pseudo-account per source (CH has no account registry; `acct_` prefix matches the fixture convention). |
| `raw_ref` | the item's original `url`; fallback `content-hoarder:fullname:<fullname>` when there is no URL | Hop 3 (original URL). NEVER flattened to a CH pointer when a URL exists. |
| `context.device` | `"desktop"` default; `"phone"` when the UA carries Mobile/Android/iPhone/iPad | DP-9 resolved: cheapest truthful signal, sniffed in the route. |
| `context.app` | constant `"content-hoarder"` | — |
| `ch_item_id` | `ext_ch_<sha1(fullname)[:10]>` | **The idempotency/dedupe key** (DP-5 resolved: NOT `raw_ref` — phase-1 wording corrected). Deterministic from the fullname. |
| `ch_origin_ref` | `content-hoarder:fullname:<fullname>` | Hop 2, the live CH pointer — tags/decay/receipt state resolve through it, never flattened. |
| `ch_captured_at` | `first_seen_utc` (fallback `saved_utc`, then now), ISO-8601 UTC `Z` | CH's capture time, NOT promotion time. |

`source` travels as the query param `?source=content-hoarder` (PKMS's existing
source channel), not a body field. Not in the envelope (deliberately):
`author`, `created_utc`, `status`, `metadata.tags`/`labels`, `triage_score`
(classification happens after; the CH hop is the pull-through pointer).

### 3.2 Provenance — the two-hop `source_span`, expressed in the envelope

The finalized contract carries three references (Slice 9 wording: "two-hop
source_span… + raw_ref"):

```
hop 2 (live CH pointer)  ch_origin_ref = "content-hoarder:fullname:<fullname>"
                         ch_item_id    = "ext_ch_<sha1[:10]>"  (dedupe key)
hop 3 (original)         raw_ref       = the item's original url
```

Never flatten to the original URL only — the CH hop (`ch_origin_ref`) carries
tags/decay/receipt state that PKMS can pull through it. Receipt/source-span ids
stay deterministic from the fullname (audit-friendly, idempotent):

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

**Shipped shape** (implemented in `bridge/pkms.py record_receipt()`; fixture
`sample_receipts.promote` precedent + the transport state the fixture stubs
couldn't carry):

```json
"metadata.promotion": {
  "status": "promoted" | "failed",
  "attempted_at": 1754000000,
  "transport": "http_post_capture",
  "delivery_ref": "inbox/2026-07-31-<fn>.md",     // note name parsed from the response
  "response": "saved ✓ <name> | already saved ✓ <name>",  // deterministic external evidence, verbatim
  "receipt": {
    "id": "receipt_ch_<sha1[:10]>_promote",
    "action_envelope_id": "env_ch_<sha1[:10]>_promote",
    "actor": "user",
    "result": "executed" | "failed",
    "occurred_at": "2026-07-31T12:00:00Z",
    "reason": "User chose promote on the triage feed (ADR 0027).",
    "source_span_ids": ["span_ch_<sha1[:10]>"],
    "reversibility": "reversible",
    "human_summary": "Promoted to PKMS vault/inbox (<name>)."
  },
  "error": "..."            // only when status=failed
}
```

**Write path:** direct `UPDATE items SET metadata=?` inside the route's
`conn()` transaction — the `bridge/karakeep.py` precedent. Explicitly NOT
`merge_upsert` (that is the re-import path; gotcha #2 stays untouched).
**Idempotency / dedupe semantics (DP-5 + DP-11 resolved):**

- Item already `promoted` → re-promote short-circuits at the CH level: no
  second POST, the existing receipt is returned (`status: "replay"`). One
  stamp, never two.
- First POST answered `already saved ✓ <name>` (PKMS-side dedupe on
  `ch_item_id` against `.index/ch-promote-ledger.txt`) → `status: "replay"`,
  receipt stamped once with the deterministic body as evidence.
- Transport/HTTP failure → `status: "failed"` receipt recorded (with
  `error`); the route surfaces it as a 502. No automatic retry loop — a
  re-promote IS the retry, and PKMS dedupe makes it safe.

**Ledger conventions check:** CH has no general ledger table; `settings` holds
JSON state (`resurfacing_state`), `reddit_unsave` is a state machine,
`tag_suggestions` a proposal log. DP-6 resolved: PKMS returns no separate
receipt/`ledger_event` id — **the response body is the evidence**, stored
verbatim in `metadata.promotion.response`; `ledger_event` bookkeeping stays
life-os/PKMS-side.

---

## 5. Transport — CHOSEN (extended `POST /capture`)

**Decision (PKMS Slice 9, finalized): extended `POST /capture`; file drop
rejected.** `text` stays the only required field; `source` stays a query
param (`?source=content-hoarder`); the new fields are additive optionals the
current PKMS build ignores until its own packet lands. The capture path gains
zero decisions — the card's explicit promote accept is the only gate.

**Wiring contract (confirmed by reading `K:\Projects\khaos\PKMS\src\pkms\capture_service.py`):**

- Endpoint: `POST http://127.0.0.1:8765/capture?source=content-hoarder`
  (`PKMS_CAPTURE_URL` + `/capture?source=content-hoarder`).
- Auth: `X-Capture-Token` header (or `?token=` query — PKMS accepts both;
  CH sends the header). Token via `PKMS_CAPTURE_TOKEN` env; the value may come
  from `K:\Projects\khaos\PKMS\.secrets\capture-token` at runtime via env. Never
  hardcoded, never logged/printed. `is_configured()` = both env vars set
  (mirrors the Karakeep precedent).
- Request: `Content-Type: application/json`; body = the §3.1 envelope.
- Responses (deterministic — the body IS the receipt's external evidence):
  - 200 `saved ✓ <name>` — first write.
  - 200 `already saved ✓ <name>` — `ch_item_id` replay against
    `.index/ch-promote-ledger.txt`; no second file.
  - 403 `bad token`, 400 `empty capture`, 5xx — failure.
- Unconfigured → route answers 400 with a clear error naming
  `PKMS_CAPTURE_URL`/`PKMS_CAPTURE_TOKEN`; transport failure → 502 with the
  recorded `failed` receipt.

**DP resolutions (phase-1 decision points, now closed):**

| DP | Resolution |
|---|---|
| DP-1 | **Transport: extended `POST /capture`** (file drop rejected). |
| DP-2 | **Endpoint:** `POST {PKMS_CAPTURE_URL}/capture?source=content-hoarder`; PKMS serves at `http://127.0.0.1:8765` (token-gated). |
| DP-3 | **Auth:** `X-Capture-Token` header (PKMS accepts header or `?token=`); env `PKMS_CAPTURE_TOKEN`, sourced from `.secrets/capture-token` via env at runtime; never printed. |
| DP-4 | **Envelope format:** the §3.1 JSON, field names verbatim; URL travels in `text` (footer line) and as `raw_ref`; `ch_*` fields carry provenance. |
| DP-5 | **Idempotency key = `ch_item_id`** (NOT `raw_ref` — phase-1 wording corrected). Replay → 200 `already saved ✓`; CH: no auto-retry loop, re-promote is the retry, CH-level short-circuit when already promoted. |
| DP-6 | **No separate receipt id** — the response body is the evidence, stored verbatim (`metadata.promotion.response`); `ledger_event` stays life-os/PKMS-side. |
| DP-f | n/a — file drop rejected. |

Config (shipped in `config.py`): `PKMS_CAPTURE_URL`, `PKMS_CAPTURE_TOKEN`
(both default `""` = opt-in). `PKMS_INBOX_DIR` was NOT added — file drop is
rejected.

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

## 7. Integration-point map — SHIPPED (phase 2)

Backend (all shipped on `feat/promote-action`):

| File | Hook | Role |
|---|---|---|
| `src/content_hoarder/bridge/pkms.py` **(new)** | `build_capture(item, device=)`, `is_configured()`, `deliver(envelope)`, `record_receipt(conn, fullname, …)`, `promote(conn, item, device=)` | The whole promote pipeline, mirroring `bridge/karakeep.py`; stdlib `_http.request` POST (15 s timeout), `X-Capture-Token` header, direct metadata UPDATE. |
| `src/content_hoarder/web.py` | **new** `POST /items/<path:fullname>/promote` (+ `_mobile_ua` helper) | Explicit accept: 404 unknown item → 400 unconfigured (clear error) → `promote()` → 200 with `{status, response, receipt}` (response = the deterministic PKMS body) → 502 on transport failure. UA-sniffs `context.device`. |
| `src/content_hoarder/config.py` | `PKMS_CAPTURE_URL` / `PKMS_CAPTURE_TOKEN` (default `""`) | Env wiring, Karakeep precedent. `PKMS_INBOX_DIR` deliberately NOT added (file drop rejected). |
| `src/content_hoarder/_http.py` | `request()` (unchanged) | POST transport. |
| `src/content_hoarder/resurface.py`, `db.py` | unchanged | No schema change, no ranking change (constraints D3/D4). |
| `src/content_hoarder/cli.py` | not touched | DP-12 deferred: web-only in this slice; `promote` CLI still = Karakeep push. |

Frontend (all shipped; the row menu is the relay-strip template, NOT
`render.js` — the brief's file pointer corrected to code reality):

| File | Hook | Role |
|---|---|---|
| `templates/index.html` | `#relay-strip-tpl` gains a Promote button (`data-relay="promote"`, arrow-up glyph) | D1: joins the row long-press / right-click menu, next to Share. Desktop inline cluster stays F/A/D + IN (locked rule). |
| `src/content_hoarder/static/browse/main.js` | `openRowMenu()` hides Promote once `metadata.promotion.status === "promoted"`; relay click listener routes `promote` → `promoteItem(fn)` | `promoteItem` POSTs, stores the receipt back onto `it.metadata.promotion`, snackbars the PKMS response body; errors toast `data.error`. No re-render needed (item stays in feed). |
| `src/content_hoarder/static/browse/reader.js` | not touched | Reader-header Promote (D1 variant) left out to keep the slice minimal. |

Tests (shipped): `tests/test_pkms_bridge.py` — 13 tests: envelope golden
(field names verbatim, text composition, `ch_origin_ref`, no-URL fallback),
summary-preference, device override, transport (URL/token/header/body),
happy-path receipt, CH-level replay (no double POST), PKMS-side `already
saved` replay, transport-failure `failed` receipt, route happy path /
unconfigured 400 / not-found 404 / UA→device / failure 502.

---

## 8. Decision registry — status

**PKMS-spec decisions (DP-1..6, DP-f):** all resolved — see the §5 DP table
(transport CHOSEN: extended `POST /capture`; idempotency key `ch_item_id`;
response body = evidence).

**CH-internal:** D1 resolved (row menu, not the ambient card); DP-7 resolved
(`ch_item_id` = `ext_ch_<sha1[:10]>`, deterministic); DP-8 resolved
(`acct_content_hoarder_<source>`); DP-9 resolved (UA sniff); DP-10 deferred
(tags_hint — classification happens after per S3); DP-11 resolved (re-promote
= no-op returning the existing receipt); DP-12 deferred (`promote` CLI still
Karakeep; PKMS path is web-only for now).

**Pre-decided (design, held):** D2 receipt shape (`metadata.promotion` single
slot, §4); D3 no new attention-budget state in CH (§1.1); D4 no `promotions`
table (§4) — the receipt is per-item metadata; a queryable table stays
available for the unsave-on-source follow-up.

---

## 9. Verification — EXECUTED (phase 2)

- Envelope mapping golden test (byte-exact fields per §3.1).
- Receipt recording tests (happy, transport-failure, both replay shapes).
- Route oracle tests: happy 200, unconfigured 400, not-found 404, UA→device,
  transport failure 502 with `failed` receipt persisted.
- No live PKMS calls anywhere — `deliver`/`_http.request` mocked in every test.
- Full non-UI suite: **1075 passed, 75 deselected** (baseline 1062 + 13 new).
- Real transport smoke: user-gated — run only after the PKMS Slice 9 build
  lands (its endpoint does not yet persist the new fields).
