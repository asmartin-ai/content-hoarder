"""Learned triage score: a transparent per-feature processed-rate model (Epic 10).

No ML dependencies, fully offline. For every categorical feature value (source,
subreddit, channel, kind, media type, category, age bucket) the model stores the
smoothed rate at which the user has historically PROCESSED items carrying it —
processed meaning a HUMAN status change (done/keep/archived), never a machine sweep:
rows carrying decay stamps/labels are excluded from training so bulk decay can't
poison the signal. An item's score combines its features' rates in log-odds space,
and the top-contributing features are kept as a human-readable "why".

Honest caveats (by design, surfaced rather than hidden):
- Inbox items are "not processed YET", not rejected — this is positive/unlabeled
  learning, so the score is a relative ranking propensity, not a calibrated
  probability.
- Older items have had more time to be processed; the age-bucket features absorb
  some of that bias and make it visible in the why-breakdown.
"""
from __future__ import annotations

import json
import math
import time

from content_hoarder import db
from content_hoarder.models import parse_metadata

MODEL_SETTING_KEY = "triage_model"

# (threshold_seconds, label) — first match wins; age = created_utc, else first_seen_utc.
_AGE_BUCKETS = (
    (30 * 86400, "<30d"),
    (90 * 86400, "30-90d"),
    (365 * 86400, "90d-1y"),
    (2 * 365 * 86400, "1-2y"),
    (4 * 365 * 86400, "2-4y"),
    (float("inf"), ">=4y"),
)

_PROCESSED = ("done", "keep", "archived")


def _age_bucket(age_secs: float) -> str:
    for limit, label in _AGE_BUCKETS:
        if age_secs < limit:
            return label
    return ">=4y"


def extract_features(row: dict, md: dict, *, now: int | None = None) -> list[str]:
    """Categorical feature strings for one item. ``row`` needs source/kind/created_utc/
    first_seen_utc; ``md`` is the parsed metadata dict.

    source+kind are ONE composite feature (``sk:reddit/post``): for single-kind sources
    (HN stories, firefox tabs) separate source: and kind: features are perfectly
    correlated and a naive log-odds sum would double-count them — the first live-corpus
    rehearsal showed exactly that (HN items inflated to 0.96)."""
    now = now if now is not None else int(time.time())
    feats = [f"sk:{row.get('source') or '?'}/{row.get('kind') or '?'}"]
    sub = (md.get("subreddit") or "").lower()
    if sub:
        feats.append(f"sub:{sub}")
    chan = (md.get("channel") or "").lower()
    if chan:
        feats.append(f"chan:{chan}")
    if md.get("media_type"):
        feats.append(f"media:{md['media_type']}")
    if md.get("category"):
        feats.append(f"cat:{md['category']}")
    created = int(row.get("created_utc") or 0)
    anchor = created if created > 0 else int(row.get("first_seen_utc") or now)
    feats.append(f"age:{_age_bucket(max(0, now - anchor))}")
    return feats


def _logit(p: float) -> float:
    p = min(max(p, 1e-4), 1 - 1e-4)
    return math.log(p / (1 - p))


def fit(conn, *, min_support: int = 20, alpha: float = 50.0) -> dict:
    """Fit the per-feature rate table from existing status history.

    ``alpha`` is the smoothing weight (pseudo-observations at the global prior);
    features seen fewer than ``min_support`` times are dropped (they'd contribute
    noise, and the model stays small enough for the settings table).
    """
    now = int(time.time())
    rows = conn.execute(
        "SELECT source, kind, status, created_utc, first_seen_utc, metadata FROM items "
        "WHERE json_extract(metadata, '$.decayed_at') IS NULL "
        "AND json_extract(metadata, '$.decay_label') IS NULL"
    ).fetchall()
    total = len(rows)
    processed = 0
    counts: dict[str, list[int]] = {}  # feat -> [n, k]
    for r in rows:
        md = parse_metadata(r["metadata"])
        pos = r["status"] in _PROCESSED
        processed += 1 if pos else 0
        for f in extract_features(dict(r), md, now=now):
            c = counts.setdefault(f, [0, 0])
            c[0] += 1
            c[1] += 1 if pos else 0
    prior = (processed / total) if total else 0.0
    features = {}
    for f, (n, k) in counts.items():
        if n < min_support:
            continue
        rate = (k + alpha * prior) / (n + alpha)
        features[f] = [n, k, round(rate, 6)]
    return {"version": 1, "fitted_utc": now, "trained_on": total, "processed": processed,
            "prior": round(prior, 6), "alpha": alpha, "min_support": min_support,
            "features": features}


def score_item(model: dict, feats: list[str]) -> tuple[float, list[str]]:
    """Score = log-odds combination of the item's known features; why = the top
    contributors as compact 'feature ×lift' strings (lift = rate / prior)."""
    prior = model["prior"] or 1e-4
    base = _logit(prior)
    z = base
    contribs: list[tuple[float, str]] = []
    for f in feats:
        entry = model["features"].get(f)
        if not entry:
            continue
        rate = entry[2]
        delta = _logit(rate) - base
        z += delta
        if abs(delta) > 1e-9:
            lift = rate / prior if prior else 0.0
            contribs.append((abs(delta), f"{f} ×{lift:.1f}"))
    contribs.sort(reverse=True)
    score = 1.0 / (1.0 + math.exp(-z))
    return score, [c[1] for c in contribs[:3]]


def learn(conn, *, apply: bool = False, min_support: int = 20, alpha: float = 50.0,
          limit: int | None = None, samples: int = 10) -> dict:
    """Fit the model and (with ``apply``) write ``metadata.triage_score`` +
    ``metadata.triage_why`` onto inbox items and persist the model to settings.
    Dry-run (default) fits and reports without writing anything."""
    model = fit(conn, min_support=min_support, alpha=alpha)
    now = model["fitted_utc"]

    sql = ("SELECT fullname, source, kind, created_utc, first_seen_utc, metadata "
           "FROM items WHERE status='inbox'")
    params: list = []
    if limit:
        sql += " LIMIT ?"
        params.append(int(limit))
    rows = conn.execute(sql, params).fetchall()

    scored = 0
    top: list[tuple[float, str, list[str]]] = []
    for r in rows:
        md = parse_metadata(r["metadata"])
        score, why = score_item(model, extract_features(dict(r), md, now=now))
        scored += 1
        label = f"r/{md.get('subreddit') or '?'}: " if md.get("subreddit") else ""
        top.append((score, f"{label}{r['fullname']}", why))
        if apply:
            conn.execute(
                "UPDATE items SET metadata=json_set(metadata, '$.triage_score', ?, "
                "'$.triage_why', json(?)) WHERE fullname=?",
                (round(score, 4), json.dumps(why, ensure_ascii=False), r["fullname"]),
            )
    if apply:
        db.set_setting(conn, MODEL_SETTING_KEY, json.dumps(model, ensure_ascii=False))
        conn.commit()

    top.sort(reverse=True)
    strongest = sorted(
        model["features"].items(),
        key=lambda kv: abs(_logit(kv[1][2]) - _logit(model["prior"] or 1e-4)),
        reverse=True,
    )
    return {
        "applied": apply,
        "trained_on": model["trained_on"],
        "processed": model["processed"],
        "prior": model["prior"],
        "features_kept": len(model["features"]),
        "scored": scored,
        "top_features": [
            {"feature": f, "n": n, "k": k, "rate": rate}
            for f, (n, k, rate) in strongest[:15]
        ],
        "sample": [
            {"score": round(s, 4), "item": lbl, "why": why}
            for s, lbl, why in top[:samples]
        ],
    }
