import json
import time

from content_hoarder import db

KNOWLEDGE_TAGS = ("coding", "japan", "science", "tips")


def _load_state(conn):
    raw = db.get_setting(conn, "resurfacing_state", "")
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return {}


def _save_state(conn, state):
    db.set_setting(conn, "resurfacing_state", json.dumps(state))


def pick_candidate(conn, *, now=None, dormant_days=90, min_items=3):
    if now is None:
        now = int(time.time())
    state = _load_state(conn)
    cutoff = now - dormant_days * 86400

    best = None
    for tag in KNOWLEDGE_TAGS:
        tag_state = state.get(tag, {})
        dismissed_until = tag_state.get("dismissed_until", 0)
        if dismissed_until > now:
            continue
        items = db.search_items(conn, "", status="inbox", tags=[tag], limit=10000)
        if len(items) < min_items:
            continue
        items_sorted = sorted(
            items, key=lambda x: x.get("created_utc", 0), reverse=True
        )
        newest_created = items_sorted[0].get("created_utc", 0)
        if newest_created > cutoff:
            continue
        if best is None or len(items) > best["count"]:
            best = {"cluster": tag, "count": len(items), "_sorted": items_sorted}

    if best is None:
        return None

    sample = [item.get("title", "") or "" for item in best["_sorted"][:3]]
    return {"cluster": best["cluster"], "count": best["count"], "sample": sample}


def dismiss(conn, cluster, *, now=None, days=30):
    if now is None:
        now = int(time.time())
    state = _load_state(conn)
    tag_state = state.get(cluster, {})
    tag_state["dismissed_until"] = now + days * 86400
    state[cluster] = tag_state
    _save_state(conn, state)
