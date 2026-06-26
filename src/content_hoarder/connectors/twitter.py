"""Twitter/X bookmarks connector.

Parses keyless browser-side exports (JSON or CSV) into ``twitter:<tweet_id>``
items. This is deliberately import-only: no API calls, no live sync, no DB
writes. The parser accepts flat exporter rows and the nested tweet shape used by
X's web GraphQL responses, because userscript exporters tend to preserve one of
those two forms.
"""

from __future__ import annotations

import csv
import email.utils
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from content_hoarder.connectors.base import BaseConnector
from content_hoarder.models import new_item

_STATUS_RE = re.compile(r"https?://(?:www\.)?(?:x|twitter)\.com/([^/?#]+)/status/(\d+)", re.I)
_URL_RE = re.compile(r"https?://[^\s<>)\"']+", re.I)
_ID_RE = re.compile(r"^\d{5,}$")


def _first(*values: Any) -> str:
    for value in values:
        if value is None:
            continue
        s = str(value).strip()
        if s:
            return s
    return ""


def tweet_id_from_url(url: str) -> str:
    m = _STATUS_RE.search(url or "")
    return m.group(2) if m else ""


def _handle_from_url(url: str) -> str:
    m = _STATUS_RE.search(url or "")
    return "" if not m or m.group(1).lower() == "i" else m.group(1)


def _permalink(tweet_id: str, handle: str = "", url: str = "") -> str:
    if tweet_id_from_url(url):
        return url.strip()
    if handle:
        return f"https://x.com/{handle.lstrip('@')}/status/{tweet_id}"
    return f"https://x.com/i/web/status/{tweet_id}"


def _ts(value: Any) -> int:
    """Coerce seconds/ms epochs, ISO strings, and Twitter's created_at string."""
    if value in (None, ""):
        return 0
    if isinstance(value, (int, float)):
        n = int(value)
        return n // 1000 if n > 10**12 else n
    s = str(value).strip()
    if not s:
        return 0
    if s.isdigit():
        n = int(s)
        return n // 1000 if n > 10**12 else n
    try:
        dt = email.utils.parsedate_to_datetime(s)
    except (TypeError, ValueError):
        dt = None
    if dt is None:
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return 0
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def _as_list(value: Any) -> list[Any]:
    if value in (None, ""):
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return []
        if s.startswith("["):
            try:
                parsed = json.loads(s)
                return parsed if isinstance(parsed, list) else [parsed]
            except ValueError:
                pass
        return [x.strip() for x in re.split(r"[\n,;]\s*", s) if x.strip()]
    return [value]


def _media_url(media: Any) -> str:
    if isinstance(media, str):
        return media.strip()
    if not isinstance(media, dict):
        return ""
    url = _first(
        media.get("media_url_https"),
        media.get("media_url"),
        media.get("url"),
        media.get("expanded_url"),
    )
    video_info = media.get("video_info") if isinstance(media.get("video_info"), dict) else {}
    variants = video_info.get("variants") if isinstance(video_info.get("variants"), list) else []
    mp4s = [
        v for v in variants
        if isinstance(v, dict) and str(v.get("url") or "").startswith("http")
        and "mp4" in str(v.get("content_type") or v.get("url") or "")
    ]
    if mp4s:
        mp4s.sort(key=lambda v: int(v.get("bitrate") or 0), reverse=True)
        return str(mp4s[0].get("url") or "").strip()
    return url


def _poster_url(media: Any) -> str:
    if isinstance(media, str):
        return media.strip() if "pbs.twimg.com/media/" in media or _looks_img(media) else ""
    if not isinstance(media, dict):
        return ""
    url = _first(media.get("media_url_https"), media.get("media_url"))
    return url if "pbs.twimg.com/media/" in url or _looks_img(url) else ""


def _media_urls(*values: Any) -> list[str]:
    out: list[str] = []
    for value in values:
        for media in _as_list(value):
            url = _media_url(media)
            if url and url not in out:
                out.append(url)
    return out


def _poster_urls(*values: Any) -> list[str]:
    out: list[str] = []
    for value in values:
        for media in _as_list(value):
            url = _poster_url(media)
            if url and url not in out:
                out.append(url)
    return out


def _looks_img(url: str) -> bool:
    return bool(re.search(r"\.(png|jpe?g|gif|webp)(\?|#|$)", url or "", re.I))


