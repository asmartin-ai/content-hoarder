"""Hacker News connector (Materialistic app DB / id list / favorites HTML).

Imports produce sparse stubs keyed ``hackernews:<id>``; ``enrich()`` fills
title/url/author/score from the free, no-auth HN Firebase API.
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


def _has_saved_table(path: Path) -> bool:
    try:
        con = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    except sqlite3.Error:
        return False
    try:
        names = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        return "saved" in names
    except sqlite3.Error:
        return False
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
            return _has_saved_table(p)
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
        ids: list[str] = []
        if suf in (".db", ".sqlite", ".sqlite3"):
            ids = self._db_ids(p)
        elif suf in (".html", ".htm"):
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
            yield new_item(
                source="hackernews",
                source_id=sid,
                kind="story",
                title="",
                url=_hn_url(sid),
                metadata={"hn_url": _hn_url(sid)},
            )

    def _db_ids(self, p: Path) -> list[str]:
        try:
            con = sqlite3.connect(f"file:{p.as_posix()}?mode=ro", uri=True)
        except sqlite3.Error:
            return []
        try:
            cols = [r[1] for r in con.execute("PRAGMA table_info(saved)")]
            if not cols:
                return []
            idcol = next(
                (c for c in cols if c.lower() in ("itemid", "id", "_id", "item_id", "story_id")),
                cols[0],
            )
            return [str(r[0]) for r in con.execute(f"SELECT {idcol} FROM saved") if r[0] is not None]
        except sqlite3.Error:
            return []
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
                    source="hackernews",
                    source_id=str(sid),
                    kind=data.get("type") or "story",
                    title=data.get("title") or it.get("title") or "",
                    body=data.get("text") or "",
                    url=data.get("url") or _hn_url(sid),
                    author=data.get("by") or "",
                    created_utc=int(data.get("time") or 0),
                    hydrated_at=int(time.time()),
                    metadata=meta,
                    raw=data,
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
