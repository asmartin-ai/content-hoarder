"""Reddit connector.

Imports from the existing reddit-saved-manager SQLite DB (read-only) or its CSV/JSON
exports. Reddit-specific fields (subreddit, permalink, score, over_18, ...) are folded
into the generic ``metadata`` blob; the new fullname is ``reddit:<t3_/t1_id>``.
"""

from __future__ import annotations

import csv
import json
import re
import sqlite3
from html import unescape
from pathlib import Path

from content_hoarder.connectors.base import BaseConnector
from content_hoarder.models import new_item

_PERMA_COMMENT = re.compile(r"/comments/([a-z0-9]+)/[^/]*/([a-z0-9]+)")
_PERMA_POST = re.compile(r"/comments/([a-z0-9]+)")
_PERMA_SLUG = re.compile(r"/comments/[a-z0-9]+/([^/]+)/?")
_PERMA_SUB = re.compile(r"/r/([^/]+)/")

_RSM_META_COLS = ("subreddit", "permalink", "score", "over_18", "num_comments", "reddit_id")


def _title_from_permalink(permalink: str) -> str:
    m = _PERMA_SLUG.search(permalink or "")
    if not m:
        return ""
    slug = m.group(1).replace("_", " ").replace("-", " ").strip()
    return (slug[:1].upper() + slug[1:]) if slug else ""


def _sub_from_permalink(permalink: str) -> str:
    m = _PERMA_SUB.search(permalink or "")
    return m.group(1) if m else ""


def _sid_from_permalink(permalink: str) -> str:
    mc = _PERMA_COMMENT.search(permalink or "")
    if mc:
        return "t1_" + mc.group(2)
    mp = _PERMA_POST.search(permalink or "")
    return ("t3_" + mp.group(1)) if mp else ""


def _clean_url(url: str, permalink: str) -> str:
    """Build a usable URL without double-prefixing. The RSM DB stores `permalink` as a
    full (sometimes colon-broken `https//`) URL with an empty `url`, so we must NOT blindly
    prepend the reddit domain — only do so for genuinely relative ('/r/...') permalinks."""
    if url:
        return url
    p = (permalink or "").strip()
    if not p:
        return ""
    if p.startswith(("http://", "https://")):
        return p
    if p.startswith("https//"):            # missing colon
        return "https://" + p[len("https//"):]
    if p.startswith("http//"):
        return "http://" + p[len("http//"):]
    if p.startswith("/"):
        return "https://www.reddit.com" + p
    if p.startswith("www."):
        return "https://" + p
    return "https://www.reddit.com/" + p.lstrip("/")


_IMG_RE = re.compile(r"\.(png|jpe?g|gif|gifv|webp|bmp)(?:\?|$)", re.I)


def _media_type_from_url(url: str) -> str:
    u = (url or "").lower()
    if not u:
        return ""
    if "v.redd.it" in u:
        return "reddit_video"
    if "i.redd.it" in u or _IMG_RE.search(u):
        return "image"
    if "youtube.com" in u or "youtu.be" in u:
        return "youtube"
    return "link"


def _classify_media(meta: dict, raw_url, permalink: str, body: str, kind: str) -> str:
    """Annotate ``meta['media_type']`` (+ ``media_url``) and return the canonical click URL.

    Bare ``v.redd.it`` URLs don't render a page, so v.redd.it posts are pointed at their
    permalink (which plays in Reddit's embed/player) while the original media URL is kept
    in metadata. Reddit posts with no captured URL and no text body are most likely
    image/video posts (``reddit_media``) and get an inline preview affordance.
    """
    link_url = _clean_url(raw_url, permalink)
    perma_url = _clean_url("", permalink)
    mt = _media_type_from_url(link_url)
    if mt == "reddit_video":
        meta["media_type"] = "reddit_video"
        if link_url:
            meta["media_url"] = link_url
        return perma_url or link_url
    if mt in ("image", "youtube"):
        meta["media_type"] = mt
        return link_url
    if mt == "link":
        if "reddit.com" in link_url.lower() and kind == "post" and not (body or "").strip():
            meta["media_type"] = "reddit_media"  # media post whose URL wasn't captured
        else:
            meta["media_type"] = "link"
        return link_url
    # no URL at all → only the permalink to fall back on
    if kind == "post" and not (body or "").strip():
        meta["media_type"] = "reddit_media"
    return perma_url


