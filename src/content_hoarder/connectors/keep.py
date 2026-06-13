"""Google Keep connector — imports notes from a Google Takeout ``Keep/`` export."""

from __future__ import annotations

import json
import re
from pathlib import Path

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

    def import_file(self, path: Path):
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
                    mark = "[x]" if entry.get("isChecked") else "[ ]"
                    lines.append(f"{mark} {entry.get('text', '')}")
            checklist = "\n".join(lines)
            body = text_content
            if checklist:
                body = (text_content + "\n\n" + checklist) if text_content else checklist

            try:
                created_utc = int(note.get("createdTimestampMs", 0)) // 1000
            except (ValueError, TypeError):
                created_utc = 0
            try:
                edited_utc = int(note.get("userEditedTimestampMs", 0)) // 1000
            except (ValueError, TypeError):
                edited_utc = 0

            labels = [
                l.get("name")
                for l in note.get("labels", [])
                if isinstance(l, dict) and l.get("name")
            ]
            m = re.search(r"https?://\S+", text_content)
            url = m.group(0) if m else ""
            # createdTimestampMs is unique per note and stable across re-imports; prefer it
            # over the filename stem (two notes titled the same in different account/label
            # folders would otherwise collapse to one fullname).
            created_ms = note.get("createdTimestampMs")
            source_id = str(created_ms) if created_ms else file_path.stem

            yield new_item(
                source="keep",
                source_id=source_id,
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
