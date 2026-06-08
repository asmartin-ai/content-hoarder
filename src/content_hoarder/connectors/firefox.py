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
from content_hoarder.connectors.youtube import _video_id_from_url
from content_hoarder.models import new_item

_URL_RE = re.compile(r"^https?://", re.I)
_HEADER = "Export Tabs URLs"
_YT_BADGE = re.compile(r"^\(\d+\)\s*")            # browser unread-count prefix: "(29) "
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
    return (host == "youtube.com" or host.endswith(".youtube.com")
            or host == "youtu.be" or host.endswith(".youtu.be"))


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


def yt_item(vid: str, title: str = "", window: str = "", pinned: bool = False) -> dict:
    """Build the ``youtube:<vid>`` item a Firefox YouTube tab promotes to.

    Markers (``open_in_firefox`` / ``firefox_*``) are *additive* — keys a Watch-Later
    row never carries — so a ``merge_upsert`` onto an existing save adds the "open in a
    tab" signal without clobbering its playlist/position. (``title`` is still an overlay
    field; for the rare open-and-saved case the cleanup pass / a later enrich wins.)"""
    meta = {
        "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
        "open_in_firefox": True,
    }
    if window:
        meta["firefox_window"] = window
    if pinned:
        meta["firefox_pinned"] = 1
    return new_item(
        source="youtube",
        source_id=vid,
        kind="video",
        title=_clean_yt_tab_title(title),
        url=f"https://youtu.be/{vid}",
        metadata=meta,
    )


class FirefoxConnector(BaseConnector):
    id = "firefox"
    label = "Firefox Tabs"
    badge_color = "#0060df"

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
                favicon, flag = "", ""
                if len(lines) >= 4:        # title, url, favicon, flag
                    favicon, flag = lines[2], lines[3]
                elif len(lines) == 3:      # title, url, flag (favicon omitted)
                    flag = lines[2]
                yield self._make(lines[1], lines[0], favicon, window, flag.lower() == "true")
            elif _URL_RE.match(lines[0]):  # title-less tab (bare URL)
                yield self._make(lines[0], "", "", window, False)

    def _make(self, url, title, favicon, window, pinned):
        vid = youtube_id(url)
        if vid:  # a YouTube tab becomes a real youtube:<vid> item (merges with Watch Later)
            return yt_item(vid, title, window, pinned)
        meta = {"domain": _domain(url)}
        if favicon:
            meta["favicon"] = favicon
        if window:
            meta["window"] = window
        if pinned:
            meta["pinned"] = 1
        return new_item(
            source="firefox",
            source_id=hashlib.sha1(_norm_url(url).encode("utf-8", "ignore")).hexdigest()[:16],
            kind="tab",
            title=title,
            url=url,
            metadata=meta,
        )