def child_to_item(ch: dict):
    """A Reddit API listing child (``{"kind": "t1"/"t3", "data": {...}}``) → a normalized
    content-hoarder item dict, or ``None`` if unusable. Shared by the JSON importer and the
    cookie sync so both shape items identically (subreddit/score/over_18/media in metadata)."""
    d = ch.get("data", ch) if isinstance(ch, dict) else {}
    if not isinstance(d, dict):
        return None
    permalink = d.get("permalink") or ""
    sid = d.get("name") or _sid_from_permalink(permalink)
    if not sid and d.get("id"):
        sid = ("t1_" if (isinstance(ch, dict) and ch.get("kind") == "t1") else "t3_") + d["id"]
    if not sid:
        return None
    meta = {}
    if d.get("subreddit"):
        meta["subreddit"] = d["subreddit"]
    if permalink:
        meta["permalink"] = permalink
    if d.get("score") is not None:
        meta["score"] = d["score"]
    if d.get("over_18") is not None:
        meta["over_18"] = 1 if d["over_18"] else 0
    kind = "comment" if str(sid).startswith("t1_") else "post"
    body = d.get("selftext") or d.get("body") or ""
    url = _classify_media(meta, d.get("url"), permalink, body, kind)
    return new_item(
        source="reddit",
        source_id=sid,
        kind=kind,
        title=d.get("title") or _title_from_permalink(permalink),
        body=body,
        url=url,
        author=d.get("author") or "",
        created_utc=int(d.get("created_utc") or 0),
        metadata=meta,
        raw=d,
    )


def _is_rsm_db(path: Path) -> bool:
    try:
        con = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    except sqlite3.Error:
        return False
    try:
        if not con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='items'"
        ).fetchone():
            return False
        cols = {r[1] for r in con.execute("PRAGMA table_info(items)")}
        return ("permalink" in cols or "subreddit" in cols) and "source_id" not in cols
    except sqlite3.Error:
        return False
    finally:
        con.close()


_HREF_A = re.compile(r"<a\s+[^>]*href=['\"]([^'\"]+)['\"][^>]*>(.*?)</a>", re.S | re.I)
_HTML_TAG = re.compile(r"<[^>]+>")


