"""Local Firefox open-tab snapshot ingest.

This module owns the service-layer DB writes for user-triggered Firefox tab snapshots.
The connector remains DB-free and only shapes normalized tab records into items.
"""

from __future__ import annotations

import hashlib
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

from content_hoarder import db
from content_hoarder.connectors.firefox import FIREFOX_TABS_SCHEMA, item_from_tab_record

TOKEN_HASH_SETTING = "firefox_ingest_token_sha256"


@dataclass
class FirefoxTabsIngestResult:
    imported: int = 0
    skipped: int = 0
    errors: list[str] = field(default_factory=list)
    youtube_promoted: int = 0
    sample: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "imported": self.imported,
            "skipped": self.skipped,
            "errors": self.errors,
            "youtube_promoted": self.youtube_promoted,
            "sample": self.sample,
        }


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def generate_token() -> str:
    return secrets.token_urlsafe(32)


def store_token_hash(conn, token: str) -> None:
    db.set_setting(conn, TOKEN_HASH_SETTING, hash_token(token))


def token_configured(conn) -> bool:
    return bool(db.get_setting(conn, TOKEN_HASH_SETTING, ""))


def verify_token(conn, token: str) -> bool:
    expected = db.get_setting(conn, TOKEN_HASH_SETTING, "") or ""
    if not expected or not token:
        return False
    return secrets.compare_digest(hash_token(token), expected)


def validate_payload(payload: object) -> tuple[dict[str, Any] | None, str | None]:
    if not isinstance(payload, dict):
        return None, "expected JSON object"
    if payload.get("schema") != FIREFOX_TABS_SCHEMA:
        return None, f"schema must be {FIREFOX_TABS_SCHEMA}"
    tabs = payload.get("tabs")
    if not isinstance(tabs, list):
        return None, "tabs must be a list"
    return payload, None


def _normalize_record(
    tab: dict[str, Any], payload: dict[str, Any], default_captured_at: int
) -> dict[str, Any]:
    record = dict(tab)
    source = payload.get("source") or "webextension"
    captured_at = payload.get("captured_at")
    snapshot_id = payload.get("snapshot_id")

    record["capture_source"] = record.get("capture_source") or source
    record["captured_at"] = (
        record.get("captured_at") or captured_at or default_captured_at
    )
    if snapshot_id and not record.get("snapshot_id"):
        record["snapshot_id"] = snapshot_id

    if "favicon" not in record and "favIconUrl" in record:
        record["favicon"] = record.get("favIconUrl")
    if "window" not in record and "windowId" in record:
        record["window"] = record.get("windowId")
    if "last_accessed_ms" not in record and "lastAccessed" in record:
        record["last_accessed_ms"] = record.get("lastAccessed")
    if "cookie_store_id" not in record and "cookieStoreId" in record:
        record["cookie_store_id"] = record.get("cookieStoreId")
    if "group_id" not in record and "groupId" in record:
        record["group_id"] = record.get("groupId")
    return record


def ingest_snapshot(
    conn, payload: dict[str, Any], *, now: int | None = None
) -> FirefoxTabsIngestResult:
    """Merge a validated Firefox tab snapshot into the items table."""
    result = FirefoxTabsIngestResult()
    default_captured_at = int(now if now is not None else time.time())
    tabs = payload.get("tabs") or []

    for tab in tabs:
        if not isinstance(tab, dict):
            result.skipped += 1
            continue
        record = _normalize_record(tab, payload, default_captured_at)
        item = item_from_tab_record(record)
        if item is None:
            result.skipped += 1
            continue
        try:
            db.merge_upsert(conn, item)
            result.imported += 1
            if item.get("source") == "youtube":
                result.youtube_promoted += 1
            if len(result.sample) < 5:
                result.sample.append(item.get("fullname", ""))
        except Exception as exc:
            result.skipped += 1
            result.errors.append(f"{item.get('fullname', '?')}: {exc}")
    conn.commit()
    return result
