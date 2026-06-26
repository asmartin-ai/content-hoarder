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


def _feature_rate(entry) -> float:
    try:
        return float(entry[2])
    except (TypeError, ValueError, IndexError):
        return 0.0


def drift(prev_model: dict, curr_model: dict, *, top_n: int = 10) -> dict:
    """Compare two fitted triage models and summarize feature/prior drift.

    Pure computation: no DB access and no mutation of either model. ``features`` are
    considered supported when they appear in the fitted model's feature table.
    """
    prev_features = prev_model.get("features") or {}
    curr_features = curr_model.get("features") or {}
    prev_keys = set(prev_features)
    curr_keys = set(curr_features)
    shared = sorted(prev_keys & curr_keys)

    movers = []
    deltas = []
    for feature in shared:
        old_rate = _feature_rate(prev_features.get(feature))
        new_rate = _feature_rate(curr_features.get(feature))
        delta = new_rate - old_rate
        abs_delta = abs(delta)
        deltas.append(abs_delta)
        movers.append({
            "feature": feature,
            "old_rate": round(old_rate, 6),
            "new_rate": round(new_rate, 6),
            "delta": round(delta, 6),
            "abs_delta": round(abs_delta, 6),
        })
    movers.sort(key=lambda m: (-m["abs_delta"], m["feature"]))

    mean_delta = sum(deltas) / len(deltas) if deltas else 0.0
    max_delta = max(deltas) if deltas else 0.0
    old_prior = float(prev_model.get("prior") or 0.0)
    new_prior = float(curr_model.get("prior") or 0.0)
    prior_delta = new_prior - old_prior
    return {
        "features_added": sorted(curr_keys - prev_keys),
        "features_dropped": sorted(prev_keys - curr_keys),
        "rate_drift": {
            "shared": len(shared),
            "max_abs_delta": round(max_delta, 6),
            "mean_abs_delta": round(mean_delta, 6),
            "top_movers": movers[:top_n],
        },
        "prior_drift": {
            "old": round(old_prior, 6),
            "new": round(new_prior, 6),
            "delta": round(prior_delta, 6),
            "abs_delta": round(abs(prior_delta), 6),
        },
        "drift_score": round(mean_delta, 6),
    }


def new_decisions_since(conn, since_utc: int | None) -> int:
    """Count post-fit human decisions, excluding machine-decayed/swept rows."""
    if since_utc is None:
        return 0
    return conn.execute(
        "SELECT COUNT(*) FROM items WHERE processed_utc IS NOT NULL "
        "AND processed_utc > ? AND status IN (?, ?, ?) "
        "AND json_extract(metadata, '$.decayed_at') IS NULL "
        "AND json_extract(metadata, '$.decay_label') IS NULL",
        (int(since_utc), *_PROCESSED),
    ).fetchone()[0]


def drift_report(conn, *, apply: bool = False, min_support: int = 20, alpha: float = 50.0,
                 limit: int | None = None, samples: int = 10,
                 since_processed: int | None = None) -> dict:
    """Load the persisted model, fit current rows, and report drift.

    Dry-run (default) writes nothing. With ``apply=True`` this delegates to
    :func:`learn`, preserving the existing refit + rescore + persist behavior.
    """
    raw_prev = db.get_setting(conn, MODEL_SETTING_KEY)
    prev_model = json.loads(raw_prev) if raw_prev else None
    curr_model = fit(conn, min_support=min_support, alpha=alpha)
    since_utc = since_processed
    if since_utc is None and prev_model:
        since_utc = int(prev_model.get("fitted_utc") or 0)

    report = {
        "applied": False,
        "has_previous": prev_model is not None,
        "previous_fitted_utc": prev_model.get("fitted_utc") if prev_model else None,
        "current_fitted_utc": curr_model["fitted_utc"],
        "new_decisions": new_decisions_since(conn, since_utc),
        "current": {
            "trained_on": curr_model["trained_on"],
            "processed": curr_model["processed"],
            "prior": curr_model["prior"],
            "features_kept": len(curr_model["features"]),
        },
        "drift": drift(prev_model, curr_model) if prev_model else None,
    }
    if apply:
        report["refit"] = learn(conn, apply=True, min_support=min_support, alpha=alpha,
                                limit=limit, samples=samples)
        report["applied"] = True
    return report


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
