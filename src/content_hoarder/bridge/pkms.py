"""PKMS bridge (opt-in) — promote a saved item into PKMS `vault/inbox/`.

No-op unless ``PKMS_CAPTURE_URL`` and ``PKMS_CAPTURE_TOKEN`` are configured
(config/env contract only — the token value may be sourced at runtime from
``K:\\Projects\\PKMS\\.secrets\\capture-token`` via env; this module never reads
the secret file and never prints the token).

Envelope per the finalized PKMS Slice 9 contract (see docs/specs/15-promote-action.md):
``POST /capture?source=content-hoarder`` with a JSON body of ``text`` +
``source_account_id`` + ``raw_ref`` + ``context`` + ``ch_item_id`` +
``ch_origin_ref`` + ``ch_captured_at``. The idempotency/dedupe key is
``ch_item_id`` (NOT ``raw_ref``) — PKMS checks it against
``.index/ch-promote-ledger.txt`` and answers ``already saved ✓ <name>`` on
replay. The deterministic response body IS the receipt's external evidence;
it is stored verbatim in ``metadata.promotion.response``.

Mirrors ``bridge/karakeep.py``: opt-in env config, direct ``UPDATE items SET
metadata`` (never ``merge_upsert``), stdlib ``_http`` transport. Per-item only
(ADR 0027 triage-gated); no bulk path.
"""

from __future__ import annotations

import hashlib
import json
import time
from datetime import datetime, timezone

from content_hoarder import _http, config
from content_hoarder.models import parse_metadata

# PKMS-side replay marker in capture response bodies; the name after the
# checkmark is the vault/inbox filename, used as delivery_ref.
_ALREADY_SAVED_PREFIX = "already saved \u2713 "


def _id_slug(fullname: str) -> str:
    """Deterministic short slug from a fullname — stable across re-promotes so
    envelope/receipt ids stay idempotent (spec 15 §3.2)."""
    return hashlib.sha1(fullname.encode("utf-8")).hexdigest()[:10]


