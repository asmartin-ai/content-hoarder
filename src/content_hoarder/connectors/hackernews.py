"""Hacker News connector (Materialistic app DB / id list / favorites HTML).

The Materialistic Android app stores saved stories in a ``favorite`` table inside
``Materialistic.db`` (columns include itemid/url/title/time). On a non-rooted phone
you get this file via ``adb backup`` (see docs/IMPORTING.md), NOT ``adb pull``.

DB rows usually carry title + url already; ``enrich()`` can still fill score/etc.
from the free, no-auth HN Firebase API.
"""

from __future__ import annotations

import html as _html
import json
import re
import sqlite3
import time
import urllib.parse
import urllib.request
from pathlib import Path

from content_hoarder import _http
from content_hoarder.connectors.base import BaseConnector
from content_hoarder.models import new_item

_ITEM_ID = re.compile(r"item\?id=(\d+)")
_ATHING = re.compile(r"class=['\"]athing[^'\"]*['\"][^>]*id=['\"](\d+)['\"]")
_BARE_ID = re.compile(r"\b(\d{4,})\b")
_FIREBASE = "https://hacker-news.firebaseio.com/v0/item/{}.json"
_FAVORITE_TABLES = ("favorite", "favorites", "saved")

# Open Graph thumbnail extraction (Epic 15 P3). We parse only the document <head>
# from a capped slice of the body, preferring og:image and falling back to
# twitter:image. Attribute order varies wildly across sites, so we tokenize each
# <meta> tag's attributes rather than matching a fixed property→content order.
_META_TAG = re.compile(r"<meta\b[^>]*>", re.IGNORECASE)
_META_ATTR = re.compile(
    r"""([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))""")
_OG_KEYS = ("og:image", "og:image:url", "og:image:secure_url",
            "twitter:image", "twitter:image:src")
_OG_FETCH_CAP = 262144  # bytes of body to parse for <head> (256 KiB is plenty)


def _is_hn_thread(url: str) -> bool:
    return "news.ycombinator.com/item?id=" in (url or "").lower()


def _og_image(html_text: str, base_url: str) -> str:
    """First og:image (then twitter:image) in ``html_text``, absolutized against
    ``base_url``. "" when none is present."""
    found: dict[str, str] = {}
    for tag in _META_TAG.findall(html_text):
        attrs: dict[str, str] = {}
        for m in _META_ATTR.finditer(tag):
            attrs[m.group(1).lower()] = m.group(2) or m.group(3) or m.group(4) or ""
        key = (attrs.get("property") or attrs.get("name") or "").lower()
        content = (attrs.get("content") or "").strip()
        if key in _OG_KEYS and content:
            found.setdefault(key, content)
    for k in _OG_KEYS:
        if found.get(k):
            return urllib.parse.urljoin(base_url, _html.unescape(found[k]))
    return ""


