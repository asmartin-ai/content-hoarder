"""YouTube connector — imports playlists (yt-dlp flat JSON) and a Watch Later fallback."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import time
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
            e0 = data[0] if data else None
            # Only claim a flat array if the first entry actually looks like a video
            # (a bare list-of-dicts must NOT be greedily claimed — it masks the right
            # connector and silently imports nothing).
            return isinstance(e0, dict) and bool(
                e0.get("id") or e0.get("videoId") or _video_id_from_url(e0.get("url") or ""))
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

    # -- enrich (per-video yt-dlp metadata) ----------------------------------
    def enrich(self, items: list[dict]) -> list[dict]:
        """Fill exact duration / categories / tags / description / view_count per video
        via ``yt-dlp --dump-single-json``. Marks ``hydrated_at`` so re-runs resume; no-ops
        if yt-dlp is missing. Unavailable (private/deleted) videos are stamped so they
        aren't retried — title recovery for those is a separate step."""
        exe = shutil.which("yt-dlp")
        if not exe:
            return items  # don't drop the rows; just can't enrich without yt-dlp
        now = int(time.time())
        out = []
        for it in items:
            info = self._ytdlp_info(exe, it.get("source_id") or "")
            upd = {"fullname": it["fullname"], "hydrated_at": now}
            if info:
                md = {
                    "duration": info.get("duration"),
                    "view_count": info.get("view_count"),
                    "like_count": info.get("like_count"),
                    "yt_categories": info.get("categories"),   # NOT 'category' (that's the heuristic tag)
                    "tags": (info.get("tags") or [])[:25],
                    "description": (info.get("description") or "")[:2000],
                    "channel": info.get("channel") or info.get("uploader"),
                    "channel_id": info.get("channel_id") or info.get("uploader_id"),
                    "availability": info.get("availability"),
                    "upload_date": info.get("upload_date"),
                }
                upd["metadata"] = {k: v for k, v in md.items() if v not in (None, "", [], {})}
                if info.get("title"):
                    upd["title"] = info["title"]
                ts = info.get("timestamp")
                if isinstance(ts, (int, float)):
                    upd["created_utc"] = int(ts)
            else:
                upd["metadata"] = {"availability": "unavailable"}
            out.append(upd)
        return out

    def _ytdlp_info(self, exe: str, vid: str):
        if not vid:
            return None
        try:
            proc = subprocess.run(
                [exe, "--dump-single-json", "--skip-download", "--no-warnings",
                 f"https://youtu.be/{vid}"],
                capture_output=True, text=True, timeout=60,
            )
        except (subprocess.TimeoutExpired, OSError):
            return None
        if proc.returncode != 0 or not (proc.stdout or "").strip():
            return None
        try:
            return json.loads(proc.stdout)
        except json.JSONDecodeError:
            return None
