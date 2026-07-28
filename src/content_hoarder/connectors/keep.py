"""Google Keep connector — imports notes from a Google Takeout ``Keep/`` export.

Supports both the legacy Takeout format (``createdTimestampMs`` in
milliseconds) and the modern format (``timestamps.createTime`` in
microsecond-epoch). When the legacy field is missing, the connector
falls back to the modern one so a single import works against any
export shape.

Live sync (gkeepapi) is intentionally not implemented here. The PKMS
project is the canonical live-sync surface for Google Keep — it owns
the master-token blast radius and produces the durable vault capture
that the rest of the system reads. CH's role for Keep is the bulk
Takeout import path; the dispatch is automatic when ``can_import()``
detects Keep-shaped JSON. See life-os ADR 0028.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from content_hoarder.connectors.base import BaseConnector
from content_hoarder.models import new_item


class KeepConnector(BaseConnector):
    id = "keep"
    label = "Google Keep"
    badge_color = "#fbbc04"

    def _looks_keep(self, p: Path) -> bool:
        try:
            data = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
        except (json.JSONDecodeError, OSError):
            return False
        return isinstance(data, dict) and any(
            k in data for k in ("textContent", "listContent", "isTrashed")
        )

    def _can_import_dir(self, p: Path) -> bool:
        try:
            files = sorted(p.rglob("*.json"))
        except OSError:
            return False
        count = 0
        for f in files:
            if count >= 50:
                break
            count += 1
            if self._looks_keep(f):
                return True
        return False

    def can_import(self, path: Path) -> bool:
        if path.is_dir():
            return self._can_import_dir(path)
        if path.suffix.lower() == ".json":
            return self._looks_keep(path)
        return False

    @staticmethod
    def _epoch_to_utc(value: Any) -> int:
        """Detect a millisecond- or microsecond-epoch int, or an ISO-8601
        string, and normalise to Unix seconds. Returns 0 for missing/empty/
        non-numeric/unparseable input."""
        try:
            n = int(value)
        except (TypeError, ValueError):
            # Not an int — try ISO-8601 string parsing (e.g. "2024-01-15T10:30:00Z").
            if isinstance(value, str):
                try:
                    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=timezone.utc)
                    return int(dt.timestamp())
                except (ValueError, TypeError, OSError):
                    return 0
            return 0
        if not n:
            return 0
        # Microsecond-epoch years are post-2001; ms-epoch years start ~1970.
        # A 1e15 magnitude is unambiguously microseconds; below 1e12 is
        # ambiguous so we treat it as milliseconds (the legacy default).
        if n >= 10**15:
            return n // 1_000_000
        return n // 1000

    def _created_utc(self, note: dict) -> int:
        # Prefer the legacy field; fall back to the modern microsecond-epoch.
        legacy = note.get("createdTimestampMs")
        if legacy is not None:
            v = self._epoch_to_utc(legacy)
            if v:
                return v
        ts = note.get("timestamps") or {}
        return self._epoch_to_utc(ts.get("createTime"))

    def _edited_utc(self, note: dict) -> int:
        legacy = note.get("userEditedTimestampMs")
        if legacy is not None:
            v = self._epoch_to_utc(legacy)
            if v:
                return v
        ts = note.get("timestamps") or {}
        return self._epoch_to_utc(ts.get("updateTime"))

    def _stable_source_id(self, note: dict, file_path: Path) -> str:
        # createdTimestampMs is unique per note and stable across re-imports;
        # prefer it over the filename stem (two notes titled the same in
        # different account/label folders would otherwise collapse to one
        # fullname). Fall back to timestamps.createTime for modern exports.
        legacy = note.get("createdTimestampMs")
        if legacy is not None:
            return str(legacy)
        ts = note.get("timestamps") or {}
        ct = ts.get("createTime")
        if ct is not None:
            return str(ct)
        return file_path.stem

    def import_file(self, path: Path) -> Iterable[dict[str, Any]]:
        account = path.name if path.is_dir() else path.parent.name
        files = sorted(path.rglob("*.json")) if path.is_dir() else [path]

        for file_path in files:
            try:
                note = json.loads(file_path.read_text(encoding="utf-8", errors="ignore"))
            except (json.JSONDecodeError, OSError):
                continue
            if not isinstance(note, dict):
                continue
            if not any(k in note for k in ("title", "textContent", "listContent")):
                continue

            title = note.get("title", "") or ""
            text_content = note.get("textContent", "") or ""
            list_content = note.get("listContent") or []

            lines = []
            for entry in list_content:
                if isinstance(entry, dict) and "text" in entry:
                    checked = entry["isChecked"] if "isChecked" in entry else entry.get("checked")
                    mark = "[x]" if checked else "[ ]"
                    lines.append(f"{mark} {entry.get('text', '')}")
            checklist = "\n".join(lines)
            body = text_content
            if checklist:
                body = (text_content + "\n\n" + checklist) if text_content else checklist

            created_utc = self._created_utc(note)
            edited_utc = self._edited_utc(note)
            url = re.search(r"https?://\S+", text_content)
            url = url.group(0) if url else ""

            labels = [
                l.get("name")
                for l in note.get("labels", [])
                if isinstance(l, dict) and l.get("name")
            ]

            yield new_item(
                source="keep",
                source_id=self._stable_source_id(note, file_path),
                kind="note",
                title=title,
                body=body,
                url=url,
                created_utc=created_utc,
                saved_utc=edited_utc,
                metadata={
                    "labels": labels,
                    "color": note.get("color"),
                    "isArchived": bool(note.get("isArchived")),
                    "isTrashed": bool(note.get("isTrashed")),
                    "isPinned": bool(note.get("isPinned")),
                    "list_items": list_content,
                    "account": account,
                },
            )

    def sync(self):
        """Live pull via gkeepapi is intentionally not implemented in CH.

        The PKMS project (``K:\\Projects\\PKMS``) is the canonical
        live-sync surface for Google Keep. It owns the master-token blast
        radius (per life-os ADR 0028 + ADR 0005) and produces the
        durable vault capture. CH's role here is the Takeout path:
        bulk import the extracted Takeout JSON for triage via
        ``ch import <extracted-dir>``. The connector auto-dispatches
        when it sees ``createdTimestampMs`` / ``textContent`` keys
        (see test_keep_dispatch.py).

        If you need live sync inside CH later, the wiring point is here:
        mirror PKMS's ``ingest_keep()`` into an ``import gkeepapi``
        branch and yield each ``note`` via ``new_item(source='keep',
        source_id=note.id, ...)``. The master token lives in the
        standard ``.secrets/keep-master-token`` envelope.
        """
        raise NotImplementedError(
            "Keep live sync lives in PKMS (pkms ingest keep / "
            "pkms ingest keep-takeout). CH supports Keep via Takeout "
            "import only - see life-os ADR 0028."
        )
