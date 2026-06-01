"""YouTube connector — imports playlists (yt-dlp flat JSON) and a Watch Later fallback."""

from __future__ import annotations

import json
import re
from pathlib import Path

from content_hoarder.connectors.base import BaseConnector
from content_hoarder.models import new_item

_VIDEO_ID = re.compile(r"(?:v=|youtu\.be/|/shorts/|/embed/)([\w-]{6,})")


def _video_id_from_url(url: str) -> str:
    match = _VIDEO_ID.search(url or "")
    return match.group(1) if match else ""


class YouTubeConnector(BaseConnector):
    id = "youtube"
    label = "YouTube"
    badge_color = "#ff0000"

    def can_import(self, path: Path) -> bool:
        p = Path(path)
        if not p.is_file() or p.suffix.lower() != ".json":
            return False
        try:
            data = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
        except (json.JSONDecodeError, OSError):
            return False
        if isinstance(data, dict):
            return data.get("_type") == "playlist" and isinstance(data.get("entries"), list)
        if isinstance(data, list):
            return bool(data) and isinstance(data[0], dict)
        return False

    def import_file(self, path: Path):
        p = Path(path)
        try:
            data = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
        except (json.JSONDecodeError, OSError):
            return

        if isinstance(data, dict) and data.get("_type") == "playlist":
            playlist_title = data.get("title") or "playlist"
            playlist_id = data.get("id") or ""
            for index, entry in enumerate(data.get("entries") or []):
                if not isinstance(entry, dict):
                    continue
                vid = entry.get("id") or entry.get("videoId") or _video_id_from_url(entry.get("url") or "")
                if not vid:
                    continue
                channel = entry.get("channel") or entry.get("uploader") or ""
                yield self._make(vid, entry, channel, playlist_title, playlist_id, index)
        elif isinstance(data, list):
            for index, entry in enumerate(data):
                if not isinstance(entry, dict):
                    continue
                vid = entry.get("id") or entry.get("videoId") or _video_id_from_url(entry.get("url") or "")
                if not vid:
                    continue
                channel = entry.get("channel") or entry.get("uploader") or entry.get("author") or ""
                yield self._make(vid, entry, channel, "WL", "", index)

    def _make(self, vid, entry, channel, playlist_title, playlist_id, index):
        ts = entry.get("timestamp")
        created = int(ts) if str(ts or "").lstrip("-").isdigit() else 0
        return new_item(
            source="youtube",
            source_id=vid,
            kind="video",
            title=entry.get("title") or "",
            author=channel,
            url=entry.get("url") or f"https://youtu.be/{vid}",
            created_utc=created,
            metadata={
                "channel": channel,
                "channel_id": entry.get("channel_id") or entry.get("uploader_id"),
                "duration": entry.get("duration"),
                "view_count": entry.get("view_count"),
                "playlist": playlist_title,
                "playlist_id": playlist_id,
                "position": index,
                "availability": entry.get("availability"),
                "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
            },
        )
