"""Hacker News connector (Materialistic app DB / id list / favorites HTML).

The Materialistic Android app stores saved stories in a ``favorite`` table inside
``Materialistic.db`` (columns include itemid/url/title/time). On a non-rooted phone
you get this file via ``adb backup`` (see docs/IMPORTING.md), NOT ``adb pull``.

DB rows usually carry title + url already; ``enrich()`` can still fill score/etc.
from the free, no-auth HN Firebase API.
"""

from __future__ import annotations

import json
import re
import sqlite3
import time
import urllib.request
from pathlib import Path

from content_hoarder.connectors.base import BaseConnector
from content_hoarder.models import new_item

_ITEM_ID = re.compile(r"item\?id=(\d+)")
_ATHING = re.compile(r"class=['\"]athing[^'\"]*['\"][^>]*id=['\"](\d+)['\"]")
_BARE_ID = re.compile(r"\b(\d{4,})\b")
_FIREBASE = "https://hacker-news.firebaseio.com/v0/item/{}.json"
_FAVORITE_TABLES = ("favorite", "favorites", "saved")


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