def _favorites_table(path: Path):
    """Return the name of the favorites/saved table in a Materialistic DB, or None."""
    try:
        con = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    except sqlite3.Error:
        return None
    try:
        names = {r[0].lower(): r[0] for r in
                 con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for cand in _FAVORITE_TABLES:
            if cand in names:
                return names[cand]
        return None
    except sqlite3.Error:
        return None
    finally:
        con.close()


def _hn_url(sid) -> str:
    return f"https://news.ycombinator.com/item?id={sid}"


class HNConnector(BaseConnector):
    id = "hackernews"
    label = "Hacker News"
    badge_color = "#ff6600"

    def can_import(self, path: Path) -> bool:
        p = Path(path)
        if not p.is_file():
            return False
        suf = p.suffix.lower()
        if suf in (".db", ".sqlite", ".sqlite3"):
            return _favorites_table(p) is not None
        if suf in (".html", ".htm"):
            try:
                return "news.ycombinator.com" in p.read_text("utf-8", errors="ignore")[:16384]
            except OSError:
                return False
        if suf == ".json":
            try:
                data = json.loads(p.read_text("utf-8", errors="ignore"))
            except (ValueError, OSError):
                return False
            return bool(data) and isinstance(data, list) and all(
                isinstance(x, (int, str)) for x in data[:20]
            )
        return False

    def import_file(self, path: Path):
        p = Path(path)
        suf = p.suffix.lower()
        if suf in (".db", ".sqlite", ".sqlite3"):
            yield from self._from_db(p)
            return

        ids: list[str] = []
        if suf in (".html", ".htm"):
            text = p.read_text("utf-8", errors="ignore")
            ids = _ITEM_ID.findall(text) or _ATHING.findall(text)
        elif suf == ".json":
            try:
                data = json.loads(p.read_text("utf-8", errors="ignore"))
                ids = [str(x) for x in data] if isinstance(data, list) else []
            except (ValueError, OSError):
                ids = []
        elif suf == ".txt":
            ids = _BARE_ID.findall(p.read_text("utf-8", errors="ignore"))

        seen = set()
        for raw in ids:
            sid = str(raw).strip()
            if not sid or sid in seen:
                continue
            seen.add(sid)
            yield new_item(source="hackernews", source_id=sid, kind="story",
                           title="", url=_hn_url(sid), metadata={"hn_url": _hn_url(sid)})

    def _from_db(self, p: Path):
        try:
            con = sqlite3.connect(f"file:{p.as_posix()}?mode=ro", uri=True)
        except sqlite3.Error:
            return
        con.row_factory = sqlite3.Row
        seen: set = set()
        try:
            table = _favorites_table(p)
            if table:
                cols = {r[1].lower(): r[1] for r in con.execute(f"PRAGMA table_info({table})")}
                id_c = next((cols[c] for c in ("itemid", "item_id", "story_id", "id") if c in cols),
                            cols.get("_id"))
                title_c, url_c = cols.get("title"), cols.get("url")
                time_c = cols.get("time") or cols.get("timestamp") or cols.get("created")
                for row in con.execute(f"SELECT * FROM {table}"):
                    d = dict(row)
                    sid = str(d.get(id_c)) if id_c and d.get(id_c) is not None else ""
                    url = (d.get(url_c) or "") if url_c else ""
                    if not sid.isdigit() and url:
                        m = _ITEM_ID.search(url)
                        if m:
                            sid = m.group(1)
                    if not sid or sid in seen:
                        continue
                    seen.add(sid)
                    ts = int(d.get(time_c) or 0) if time_c else 0
                    if ts > 10 ** 12:   # Materialistic stores the saved time in MILLISECONDS
                        ts //= 1000
                    yield new_item(
                        source="hackernews", source_id=sid, kind="story",
                        title=(d.get(title_c) or "") if title_c else "",
                        url=url or _hn_url(sid),
                        created_utc=ts, saved_utc=ts,
                        metadata={"hn_url": _hn_url(sid), "hn_list": "saved"},
                    )
            # Materialistic also keeps a `read` history table (itemid only) — import as bare
            # items (titles arrive via enrich), tagged hn_list=read so they stay separable.
            has_read = con.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='read'").fetchone()
            has_itemid = has_read and any(
                r[1].lower() == "itemid" for r in con.execute("PRAGMA table_info('read')"))
            if has_itemid:
                for row in con.execute("SELECT itemid FROM read"):
                    sid = str(row[0]) if row[0] is not None else ""
                    if not sid.isdigit() or sid in seen:
                        continue
                    seen.add(sid)
                    yield new_item(
                        source="hackernews", source_id=sid, kind="story",
                        title="", url=_hn_url(sid),
                        status="archived",  # read-but-not-saved is history, not inbox triage
                        metadata={"hn_url": _hn_url(sid), "hn_list": "read"},
                    )
        except sqlite3.Error:
            return
        finally:
            con.close()

    # -- enrichment --------------------------------------------------------

    def enrich(self, items: list[dict]) -> list[dict]:
        out = []
        for it in items:
            sid = it.get("source_id")
            if not sid:
                continue
            data = self._fetch(sid)
            if not data:
                continue
            meta = {"hn_url": _hn_url(sid)}
            if data.get("score") is not None:
                meta["score"] = data["score"]
            if data.get("descendants") is not None:
                meta["descendants"] = data["descendants"]
            # Article thumbnail (Epic 15 P3): fetch the linked story's og:image, but
            # only for an external article and only once — merge_upsert keeps a prior
            # og_image, so re-enriching (`--all`) won't refetch article pages.
            art = (data.get("url") or it.get("url") or "").strip()
            existing = it.get("metadata") or {}
            if isinstance(existing, str):  # rows can arrive with metadata still a JSON string
                try:
                    existing = json.loads(existing)
                except (ValueError, TypeError):
                    existing = {}
            if not isinstance(existing, dict):
                existing = {}
            if art and not _is_hn_thread(art) and not existing.get("og_image"):
                og = self._fetch_og_image(art)
                if og:
                    meta["og_image"] = og
            out.append(
                new_item(
                    source="hackernews", source_id=str(sid),
                    kind=data.get("type") or "story",
                    title=data.get("title") or it.get("title") or "",
                    body=data.get("text") or "",
                    url=data.get("url") or it.get("url") or _hn_url(sid),
                    author=data.get("by") or "",
                    created_utc=int(data.get("time") or 0),
                    hydrated_at=int(time.time()),
                    metadata=meta, raw=data,
                )
            )
        return out

    def _fetch(self, sid):
        from content_hoarder import config

        try:
            req = urllib.request.Request(
                _FIREBASE.format(sid), headers={"User-Agent": config.get("USER_AGENT")}
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception:
            return None

    def _fetch_og_image(self, url: str) -> str:
        """Best-effort og:image for an external article URL; "" on any failure
        (network, non-HTML, no tag) so a flaky article never breaks the enrich pass."""
        from content_hoarder import config

        try:
            _status, headers, raw = _http.request(
                url, timeout=10.0, retries=1, backoff=2.0, jitter=True,
                user_agent=config.get("USER_AGENT"),
                headers={"Accept": "text/html,application/xhtml+xml"},
            )
        except _http.HttpError:
            return ""
        ctype = next((v for k, v in headers.items() if k.lower() == "content-type"), "")
        if "html" not in ctype.lower():
            return ""
        text = raw[:_OG_FETCH_CAP].decode("utf-8", errors="replace")
        return _og_image(text.split("</head>", 1)[0], url)
