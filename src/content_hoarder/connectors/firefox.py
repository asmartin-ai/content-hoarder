"""Firefox tabs connector — open-tab captures from text or JSON exports.

Reads the .txt produced by the "Export Tabs URLs" extension: per-tab blocks of
``title`` / ``url`` / ``favicon`` / ``flag`` grouped under ``Window:::`` headers. Also
reads content-hoarder's WebExtension-style JSON snapshot schema. Emits
``firefox:<url-hash>`` items so re-importing overlapping exports de-dups by URL.
YouTube video tabs are promoted to canonical ``youtube:<video-id>`` items.
(OneTab / Tab Session Manager / ``recovery.jsonlz4`` remain future inputs.)
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

from content_hoarder.connectors.base import BaseConnector
from content_hoarder.connectors.youtube import _video_id_from_url
from content_hoarder.models import new_item

_URL_RE = re.compile(r"^https?://", re.I)
_HEADER = "Export Tabs URLs"
FIREFOX_TABS_SCHEMA = "content-hoarder.firefox-tabs.v1"
_YT_BADGE = re.compile(r"^\(\d+\)\s*")  # browser unread-count prefix: "(29) "
_YT_SUFFIX = re.compile(r"\s*-\s*YouTube\s*$", re.I)
# /embed/ path sentinels the shared regex captures that are NOT real video ids.
_YT_NON_IDS = {"videoseries", "live_stream"}


def _domain(url: str) -> str:
    m = re.match(r"https?://([^/]+)", url or "", re.I)
    return m.group(1).lower() if m else ""


def _norm_url(url: str) -> str:
    """Normalize for stable de-dup across overlapping exports: lowercase scheme+host,
    drop a trailing slash and any #fragment (the query is kept — it's significant)."""
    u = (url or "").strip()
    m = re.match(r"(https?://[^/]+)(/[^#]*)?", u, re.I)
    if not m:
        return u.lower()
    return m.group(1).lower() + (m.group(2) or "").rstrip("/")


def _is_youtube_host(host: str) -> bool:
    return (
        host == "youtube.com"
        or host.endswith(".youtube.com")
        or host == "youtu.be"
        or host.endswith(".youtu.be")
    )


def youtube_id(url: str) -> str:
    """Video id iff ``url`` is actually a YouTube watch/short/embed link.

    Host-guards the shared ``_video_id_from_url`` regex so a coincidental ``?v=`` on a
    non-YouTube host (e.g. ``example.com/p?v=123456``) is NOT mis-promoted to a video."""
    if not _is_youtube_host(_domain(url)):
        return ""
    vid = _video_id_from_url(url)
    # YouTube video IDs are exactly 11 chars; shorter/longer captures (e.g. "playlist"
    # from /embed/playlist?list=...) are embed-path sentinels, not real IDs.
    return "" if (not vid or len(vid) != 11 or vid in _YT_NON_IDS) else vid


def _clean_yt_tab_title(title: str) -> str:
    """Strip the browser's unread-count ``(29) `` prefix and the `` - YouTube`` suffix."""
    t = _YT_BADGE.sub("", (title or "").strip())
    return _YT_SUFFIX.sub("", t).strip()


def _present(value: Any) -> bool:
    return value is not None and value != ""


def _bool_marker(value: Any) -> bool:
    return value is True or value == 1


def _firefox_extra_metadata(
    record: Mapping[str, Any], *, include_original_url: bool = False
) -> dict[str, Any]:
    meta: dict[str, Any] = {}
    if include_original_url and record.get("url"):
        meta["firefox_original_url"] = str(record.get("url"))
    if _present(record.get("capture_source")):
        meta["firefox_capture_source"] = str(record["capture_source"])
    if _present(record.get("captured_at")):
        meta["firefox_captured_at"] = record["captured_at"]
    if _present(record.get("snapshot_id")):
        meta["firefox_snapshot_id"] = str(record["snapshot_id"])
    if _present(record.get("index")):
        meta["firefox_index"] = record["index"]
    if _present(record.get("active")):
        meta["firefox_active"] = 1 if record.get("active") else 0
    if _present(record.get("discarded")):
        meta["firefox_discarded"] = 1 if record.get("discarded") else 0
    if _present(record.get("last_accessed_ms")):
        meta["firefox_last_accessed_ms"] = record["last_accessed_ms"]
    if _present(record.get("cookie_store_id")):
        meta["firefox_cookie_store_id"] = str(record["cookie_store_id"])
    if _present(record.get("group_id")):
        meta["firefox_group_id"] = record["group_id"]
    return meta


