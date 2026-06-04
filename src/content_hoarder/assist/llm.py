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


# ---------------------------------------------------------------------------
# Category auto-classifier (listenable / watch / wotagei / unknown)
# ---------------------------------------------------------------------------

_CLASSIFY_SYSTEM = (
    "You categorize a saved video into exactly one processing area for someone with ADHD:\n"
    "- listenable: audio-first (music, albums, podcasts, long talks) — playable in the background.\n"
    "- watch: needs your eyes (tutorials, vlogs, visual demos, short clips).\n"
    "- wotagei: an idol-event glowstick/penlight performance.\n"
    "- unknown: genuinely unclear.\n"
    'Respond with ONLY compact JSON: {"category":"listenable"|"watch"|"wotagei"|"unknown","reason":"<short>"}.'
)


def _parse_category(text: str) -> dict | None:
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
    except (ValueError, TypeError):
        return None
    from content_hoarder.categorize import VALID_CATEGORIES  # lazy (avoid import cycle)

    cat = str(obj.get("category", "")).strip().lower()
    if cat not in VALID_CATEGORIES:
        cat = "unknown"
    return {"category": cat, "reason": str(obj.get("reason", ""))[:200]}


def _fireworks_chat(model: str | None = None, timeout: int = 60):
    """Return a ``chat(messages)->str`` backed by Fireworks (OpenAI-compatible + Bearer auth).

    Lets the bulk classifier run on a cloud model when the local GPU is unavailable, or for
    better quality on the genuinely-ambiguous tail. Keyed by ``FIREWORKS_API_KEY``; the model
    defaults to the adopted single-shot implementer (qwen3.7-plus) and is overridable via
    ``FIREWORKS_CLASSIFY_MODEL``.
    """
    key = config.get("FIREWORKS_API_KEY")
    base = (config.get("FIREWORKS_BASE_URL")
            or "https://api.fireworks.ai/inference/v1").rstrip("/")
    model = (model or config.get("FIREWORKS_CLASSIFY_MODEL")
             or "accounts/fireworks/models/qwen3p7-plus")

    def chat(messages: list[dict]) -> str:
        # reasoning is pure waste for a one-label classification — the model knows the
        # answer immediately. Disabling it cut output ~30x (~$9 -> <$1 on the 7.5k tail)
        # and ~4x latency; verified on qwen3.7-plus (it honors reasoning_effort; /no_think
        # is silently ignored). A model that rejects this field would 400 — override the
        # model only to one that supports it.
        payload = {"model": model, "messages": messages, "temperature": 0.2,
                   "stream": False, "reasoning_effort": "none"}
        req = urllib.request.Request(
            base + "/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={"Content-Type": "application/json",
                     "Authorization": "Bearer " + key,
                     "User-Agent": config.get("USER_AGENT")},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return data["choices"][0]["message"]["content"]

    return chat


def _resolve_chat(backend: str, chat):
    """Pick a chat callable for ``backend``, or None when that backend is unconfigured.

    An explicit ``chat`` (offline tests / a custom backend) is honored as long as the
    backend is configured — the per-backend availability check stays the kill-switch, so an
    unconfigured backend never silently runs the injected double.
    """
    if backend == "fireworks":
        if not config.get("FIREWORKS_API_KEY"):
            return None
        return chat or _fireworks_chat()
    if not is_available():  # local (default): needs LLM_BASE_URL
        return None
    return chat or _chat


def classify(item: dict, *, chat=None, backend: str = "local") -> dict | None:
    """LLM category for one item -> {'category','reason'} or None if unavailable/failed."""
    use = _resolve_chat(backend, chat)
    if use is None:
        return None
    try:
        text = use([
            {"role": "system", "content": _CLASSIFY_SYSTEM},
            {"role": "user", "content": _item_text(item)},
        ])
    except Exception:
        return None
    return _parse_category(text)


def classify_source(conn, source: str = "youtube", *, limit=None, retry: bool = False,
                    chat=None, backend: str = "local") -> dict:
    """LLM-classify a source's items into ``metadata.category`` (+ ``category_source='llm'``).

    By default re-classifies only the items heuristics could not resolve — those with no
    category OR ``category='unknown'`` (the heuristic's give-up bucket) — so confident
    heuristic/manual categories are left intact; ``retry`` re-does every item. The
    processing-area tag is mirrored (like ``db.set_category``) so LLM-classified items
    filter identically in the tag rail. Returns counts. No-op + ``available: False`` when
    the chosen backend is unconfigured.
    """
    from content_hoarder import db  # lazy
    from content_hoarder.categorize import VALID_CATEGORIES  # lazy

    if _resolve_chat(backend, chat) is None:
        return {"available": False, "classified": 0}
    where = ["source = ?"]
    params: list = [source]
    if not retry:
        # Target the unresolved tail: NULL (never categorized) or an explicit 'unknown'.
        where.append("(json_extract(metadata, '$.category') IS NULL "
                     "OR json_extract(metadata, '$.category') = 'unknown')")
    sql = "SELECT * FROM items WHERE " + " AND ".join(where) + " ORDER BY last_seen_utc DESC"
    if limit:
        sql += " LIMIT ?"
        params.append(int(limit))
    rows = [db._row_to_public(r) for r in conn.execute(sql, params).fetchall()]
    counts = {c: 0 for c in VALID_CATEGORIES}
    classified = 0
    for it in rows:
        res = classify(it, chat=chat, backend=backend)
        if res is None:
            continue
        cat = res["category"]
        counts[cat] = counts.get(cat, 0) + 1
        classified += 1
        md = db.metadata_with_category_tag(it["metadata"], cat)  # mirrors the processing tag
        md["category_source"] = "llm"
        conn.execute("UPDATE items SET metadata=? WHERE fullname=?",
                     (json.dumps(md, ensure_ascii=False), it["fullname"]))
        if classified % 250 == 0:
            conn.commit()  # checkpoint long bulk runs so a mid-run failure keeps progress
    conn.commit()
    return {"available": True, "classified": classified, "scanned": len(rows),
            "by_category": counts}