def _iso(ts: int) -> str:
    """Epoch seconds -> ISO-8601 UTC with ``Z`` suffix (the capture contract's
    timestamp shape)."""
    return datetime.fromtimestamp(int(ts), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _summary(item: dict[str, object]) -> str:
    """The ``text`` envelope's middle line: the item's saved text. Prefers
    metadata summary-ish keys (connectors put selftext/description there),
    falls back to the ``body`` column, then empty — never truncated (the
    contract demands raw markdown, zero pre-shaping)."""
    md = parse_metadata(item.get("metadata"))
    for key in ("summary", "description", "selftext", "text"):
        val = md.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    body = item.get("body")
    return body.strip() if isinstance(body, str) else ""


def build_capture(
    item: dict[str, object], *, device: str = "desktop"
) -> dict[str, object]:
    """Item (``db._row_to_public`` shape) -> the Slice 9 capture envelope.

    Field names verbatim per the finalized contract; ``ch_origin_ref`` is the
    live CH pointer (hop 2: tags/decay/receipt resolve through it, never
    flattened), ``raw_ref`` the original URL (hop 3).
    """
    fullname = str(item.get("fullname") or "")
    title = (item.get("title") or "").strip()
    url = (item.get("url") or "").strip()
    summary = _summary(item)
    text = "\n\n".join(part for part in (title, summary, url) if part)
    captured_ts = int(
        item.get("first_seen_utc") or item.get("saved_utc") or time.time()
    )
    return {
        "text": text,
        "source_account_id": f"acct_content_hoarder_{item.get('source') or 'unknown'}",
        "raw_ref": url or f"content-hoarder:fullname:{fullname}",
        "context": {"device": device, "app": "content-hoarder"},
        "ch_item_id": f"ext_ch_{_id_slug(fullname)}",
        "ch_origin_ref": f"content-hoarder:fullname:{fullname}",
        "ch_captured_at": _iso(captured_ts),
    }


def is_configured() -> bool:
    return bool(config.get("PKMS_CAPTURE_URL") and config.get("PKMS_CAPTURE_TOKEN"))


def deliver(envelope: dict[str, object]) -> str:
    """POST the envelope to ``/capture?source=content-hoarder`` and return the
    response body text (``saved ✓ <name>`` / ``already saved ✓ <name>``).

    Raises :class:`content_hoarder._http.HttpError` on any non-2xx status or
    transport failure — the caller records a ``failed`` receipt. No automatic
    retry loop: a re-promote is the retry, and PKMS's ``ch_item_id`` dedupe
    makes it safe (DP-5 resolution).
    """
    base = config.get("PKMS_CAPTURE_URL").rstrip("/")
    url = f"{base}/capture?source=content-hoarder"
    _status, _headers, raw = _http.request(
        url,
        method="POST",
        data=json.dumps(envelope, ensure_ascii=False).encode("utf-8"),
        headers={
            "X-Capture-Token": config.get("PKMS_CAPTURE_TOKEN"),
            "Content-Type": "application/json",
            "User-Agent": config.get("USER_AGENT"),
        },
        timeout=15,
    )
    return raw.decode("utf-8", errors="replace").strip()


def _note_name(response: str) -> str:
    """Extract the vault/inbox filename from a capture response body. Empty when
    the body is missing or lacks the ✓ marker (delivery_ref then stays '' —
    a non-confirmation 2xx body must never be recorded as a vault path)."""
    if not response:
        return ""
    if "\u2713" in response:
        return response.split("\u2713", 1)[-1].strip()
    return ""


def record_receipt(
    conn,
    fullname: str,
    *,
    status: str,
    attempted_at: int,
    response: str | None = None,
    error: str | None = None,
) -> dict[str, object]:
    """Stamp ``metadata.promotion`` on the item (direct UPDATE, karakeep
    precedent — never ``merge_upsert``) and return the receipt dict.

    Shape per spec 15 §4 / D2: ``{status, attempted_at, transport, response,
    delivery_ref, receipt{...}}`` plus ``error`` on failure. The receipt follows
    the life-os fixture's ``sample_receipts.promote`` shape with deterministic
    ids derived from the fullname.
    """
    slug = _id_slug(fullname)
    promoted = status == "promoted"
    delivery_ref = _note_name(response) if response else ""
    receipt = {
        "id": f"receipt_ch_{slug}_promote",
        "action_envelope_id": f"env_ch_{slug}_promote",
        "actor": "user",
        "result": "executed" if promoted else "failed",
        "occurred_at": _iso(attempted_at),
        "reason": "User chose promote on the triage feed (ADR 0027).",
        "source_span_ids": [f"span_ch_{slug}"],
        "reversibility": "reversible",
        "human_summary": (
            f"Promoted to PKMS vault/inbox ({delivery_ref})."
            if promoted and delivery_ref
            else "Promoted to PKMS vault/inbox."
            if promoted
            else "Promote failed; no PKMS write."
        ),
    }
    promotion: dict[str, object] = {
        "status": status,
        "attempted_at": attempted_at,
        "transport": "http_post_capture",
        "receipt": receipt,
    }
    if response is not None:
        promotion["response"] = response
        promotion["delivery_ref"] = delivery_ref
    if error is not None:
        promotion["error"] = error

    row = conn.execute(
        "SELECT metadata FROM items WHERE fullname=?", (fullname,)
    ).fetchone()
    md = parse_metadata(row["metadata"] if row else None)
    md["promotion"] = promotion
    conn.execute(
        "UPDATE items SET metadata=? WHERE fullname=?",
        (json.dumps(md, ensure_ascii=False), fullname),
    )
    return receipt


def promote(
    conn, item: dict[str, object], *, device: str = "desktop"
) -> dict[str, object]:
    """Promote one item: build envelope, deliver, record receipt.

    Returns ``{"status": "promoted"|"replay"|"failed", "promoted": bool,
    "response": str, "receipt": dict}`` (+ ``error`` on failure).

    - Already promoted (``metadata.promotion.status == "promoted"``) -> local
      replay no-op, no second POST, existing receipt returned.
    - First write -> ``promoted``; PKMS replay answer (``already saved ✓``) ->
      ``replay`` with the deterministic body. Both are stamped once — no
      double-stamping of receipt state.
    - Transport/HTTP failure -> ``failed`` receipt recorded, error surfaced.
    """
    fullname = str(item.get("fullname") or "")
    md = parse_metadata(item.get("metadata"))
    existing = md.get("promotion") or {}
    if existing.get("status") == "promoted":
        return {
            "status": "replay",
            "promoted": True,
            "response": existing.get("response", ""),
            "receipt": existing.get("receipt", {}),
        }

    attempted = int(time.time())
    try:
        response = deliver(build_capture(item, device=device))
    except _http.HttpError as exc:
        receipt = record_receipt(
            conn, fullname, status="failed", attempted_at=attempted, error=str(exc)
        )
        return {"status": "failed", "promoted": False, "response": "",
                "receipt": receipt, "error": str(exc)}

    receipt = record_receipt(
        conn, fullname, status="promoted", attempted_at=attempted, response=response
    )
    replay = response.startswith(_ALREADY_SAVED_PREFIX)
    return {
        "status": "replay" if replay else "promoted",
        "promoted": True,
        "response": response,
        "receipt": receipt,
    }
