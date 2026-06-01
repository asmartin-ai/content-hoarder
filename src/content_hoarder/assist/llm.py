"""Optional local-LLM assist: keep/skip suggestion + auto-tags.

Talks to an OpenAI-compatible endpoint (LM Studio / Ollama) via stdlib urllib.
Entirely optional — every function degrades to ``None`` when unavailable, and a
suggestion NEVER changes an item's status on its own (it only annotates metadata).
"""

from __future__ import annotations

import json
import re
import urllib.request

from content_hoarder import config
from content_hoarder.models import parse_metadata

_SYSTEM = (
    "You help someone with ADHD triage a backlog of saved content. For the given item, "
    "decide whether it is worth KEEPING or can be SKIPPED (archived), and propose 1-5 short "
    "lowercase topical tags. Be decisive and brief. Respond with ONLY compact JSON of the form "
    '{"verdict":"keep"|"skip","reason":"<one short sentence>","tags":["tag1","tag2"]}.'
)


def is_available() -> bool:
    return bool(config.get("LLM_BASE_URL"))


def _chat(messages: list[dict], timeout: int = 60) -> str:
    base = config.get("LLM_BASE_URL").rstrip("/")
    payload = {"messages": messages, "temperature": 0.2, "stream": False}
    model = config.get("LLM_MODEL")
    if model:
        payload["model"] = model
    req = urllib.request.Request(
        base + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "User-Agent": config.get("USER_AGENT")},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data["choices"][0]["message"]["content"]


def _item_text(item: dict) -> str:
    md = item.get("metadata")
    md = md if isinstance(md, dict) else parse_metadata(md)
    bits = ["Source: " + str(item.get("source", "")), "Title: " + str(item.get("title", ""))]
    if item.get("author"):
        bits.append("Author: " + str(item["author"]))
    if md.get("subreddit"):
        bits.append("Subreddit: " + str(md["subreddit"]))
    if md.get("channel"):
        bits.append("Channel: " + str(md["channel"]))
    if item.get("url"):
        bits.append("URL: " + str(item["url"]))
    body = (item.get("body") or "")[:500]
    if body:
        bits.append("Body: " + body)
    return "\n".join(bits)


def _parse(text: str) -> dict | None:
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
    except (ValueError, TypeError):
        return None
    verdict = str(obj.get("verdict", "")).strip().lower()
    if verdict not in ("keep", "skip"):
        verdict = "keep"
    tags = [str(t).strip().lower() for t in (obj.get("tags") or []) if str(t).strip()][:5]
    return {"verdict": verdict, "reason": str(obj.get("reason", ""))[:200], "tags": tags}


def suggest(item: dict) -> dict | None:
    """Return {'verdict','reason','tags'} for an item, or None if unavailable/failed."""
    if not is_available():
        return None
    try:
        text = _chat([
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": _item_text(item)},
        ])
    except Exception:
        return None
    return _parse(text)


def suggest_and_store(conn, fullname: str) -> dict | None:
    """Compute a suggestion for one item and annotate ``metadata.llm`` (no status change)."""
    from content_hoarder import db

    item = db._public_by_fullname(conn, fullname)
    if item is None:
        return None
    suggestion = suggest(item)
    if suggestion is None:
        return None
    md = item["metadata"] if isinstance(item["metadata"], dict) else parse_metadata(item["metadata"])
    md["llm"] = suggestion
    conn.execute(
        "UPDATE items SET metadata=? WHERE fullname=?",
        (json.dumps(md, ensure_ascii=False), fullname),
    )
    conn.commit()
    return suggestion


def suggest_inbox(conn, *, source: str | None = None, limit: int = 20) -> dict:
    """Annotate a batch of inbox items with suggestions. Returns counts."""
    if not is_available():
        return {"available": False, "annotated": 0}
    sql = "SELECT fullname FROM items WHERE status='inbox'"
    params: list = []
    if source:
        sql += " AND source=?"
        params.append(source)
    sql += " LIMIT ?"
    params.append(int(limit))
    fullnames = [r[0] for r in conn.execute(sql, params)]
    annotated = sum(1 for fn in fullnames if suggest_and_store(conn, fn) is not None)
    return {"available": True, "annotated": annotated, "scanned": len(fullnames)}