def _link_url(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if not isinstance(value, dict):
        return ""
    return _first(
        value.get("expanded_url"),
        value.get("unwound_url"),
        value.get("url"),
    )


def _link_urls(*values: Any, text: str = "") -> list[str]:
    out: list[str] = []
    for value in values:
        for link in _as_list(value):
            url = _link_url(link)
            if url and url not in out:
                out.append(url)
    for url in _URL_RE.findall(text or ""):
        url = url.rstrip(".,;:!?)]}")
        if url and url not in out:
            out.append(url)
    return out


def _orig_image(url: str) -> str:
    if "pbs.twimg.com/media/" not in url:
        return url
    base = url.split("?", 1)[0]
    return base + "?name=orig"


def _tweet_summary(result: dict[str, Any]) -> dict[str, Any]:
    legacy = result.get("legacy") if isinstance(result.get("legacy"), dict) else {}
    core = result.get("core") if isinstance(result.get("core"), dict) else {}
    user_result = ((core.get("user_results") or {}).get("result")
                   if isinstance(core.get("user_results"), dict) else {})
    user_legacy = user_result.get("legacy") if isinstance(user_result, dict) else {}
    if not isinstance(user_legacy, dict):
        user_legacy = {}
    tweet_id = _first(result.get("rest_id"), legacy.get("id_str"), legacy.get("id"))
    handle = _first(user_legacy.get("screen_name"), legacy.get("screen_name")).lstrip("@")
    if not _ID_RE.match(tweet_id):
        return {}
    out = {
        "tweet_id": tweet_id,
        "permalink": _permalink(tweet_id, handle),
        "text": _first(legacy.get("full_text"), legacy.get("text")),
        "author_handle": handle,
        "author_name": _first(user_legacy.get("name"), legacy.get("name")),
    }
    return {k: v for k, v in out.items() if v}


def _flat_item(row: dict[str, Any], *, index: int | None = None) -> dict | None:
    url = _first(row.get("url"), row.get("permalink"), row.get("tweet_url"), row.get("expanded_url"))
    tweet_id = _first(
        row.get("tweet_id"),
        row.get("id_str"),
        row.get("rest_id"),
        row.get("id"),
        tweet_id_from_url(url),
    )
    if not _ID_RE.match(tweet_id):
        return None

    text = _first(row.get("full_text"), row.get("text"), row.get("tweet_text"), row.get("body"))
    handle = _first(
        row.get("screen_name"),
        row.get("username"),
        row.get("author_handle"),
        row.get("handle"),
        _handle_from_url(url),
    ).lstrip("@")
    author_name = _first(row.get("name"), row.get("author_name"), row.get("display_name"))
    media = [_orig_image(u) for u in _media_urls(
        row.get("media_urls"),
        row.get("media_url"),
        row.get("media"),
        row.get("photos"),
        row.get("videos"),
    )]
    posters = [_orig_image(u) for u in _poster_urls(
        row.get("media_urls"),
        row.get("media_url"),
        row.get("media"),
        row.get("photos"),
        row.get("videos"),
    )]
    outlinks = _link_urls(
        row.get("outlinks"),
        row.get("links"),
        row.get("urls"),
        row.get("expanded_urls"),
        text=text,
    )
    meta: dict[str, Any] = {
        "permalink": _permalink(tweet_id, handle, url),
        "author_handle": handle,
        "author_name": author_name,
    }
    if media:
        meta["media_urls"] = media
        meta["media_type"] = "video" if any("video.twimg.com/" in u for u in media) else "image"
        meta["thumbnail"] = (posters or media)[0]
    if outlinks:
        meta["outlinks"] = outlinks
    for dst, *keys in (
        ("conversation_id", "conversation_id_str", "conversation_id"),
        ("in_reply_to_status_id", "in_reply_to_status_id_str", "in_reply_to_status_id"),
        ("in_reply_to_screen_name", "in_reply_to_screen_name"),
    ):
        val = _first(*(row.get(k) for k in keys))
        if val:
            meta[dst] = val
    quote = row.get("quote_tweet")
    if isinstance(quote, dict):
        meta["quote_tweet"] = quote
    if index is not None:
        meta["bookmark_index"] = index
    return new_item(
        source="twitter",
        source_id=tweet_id,
        kind="tweet",
        title=text,
        url=meta["permalink"],
        author=handle or author_name,
        created_utc=_ts(_first(row.get("created_at"), row.get("createdAt"), row.get("time"))),
        metadata=meta,
        raw=row,
    )


def _graphql_item(result: dict[str, Any], *, index: int | None = None) -> dict | None:
    legacy = result.get("legacy") if isinstance(result.get("legacy"), dict) else {}
    if not legacy:
        return None
    core = result.get("core") if isinstance(result.get("core"), dict) else {}
    user_result = ((core.get("user_results") or {}).get("result")
                   if isinstance(core.get("user_results"), dict) else {})
    user_legacy = user_result.get("legacy") if isinstance(user_result, dict) else {}
    if not isinstance(user_legacy, dict):
        user_legacy = {}

    tweet_id = _first(result.get("rest_id"), legacy.get("id_str"), legacy.get("id"))
    if not _ID_RE.match(tweet_id):
        return None
    handle = _first(user_legacy.get("screen_name"), legacy.get("screen_name"))
    url = _permalink(tweet_id, handle)
    row = {
        "tweet_id": tweet_id,
        "full_text": legacy.get("full_text"),
        "created_at": legacy.get("created_at"),
        "url": url,
        "screen_name": handle,
        "author_name": user_legacy.get("name"),
        "media": (legacy.get("extended_entities") or {}).get("media")
                 or (legacy.get("entities") or {}).get("media"),
        "urls": (legacy.get("entities") or {}).get("urls"),
        "conversation_id": legacy.get("conversation_id_str") or legacy.get("conversation_id"),
        "in_reply_to_status_id": legacy.get("in_reply_to_status_id_str")
                                 or legacy.get("in_reply_to_status_id"),
        "in_reply_to_screen_name": legacy.get("in_reply_to_screen_name"),
    }
    quoted = result.get("quoted_status_result")
    quoted_result = ((quoted.get("result") if isinstance(quoted, dict) else None)
                     or (quoted.get("tweet_results", {}).get("result")
                         if isinstance(quoted, dict)
                         and isinstance(quoted.get("tweet_results"), dict) else None))
    if isinstance(quoted_result, dict):
        quote = _tweet_summary(quoted_result)
        if quote:
            row["quote_tweet"] = quote
    return _flat_item(row, index=index)


def _iter_json_tweets(data: Any) -> Iterable[dict]:
    """Yield candidate tweet rows from flat exports and web GraphQL-shaped blobs."""
    stack: list[tuple[Any, int | None]] = [(data, None)]
    seen_obj: set[int] = set()
    while stack:
        obj, index = stack.pop()
        if isinstance(obj, list):
            for i, child in reversed(list(enumerate(obj))):
                stack.append((child, i))
            continue
        if not isinstance(obj, dict) or id(obj) in seen_obj:
            continue
        seen_obj.add(id(obj))

        legacy = obj.get("legacy")
        if isinstance(legacy, dict) and "full_text" in legacy:
            item = _graphql_item(obj, index=index)
            if item is not None:
                yield item
                continue

        item = _flat_item(obj, index=index)
        if item is not None:
            yield item
            continue

        twres = obj.get("tweet_results")
        if isinstance(twres, dict) and isinstance(twres.get("result"), dict):
            stack.append((twres["result"], index))
            continue

        for key, child in obj.items():
            if key in {"quoted_status_result", "retweeted_status_result"}:
                continue
            if isinstance(child, (dict, list)):
                stack.append((child, index))


class TwitterConnector(BaseConnector):
    id = "twitter"
    label = "Twitter / X Bookmarks"
    badge_color = "#1d9bf0"

    def can_import(self, path: Path) -> bool:
        p = Path(path)
        if not p.is_file():
            return False
        if p.suffix.lower() == ".json":
            try:
                data = json.loads(p.read_text("utf-8", errors="ignore"))
            except (OSError, ValueError):
                return False
            return any(True for _ in _take(_iter_json_tweets(data), 1))
        if p.suffix.lower() == ".csv":
            try:
                with open(p, "r", encoding="utf-8", errors="ignore", newline="") as fh:
                    reader = csv.DictReader(fh)
                    return any(_flat_item(row) is not None for _, row in zip(range(10), reader))
            except OSError:
                return False
        return False

    def import_file(self, path: Path):
        p = Path(path)
        if p.suffix.lower() == ".json":
            try:
                data = json.loads(p.read_text("utf-8", errors="ignore"))
            except (OSError, ValueError):
                return
            seen: set[str] = set()
            for item in _iter_json_tweets(data):
                if item["source_id"] in seen:
                    continue
                seen.add(item["source_id"])
                yield item
            return
        if p.suffix.lower() == ".csv":
            try:
                with open(p, "r", encoding="utf-8", errors="ignore", newline="") as fh:
                    reader = csv.DictReader(fh)
                    seen: set[str] = set()
                    for i, row in enumerate(reader):
                        item = _flat_item(row, index=i)
                        if item is None or item["source_id"] in seen:
                            continue
                        seen.add(item["source_id"])
                        yield item
            except OSError:
                return


def _take(iterable: Iterable[Any], n: int) -> list[Any]:
    out = []
    for x in iterable:
        out.append(x)
        if len(out) >= n:
            break
    return out