class RedditConnector(BaseConnector):
    id = "reddit"
    label = "Reddit"
    badge_color = "#ff4500"

    def can_import(self, path: Path) -> bool:
        p = Path(path)
        if not p.is_file():
            return False
        suf = p.suffix.lower()
        if suf in (".db", ".sqlite", ".sqlite3"):
            return _is_rsm_db(p)
        if suf == ".csv":
            return True
        if suf == ".json":
            return self._looks_reddit(p)
        if suf in (".html", ".htm"):
            return self._looks_reddit_html(p)
        return False

    def _looks_reddit(self, p: Path) -> bool:
        try:
            with open(p, "r", encoding="utf-8", errors="ignore") as fh:
                head = fh.read(8192)
        except OSError:
            return False
        return any(s in head for s in ('"permalink"', '"subreddit"', '"kind": "t3', '"kind":"t3'))

    def _looks_reddit_html(self, p: Path) -> bool:
        try:
            head = Path(p).read_text(encoding="utf-8", errors="ignore")[:16384]
        except OSError:
            return False
        return "reddit.com" in head and "/comments/" in head

    # -- sources -----------------------------------------------------------

    def import_file(self, path: Path):
        p = Path(path)
        suf = p.suffix.lower()
        if suf in (".db", ".sqlite", ".sqlite3"):
            yield from self._from_db(p)
        elif suf == ".csv":
            yield from self._from_csv(p)
        elif suf == ".json":
            yield from self._from_json(p)
        elif suf in (".html", ".htm"):
            yield from self._from_html(p)

    def _from_html(self, p: Path):
        """saveddit-style export: one <li> per saved item — a content link (url +
        title) plus the thread permalink. Route the content URL through the media
        classifier so galleries/videos are detected; merges with existing items."""
        try:
            text = Path(p).read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return
        seen: set = set()
        for block in re.split(r"</li>", text, flags=re.I):
            links = _HREF_A.findall(block)
            if not links:
                continue
            permalink = ""
            for href, _txt in links:
                if "/comments/" in href and "reddit.com" in href.lower():
                    permalink = href
                    break
            if not permalink and "reddit.com" in links[0][0].lower() and "/comments/" in links[0][0]:
                permalink = links[0][0]
            sid = _sid_from_permalink(permalink)
            if not sid or sid in seen:
                continue
            seen.add(sid)
            content_url, title_html = links[0]
            title = re.sub(r"\s+", " ", unescape(_HTML_TAG.sub("", title_html))).strip()
            raw_url = "" if content_url == permalink else content_url
            kind = "comment" if str(sid).startswith("t1_") else "post"
            meta = {"permalink": permalink}
            sub = _sub_from_permalink(permalink)
            if sub:
                meta["subreddit"] = sub
            url = _classify_media(meta, raw_url, permalink, "", kind)
            yield new_item(
                source="reddit", source_id=sid, kind=kind,
                title=title or _title_from_permalink(permalink),
                url=url, metadata=meta,
            )

    def _from_db(self, p: Path):
        con = sqlite3.connect(f"file:{p.as_posix()}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        try:
            for row in con.execute("SELECT * FROM items"):
                item = self._row_to_item(dict(row))
                if item:
                    yield item
        finally:
            con.close()

    def _row_to_item(self, d: dict):
        permalink = d.get("permalink") or ""
        sid = d.get("fullname") or d.get("reddit_id") or _sid_from_permalink(permalink)
        if not sid:
            return None
        kind = d.get("kind") or ("comment" if str(sid).startswith("t1_") else "post")
        meta = {c: d[c] for c in _RSM_META_COLS if d.get(c) not in (None, "")}
        if "subreddit" not in meta and _sub_from_permalink(permalink):
            meta["subreddit"] = _sub_from_permalink(permalink)
        if permalink and "permalink" not in meta:
            meta["permalink"] = permalink
        body = d.get("body") or d.get("selftext") or ""
        url = _classify_media(meta, d.get("url"), permalink, body, kind)
        return new_item(
            source="reddit",
            source_id=sid,
            kind=kind,
            title=d.get("title") or _title_from_permalink(permalink),
            body=body,
            url=url,
            author=d.get("author") or "",
            created_utc=int(d.get("created_utc") or 0),
            saved_utc=int(d.get("saved_utc") or 0),
            metadata=meta,
        )

    def _from_csv(self, p: Path):
        with open(p, "r", encoding="utf-8", errors="ignore", newline="") as fh:
            for raw in csv.DictReader(fh):
                row = {(k or "").strip().lower(): (v or "").strip() for k, v in raw.items()}
                permalink = row.get("permalink") or ""
                sid = row.get("fullname") or ""
                rid = row.get("id") or ""
                if not sid and rid:
                    sid = rid if rid.startswith(("t1_", "t3_")) else (
                        "t1_" + rid if _PERMA_COMMENT.search(permalink) else "t3_" + rid
                    )
                if not sid:
                    sid = _sid_from_permalink(permalink)
                if not sid:
                    continue
                meta = {}
                sub = row.get("subreddit") or _sub_from_permalink(permalink)
                if sub:
                    meta["subreddit"] = sub
                if permalink:
                    meta["permalink"] = permalink
                if row.get("score"):
                    meta["score"] = row["score"]
                kind = "comment" if str(sid).startswith("t1_") else "post"
                body = row.get("body") or row.get("selftext") or ""
                url = _classify_media(meta, row.get("url"), permalink, body, kind)
                yield new_item(
                    source="reddit",
                    source_id=sid,
                    kind=kind,
                    title=row.get("title") or _title_from_permalink(permalink),
                    body=body,
                    url=url,
                    author=row.get("author") or "",
                    metadata=meta,
                )

    def _from_json(self, p: Path):
        try:
            data = json.loads(Path(p).read_text(encoding="utf-8", errors="ignore"))
        except (ValueError, OSError):
            return
        if isinstance(data, dict) and isinstance(data.get("data"), dict):
            children = data["data"].get("children", [])
        elif isinstance(data, list):
            children = data
        else:
            children = []
        for ch in children:
            item = child_to_item(ch)
            if item:
                yield item
