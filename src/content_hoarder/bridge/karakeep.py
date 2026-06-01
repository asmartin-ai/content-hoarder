"""Karakeep bridge (opt-in, deferred) — push 'keep' items to a STOCK Karakeep.

No-op unless ``KARAKEEP_BASE_URL`` and ``KARAKEEP_API_KEY`` are configured. Pushing
is idempotent via ``metadata.karakeep_id``. Karakeep is URL-centric with no custom
fields, so per-source metadata is folded into tags + a provenance note.
"""

from __future__ import annotations

import json
import urllib.request

from content_hoarder import config, db
from content_hoarder.models import parse_metadata


def is_configured() -> bool:
    return bool(config.get("KARAKEEP_BASE_URL") and config.get("KARAKEEP_API_KEY"))


def _payload(item: dict) -> dict:
    md = item.get("metadata")
    md = md if isinstance(md, dict) else parse_metadata(md)
    tags = [f"src:{item.get('source')}"]
    if md.get("subreddit"):
        tags.append(f"r/{md['subreddit']}")
    if md.get("channel"):
        tags.append(f"yt:{md['channel']}")
    for label in md.get("labels") or []:
        tags.append(str(label))
    note = f"via content-hoarder ({item.get('fullname')})"
    if item.get("url"):
        return {"type": "link", "url": item["url"], "title": item.get("title") or "",
                "tags": tags, "note": note}
    text = (item.get("title") or "")
    if item.get("body"):
        text = (text + "\n\n" + item["body"]).strip()
    return {"type": "text", "text": text or item.get("fullname"), "tags": tags, "note": note}


def _post(payload: dict):
    base = config.get("KARAKEEP_BASE_URL").rstrip("/")
    req = urllib.request.Request(
        f"{base}/api/v1/bookmarks",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {config.get('KARAKEEP_API_KEY')}",
            "Content-Type": "application/json",
            "User-Agent": config.get("USER_AGENT"),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


def _bookmark_id(resp) -> str | None:
    if not isinstance(resp, dict):
        return None
    if resp.get("id"):
        return resp["id"]
    inner = resp.get("bookmark")
    if isinstance(inner, dict) and inner.get("id"):
        return inner["id"]
    return None


def promote(conn, *, status: str = "keep", limit: int | None = None, dry_run: bool = False) -> dict:
    candidates = conn.execute(
        "SELECT COUNT(*) FROM items WHERE status=?", (status,)
    ).fetchone()[0]
    if not is_configured():
        return {"configured": False, "candidates": candidates, "pushed": 0, "skipped": 0}

    sql = "SELECT * FROM items WHERE status=?"
    params: list = [status]
    if limit:
        sql += " LIMIT ?"
        params.append(int(limit))
    rows = [db._row_to_public(r) for r in conn.execute(sql, params)]

    pushed = skipped = 0
    for item in rows:
        md = item["metadata"] if isinstance(item["metadata"], dict) else parse_metadata(item["metadata"])
        if md.get("karakeep_id"):
            skipped += 1
            continue
        if dry_run:
            pushed += 1
            continue
        kid = _bookmark_id(_post(_payload(item)))
        if kid:
            md["karakeep_id"] = kid
            conn.execute(
                "UPDATE items SET metadata=? WHERE fullname=?",
                (json.dumps(md, ensure_ascii=False), item["fullname"]),
            )
            pushed += 1
        else:
            skipped += 1
    conn.commit()
    return {"configured": True, "candidates": candidates, "pushed": pushed,
            "skipped": skipped, "dry_run": dry_run}
