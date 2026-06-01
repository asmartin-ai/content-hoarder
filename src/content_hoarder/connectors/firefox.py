"""Firefox tabs connector — "Export Tabs URLs" (Rich format) .txt exports.

Reads the .txt produced by the "Export Tabs URLs" extension: per-tab blocks of
``title`` / ``url`` / ``favicon`` / ``flag`` grouped under ``Window:::`` headers. Emits
``firefox:<url-hash>`` items so re-importing the overlapping daily exports de-dups by
URL. (OneTab / Tab Session Manager / ``recovery.jsonlz4`` remain future inputs.)
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

from content_hoarder.connectors.base import BaseConnector
from content_hoarder.models import new_item

_URL_RE = re.compile(r"^https?://", re.I)
_HEADER = "Export Tabs URLs"


def _domain(url: str) -> str:
    m = re.match(r"https?://([^/]+)", url or "", re.I)
    return m.group(1).lower() if m else ""


class FirefoxConnector(BaseConnector):
    id = "firefox"
    label = "Firefox Tabs"
    badge_color = "#ff7139"

    def can_import(self, path: Path) -> bool:
        p = Path(path)
        if not p.is_file() or p.suffix.lower() != ".txt":
            return False
        try:
            with open(p, "r", encoding="utf-8", errors="ignore") as fh:
                return _HEADER in fh.read(256)
        except OSError:
            return False

    def import_file(self, path: Path):
        try:
            text = Path(path).read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return
        window = ""
        for block in re.split(r"\n\s*\n", text):
            lines = [ln.strip() for ln in block.splitlines() if ln.strip()]
            if not lines:
                continue
            if lines[0].startswith("Window:::"):
                m = re.search(r"id:\s*(\S+)", lines[0])
                window = m.group(1) if m else ""
                continue
            if lines[0].startswith("#") or lines[0].startswith(_HEADER):
                continue
            # a tab block: title, url, [favicon], [flag]
            if len(lines) >= 2 and _URL_RE.match(lines[1]):
                favicon = lines[2] if len(lines) >= 3 and _URL_RE.match(lines[2]) else ""
                pinned = len(lines) >= 4 and lines[3].lower() == "true"
                yield self._make(lines[1], lines[0], favicon, window, pinned)
            elif _URL_RE.match(lines[0]):  # title-less tab (bare URL)
                yield self._make(lines[0], "", "", window, False)

    def _make(self, url, title, favicon, window, pinned):
        meta = {"domain": _domain(url)}
        if favicon:
            meta["favicon"] = favicon
        if window:
            meta["window"] = window
        if pinned:
            meta["pinned"] = 1
        return new_item(
            source="firefox",
            source_id=hashlib.sha1(url.encode("utf-8", "ignore")).hexdigest()[:16],
            kind="tab",
            title=title,
            url=url,
            metadata=meta,
        )
