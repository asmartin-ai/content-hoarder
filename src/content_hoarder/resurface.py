"""Resurfacing-card candidates (Epic 20; docs/resurfacing-card-design.md, LOCKED 2026-06-11).

One ambient card per day asking a curious question about a CLUSTER of old saves —
never a count, never a queue. Candidates come from knowledge buckets only
(``categorize.RESURFACE_TAGS`` / ``RESURFACE_SUBREDDITS``); dismissal state lives in
``settings.resurfacing_state`` as JSON — no schema change. Hard rules baked in:
event-based (computed on request, never scheduled), rationed to one card per day,
"Not now" goes silent for a no-renag window, "Let it go" decays the cluster
reversibly and never re-asks.
"""

from __future__ import annotations

import json
import random
import sqlite3
import time

from content_hoarder import categorize, db

STATE_KEY = "resurfacing_state"
NO_RENAG_DAYS = 30        # "Not now" silence window (user-locked 2026-06-11)
NEVER_UTC = 1 << 60       # "Let it go" never re-asks
MIN_CLUSTER = 10          # meaningful volume — below this a question reads as noise
DORMANT_DAYS = 90         # rank-2 candidates need real dormancy
REACTIVATION_DAYS = 14    # rank-1: saved into a dormant cluster this recently
FALLBACK_SCORE = 0.0245   # corpus processed-rate prior; used while the Epic 10
                          # triage-score engine is parked (degrades to dormancy-only)


def _state(conn: sqlite3.Connection) -> dict:
    try:
        return json.loads(db.get_setting(conn, STATE_KEY) or "{}")
    except ValueError:
        return {}


def _save_state(conn: sqlite3.Connection, state: dict) -> None:
    db.set_setting(conn, STATE_KEY, json.dumps(state))


def clusters() -> list[tuple[str, str | None, str | None]]:
    """All candidate clusters as ``(key, tag, subreddit)`` — key is ``tag:X`` or
    ``subreddit:Y``. The curated lists live with the vocab in categorize.py."""
    out = [(f"tag:{t}", t, None) for t in categorize.RESURFACE_TAGS]
    out += [(f"subreddit:{s}", None, s) for s in categorize.RESURFACE_SUBREDDITS]
    return out


def _parse(cluster: str) -> tuple[str | None, str | None]:
    """Validate a client-supplied cluster key against the curated list (a decay must
    never be drivable for an arbitrary tag/subreddit through the web layer)."""
    for key, tag, sub in clusters():
        if key == cluster:
            return tag, sub
    raise ValueError(f"unknown cluster: {cluster!r}")


def _where(tag: str | None, sub: str | None) -> tuple[str, list]:
    if tag:
        return ("EXISTS (SELECT 1 FROM json_each(metadata, '$.tags') WHERE value = ?)",
                [tag])
    return ("lower(json_extract(metadata, '$.subreddit')) = ?", [sub.lower()])


