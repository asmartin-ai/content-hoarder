"""Export items out to other tools (Obsidian vault as Markdown; CSV/JSON lists)."""

from __future__ import annotations

import csv
import datetime
import io
import re
from pathlib import Path

from content_hoarder import db
from content_hoarder.models import parse_metadata

# Flat-record vocabulary for the CSV/JSON list exports. Re-save-elsewhere oriented:
# permalink is the key field for migrating reddit saves to another account.
EXPORT_FIELDS = ("fullname", "source", "kind", "status", "title", "url", "permalink",
                 "subreddit", "tags", "score", "created_utc")


def export_records(rows: list[dict]) -> list[dict]:
    """Flatten search_items/public rows into stable EXPORT_FIELDS records."""
    out = []
    for it in rows:
        md = it.get("metadata")
        md = md if isinstance(md, dict) else parse_metadata(md)
        out.append({
            "fullname": it.get("fullname", ""),
            "source": it.get("source", ""),
            "kind": it.get("kind", ""),
            "status": it.get("status", ""),
            "title": it.get("title") or "",
            "url": it.get("url") or "",
            "permalink": md.get("permalink") or "",
            "subreddit": md.get("subreddit") or "",
            "tags": "|".join(md.get("tags") or []),
            "score": md.get("score"),
            "created_utc": int(it.get("created_utc") or 0),
        })
    return out


def to_csv(records: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=EXPORT_FIELDS, lineterminator="\n")
    w.writeheader()
    w.writerows(records)
    return buf.getvalue()


def _slug(text: str) -> str:
    text = re.sub(r"[^\w\s-]", "", (text or "")).strip().lower()
    text = re.sub(r"[\s_-]+", "-", text)
    return text[:80] or "note"


def _frontmatter(item: dict, md: dict) -> str:
    lines = ["---"]
    title = (item.get("title") or item.get("fullname") or "").replace('"', "'")
    lines.append('title: "' + title + '"')
    lines.append("source: " + str(item.get("source", "")))
    if item.get("url"):
        lines.append("url: " + item["url"])
    created = int(item.get("created_utc") or 0)
    if created:
        d = datetime.datetime.fromtimestamp(created, datetime.timezone.utc).date()
        lines.append("date: " + d.isoformat())
    tags = list(md.get("tags") or [])
    if md.get("subreddit"):
        tags.append("r/" + str(md["subreddit"]))
    for lbl in md.get("labels") or []:
        tags.append(str(lbl))
    if tags:
        lines.append("tags:")
        for t in dict.fromkeys(tags):
            lines.append("  - " + str(t))
    lines.append("ch_fullname: " + str(item.get("fullname", "")))
    lines.append("---")
    return "\n".join(lines)


def export_item(item: dict, vault_dir) -> Path:
    """Write one item as a Markdown note (frontmatter + body) into ``vault_dir``."""
    vault = Path(vault_dir)
    vault.mkdir(parents=True, exist_ok=True)
    md = item.get("metadata")
    md = md if isinstance(md, dict) else parse_metadata(md)
    title = item.get("title") or item.get("fullname")
    content = _frontmatter(item, md) + "\n\n# " + str(title) + "\n\n" + (item.get("body") or "") + "\n"

    base = _slug(str(title))
    path = vault / (base + ".md")
    n = 2
    while path.exists():
        path = vault / (base + "-" + str(n) + ".md")
        n += 1
    path.write_text(content, encoding="utf-8")
    return path


def obsidian_export(conn, vault_dir, status: str = "keep") -> dict:
    """Export all items with the given status to a vault. Returns counts."""
    rows = [db._row_to_public(r) for r in conn.execute(
        "SELECT * FROM items WHERE status=?", (status,))]
    for row in rows:
        export_item(row, vault_dir)
    return {"exported": len(rows), "vault": str(vault_dir)}