def yt_item(
    vid: str,
    title: str = "",
    window: str = "",
    pinned: bool = False,
    *,
    extra_metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the ``youtube:<vid>`` item a Firefox YouTube tab promotes to.

    Markers (``open_in_firefox`` / ``firefox_*``) are *additive* — keys a Watch-Later
    row never carries — so a ``merge_upsert`` onto an existing save adds the "open in a
    tab" signal without clobbering its playlist/position. (``title`` is still an overlay
    field; for the rare open-and-saved case the cleanup pass / a later enrich wins.)"""
    meta: dict[str, Any] = {
        "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
        "open_in_firefox": True,
    }
    if window:
        meta["firefox_window"] = window
    if pinned:
        meta["firefox_pinned"] = 1
    if extra_metadata:
        meta.update(extra_metadata)
    return new_item(
        source="youtube",
        source_id=vid,
        kind="video",
        title=_clean_yt_tab_title(title),
        url=f"https://youtu.be/{vid}",
        metadata=meta,
    )


def item_from_tab_record(
    record: object, *, skip_incognito: bool = True
) -> dict[str, Any] | None:
    """Build one item from the normalized Firefox tab record shape.

    The record shape is shared by the legacy text parser, JSON exports, and the planned
    local WebExtension POST endpoint. Invalid, private/incognito, and non-http(s) tabs
    return ``None`` so callers can count/report skips without moving DB writes here.
    """
    if not isinstance(record, dict):
        return None
    if skip_incognito and record.get("incognito"):
        return None
    url = str(record.get("url") or "").strip()
    if not _URL_RE.match(url):
        return None

    title = str(record.get("title") or "")
    favicon = str(record.get("favicon") or "")
    window = str(record.get("window") or "")
    pinned = _bool_marker(record.get("pinned"))

    vid = youtube_id(url)
    if vid:  # a YouTube tab becomes a real youtube:<vid> item (merges with Watch Later)
        return yt_item(
            vid,
            title,
            window,
            pinned,
            extra_metadata=_firefox_extra_metadata(record, include_original_url=True),
        )

    meta: dict[str, Any] = {"domain": _domain(url), "open_in_firefox": True}
    if favicon:
        meta["favicon"] = favicon
    if window:
        meta["window"] = window
    if pinned:
        meta["pinned"] = 1
    meta.update(_firefox_extra_metadata(record))
    return new_item(
        source="firefox",
        source_id=hashlib.sha1(_norm_url(url).encode("utf-8", "ignore")).hexdigest()[
            :16
        ],
        kind="tab",
        title=title,
        url=url,
        metadata=meta,
    )


def items_from_tab_records(
    records: Iterable[dict[str, Any]], *, skip_incognito: bool = True
):
    for record in records:
        item = item_from_tab_record(record, skip_incognito=skip_incognito)
        if item is not None:
            yield item


class FirefoxConnector(BaseConnector):
    id = "firefox"
    label = "Firefox Tabs"
    badge_color = "#0060df"

    def can_import(self, path: Path) -> bool:
        p = Path(path)
        if not p.is_file():
            return False
        if p.suffix.lower() == ".txt":
            try:
                with open(p, "r", encoding="utf-8", errors="ignore") as fh:
                    return _HEADER in fh.read(256)
            except OSError:
                return False
        if p.suffix.lower() == ".json":
            try:
                payload = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return False
            return (
                isinstance(payload, dict)
                and payload.get("schema") == FIREFOX_TABS_SCHEMA
            )
        return False

    def import_file(self, path: Path):
        p = Path(path)
        if p.suffix.lower() == ".json":
            yield from self._import_json(p)
        else:
            yield from self._import_txt(p)

    def _import_json(self, path: Path):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        if (
            not isinstance(payload, dict)
            or payload.get("schema") != FIREFOX_TABS_SCHEMA
        ):
            return
        tabs = payload.get("tabs")
        if not isinstance(tabs, list):
            return

        source = payload.get("source") or "json_export"
        captured_at = payload.get("captured_at")
        snapshot_id = payload.get("snapshot_id")
        for tab in tabs:
            if not isinstance(tab, dict):
                continue
            record = dict(tab)
            record["capture_source"] = record.get("capture_source") or source
            if _present(captured_at) and not _present(record.get("captured_at")):
                record["captured_at"] = captured_at
            if _present(snapshot_id) and not _present(record.get("snapshot_id")):
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
            yield from items_from_tab_records([record])

    def _import_txt(self, path: Path):
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
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
                favicon, flag = "", ""
                if len(lines) >= 4:  # title, url, favicon, flag
                    favicon, flag = lines[2], lines[3]
                elif len(lines) == 3:  # title, url, flag (favicon omitted)
                    flag = lines[2]
                yield from items_from_tab_records(
                    [
                        {
                            "url": lines[1],
                            "title": lines[0],
                            "favicon": favicon,
                            "window": window,
                            "pinned": flag.lower() == "true",
                            "capture_source": "export-tabs-urls",
                        }
                    ]
                )
            elif _URL_RE.match(lines[0]):  # title-less tab (bare URL)
                yield from items_from_tab_records(
                    [
                        {
                            "url": lines[0],
                            "window": window,
                            "capture_source": "export-tabs-urls",
                        }
                    ]
                )