def candidate(conn: sqlite3.Connection, *, now: int | None = None,
              rng=None) -> dict | None:
    """Pick today's ONE cluster card, or None (the HTTP layer answers 204).

    Ranking per the locked design: reactivation signal first (interest is episodic —
    the user saved into a ≥90d-dormant cluster within the last 14d), then mean
    triage_score × months dormant (mean degrades to a corpus prior while the score
    engine is parked), tie-broken randomly among the top 3 so repeat days vary.
    A successful pick marks the day as served — at most one card per day.
    """
    now = int(now or time.time())
    rng = rng or random
    state = _state(conn)
    today = time.strftime("%Y-%m-%d", time.localtime(now))
    if state.get("_served_on") == today:
        return None

    scored = []
    for key, tag, sub in clusters():
        st = state.get(key) or {}
        if int(st.get("dismissed_until") or 0) > now:
            continue
        w, p = _where(tag, sub)
        count, last_added, mean_score = conn.execute(
            f"SELECT COUNT(*), MAX(first_seen_utc), "
            f"AVG(json_extract(metadata, '$.triage_score')) "
            f"FROM items WHERE status='inbox' AND {w}", p,
        ).fetchone()
        last_added = last_added or 0
        if count < MIN_CLUSTER:
            continue
        # reactivation: the newest save is recent AND the cluster was dormant before it
        prior = conn.execute(
            f"SELECT MAX(first_seen_utc) FROM items WHERE status='inbox' AND {w} "
            f"AND first_seen_utc < ?", p + [now - REACTIVATION_DAYS * 86400],
        ).fetchone()[0] or 0
        reactivated = (last_added >= now - REACTIVATION_DAYS * 86400
                       and 0 < prior <= now - DORMANT_DAYS * 86400)
        dormant_days = (now - last_added) / 86400
        if not reactivated and dormant_days < DORMANT_DAYS:
            continue  # neither reactivated nor dormant — not a candidate
        months = max(dormant_days / 30.0, 1.0)
        propensity = mean_score if mean_score is not None else FALLBACK_SCORE
        scored.append((1 if reactivated else 0, propensity * months,
                       key, tag, sub, count, last_added, reactivated))

    if not scored:
        return None
    scored.sort(key=lambda t: (t[0], t[1]), reverse=True)
    pick = rng.choice(scored[:3])
    _, _, key, tag, sub, count, last_added, reactivated = pick

    w, p = _where(tag, sub)
    sample = [
        {"fullname": r[0], "title": r[1], "thumbnail": r[2]}
        for r in conn.execute(
            f"SELECT fullname, title, json_extract(metadata, '$.thumbnail') "
            f"FROM items WHERE status='inbox' AND {w} "
            f"ORDER BY first_seen_utc DESC LIMIT 3", p,
        ).fetchall()
    ]
    state.setdefault(key, {})["last_shown"] = now
    state["_served_on"] = today
    _save_state(conn, state)
    return {
        "cluster": key,
        "label": f"r/{sub}" if sub else tag,
        "count": count,
        "last_added_utc": last_added,
        "reactivated": reactivated,
        "sample": sample,
        "query": f"{'subreddit' if sub else 'tag'}:{sub or tag} status:inbox",
    }


def dismiss(conn: sqlite3.Connection, cluster: str, *,
            days: int = NO_RENAG_DAYS, now: int | None = None) -> None:
    """"Not now": silently hide the cluster for the no-renag window. Never mentioned
    again — no return payload by design."""
    _parse(cluster)
    now = int(now or time.time())
    state = _state(conn)
    state.setdefault(cluster, {})["dismissed_until"] = now + days * 86400
    _save_state(conn, state)


def letgo(conn: sqlite3.Connection, cluster: str, *, now: int | None = None) -> dict:
    """"Let it go": one-tap reversible decay of the cluster's inbox items (a rolling
    wave, no label — `is:decayed`, not `is:swept`) and never re-ask. The standard
    undo toast is the only confirmation (user decision: extra confirms are exactly
    the friction to avoid)."""
    tag, sub = _parse(cluster)
    res = db.decay(conn, tags=[tag] if tag else None,
                   subreddits=[sub] if sub else None, apply=True)
    state = _state(conn)
    state.setdefault(cluster, {})["dismissed_until"] = NEVER_UTC
    _save_state(conn, state)
    return {"cluster": cluster, "total": res["total"], "decayed_at": res["decayed_at"]}


def undo_letgo(conn: sqlite3.Connection, cluster: str, decayed_at: int) -> dict:
    """Reverse a ``letgo`` wave (toast UNDO): undecay exactly that stamp and make the
    cluster eligible again."""
    tag, sub = _parse(cluster)  # validates; tag/sub unused — the stamp selects rows
    res = db.undecay(conn, decayed_after=int(decayed_at),
                     decayed_before=int(decayed_at) + 1, apply=True)
    state = _state(conn)
    if cluster in state:
        state[cluster].pop("dismissed_until", None)
        _save_state(conn, state)
    return {"cluster": cluster, "total": res["total"]}
