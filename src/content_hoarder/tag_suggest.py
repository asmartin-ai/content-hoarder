"""Tag suggestion queue — reviewable tag proposals from rules, LLM, and discovery.

Generates candidate tag assignments, stores them in ``tag_suggestions`` for human
review, and provides accept/reject operations. Decoupled from the auto-apply tagging
pipeline (``categorize.py``) — the pipeline keeps auto-applying known-good rules;
this module catches the uncertain tail and long-tail discovery.

Design
------
- **Rule-based suggestions**: for untagged items whose keyword heuristics produce a
  tag. The existing ``dry_run`` mode previews these ephemerally; this makes them
  persistent + reviewable.
- **Discovery suggestions**: surface subreddits/domains that appear frequently among
  untagged items but have no mapping rule — suggests creating one.
- **AI suggestions**: LLM-generated tags from ``assist/llm.suggest()``, stored in the
  queue instead of only in ``metadata.llm``.

Queue flow: ``pending`` → ``applied`` (tag written) or ``rejected`` (explicitly
dismissed). De-duplicated: the same (fullname, suggested_tag) can't be double-queued
while pending.
"""

from __future__ import annotations

import json
import time
from collections import Counter
from typing import Any

from content_hoarder import config
from content_hoarder.categorize import (
    _BROWSER_HOST_TAGS,
    _KEYWORD_TAGS,
    _SUBREDDIT_TAGS,
    FILTER_TAGS,
)
from content_hoarder.models import parse_metadata

# Minimum distinct subreddits/domains from untagged items before suggesting a new rule.
_DISCOVERY_MIN_SOURCES = 3
# Minimum count threshold for discovery suggestions.
_DISCOVERY_MIN_COUNT = 2

# The curated tag vocabulary — suggestions outside this set are "new tag" proposals.
_CURATED_TAGS = frozenset(FILTER_TAGS)

VALID_SUGGESTION_STATUSES = ("pending", "applied", "rejected", "dismissed")


# ---------------------------------------------------------------------------
# DB helpers (schema defined in db.py)
# ---------------------------------------------------------------------------


def _now() -> int:
    return int(time.time())


def create_suggestion(
    conn,
    fullname: str,
    tag: str,
    source: str = "rule",
    reason: str = "",
) -> int | None:
    """Insert a tag suggestion (de-duped: no-op if pending/applied exists).

    Returns the row id, or None if the suggestion already exists.
    """
    tag_norm = tag.strip().lower()[:40]
    if not tag_norm:
        return None
    # De-dupe: skip if the same (fullname, tag) is already pending or applied.
    existing = conn.execute(
        "SELECT id, status FROM tag_suggestions "
        "WHERE fullname=? AND suggested_tag=? AND status IN ('pending', 'applied')",
        (fullname, tag_norm),
    ).fetchone()
    if existing:
        return None
    now = _now()
    conn.execute(
        "INSERT INTO tag_suggestions (fullname, suggested_tag, source, reason, status, created_utc) "
        "VALUES (?, ?, ?, ?, 'pending', ?)",
        (fullname, tag_norm, source, (reason or "")[:200], now),
    )
    return conn.execute("SELECT last_insert_rowid()").fetchone()[0]


def list_suggestions(
    conn,
    status: str = "pending",
    *,
    tag: str | None = None,
    source_type: str | None = None,
    limit: int | None = None,
) -> list[dict]:
    """Return suggestions matching the filters, newest first, enriched with item title."""
    where = ["s.status = ?"]
    params: list = [status]
    if tag:
        where.append("s.suggested_tag = ?")
        params.append(tag.strip().lower()[:40])
    if source_type:
        where.append("s.source = ?")
        params.append(source_type)
    sql = (
        """
        SELECT s.id, s.fullname, s.suggested_tag, s.source, s.reason,
               s.status, s.created_utc, s.resolved_utc,
               i.title AS item_title, i.source AS item_source
        FROM tag_suggestions s
        LEFT JOIN items i ON i.fullname = s.fullname
        WHERE """
        + " AND ".join(where)
        + """
        ORDER BY s.created_utc DESC
    """
    )
    if limit:
        sql += " LIMIT ?"
        params.append(int(limit))
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def suggestion_counts(conn, status: str = "pending") -> dict[str, int]:
    """Per-tag counts for pending (or other status) suggestions."""
    rows = conn.execute(
        "SELECT suggested_tag, COUNT(*) AS c FROM tag_suggestions "
        "WHERE status=? GROUP BY suggested_tag ORDER BY c DESC",
        (status,),
    ).fetchall()
    return {r["suggested_tag"]: r["c"] for r in rows}


def accept_suggestion(conn, suggestion_id: int) -> dict | None:
    """Accept a suggestion: apply the tag to the item and mark as applied.

    Returns the suggestion row or None if not found.
    """
    row = conn.execute(
        "SELECT * FROM tag_suggestions WHERE id=? AND status='pending'",
        (suggestion_id,),
    ).fetchone()
    if row is None:
        return None
    sug = dict(row)
    # Apply the tag via set_tags
    from content_hoarder import db

    tags = db.set_tags(conn, sug["fullname"], add=[sug["suggested_tag"]])
    if tags is None:
        return None  # item missing
    conn.execute(
        "UPDATE tag_suggestions SET status='applied', resolved_utc=? WHERE id=?",
        (_now(), suggestion_id),
    )
    conn.commit()
    sug["status"] = "applied"
    sug["resolved_utc"] = _now()
    sug["result_tags"] = tags
    return sug


def reject_suggestion(conn, suggestion_id: int) -> dict | None:
    """Reject a suggestion (mark as rejected without applying)."""
    row = conn.execute(
        "SELECT * FROM tag_suggestions WHERE id=? AND status='pending'",
        (suggestion_id,),
    ).fetchone()
    if row is None:
        return None
    sug = dict(row)
    conn.execute(
        "UPDATE tag_suggestions SET status='rejected', resolved_utc=? WHERE id=?",
        (_now(), suggestion_id),
    )
    conn.commit()
    sug["status"] = "rejected"
    sug["resolved_utc"] = _now()
    return sug


def accept_all_suggestions(conn, *, tag: str | None = None) -> int:
    """Accept all pending suggestions (optionally filtered by tag)."""
    where = ["status='pending'"]
    params: list = []
    if tag:
        where.append("suggested_tag=?")
        params.append(tag.strip().lower()[:40])
    rows = conn.execute(
        "SELECT * FROM tag_suggestions WHERE " + " AND ".join(where),
        params,
    ).fetchall()
    count = 0
    for r in rows:
        sug = dict(r)
        from content_hoarder import db

        tags = db.set_tags(conn, sug["fullname"], add=[sug["suggested_tag"]])
        if tags is not None:
            conn.execute(
                "UPDATE tag_suggestions SET status='applied', resolved_utc=? WHERE id=?",
                (_now(), sug["id"]),
            )
            count += 1
    conn.commit()
    return count


def reject_all_suggestions(conn, *, tag: str | None = None) -> int:
    """Reject all pending suggestions (optionally filtered by tag)."""
    where = ["status='pending'"]
    params: list = []
    if tag:
        where.append("suggested_tag=?")
        params.append(tag.strip().lower()[:40])
    now = _now()
    cur = conn.execute(
        "UPDATE tag_suggestions SET status='rejected', resolved_utc=? "
        "WHERE " + " AND ".join(where),
        [now] + params,
    )
    conn.commit()
    return cur.rowcount


# ---------------------------------------------------------------------------
# Suggestion generation
# ---------------------------------------------------------------------------


def suggest_from_rule_matches(
    conn,
    *,
    source: str | None = None,
    limit: int | None = None,
    retry: bool = False,
) -> dict[str, Any]:
    """Generate suggestions for items whose heuristic tagging produced tags.

    Runs the pure tag functions (``reddit_tags``, ``youtube_tags``, etc.) and queues
    any tags they produce as suggestions instead of auto-applying them. Useful for a
    user who wants to review ALL tag proposals before committing.

    Returns counts of queued suggestions.
    """
    from content_hoarder import categorize as cat

    now = _now()
    total_queued = 0
    by_tag: Counter = Counter()

    sources = (
        ["reddit", "youtube", "firefox", "hackernews"] if source is None else [source]
    )
    for src in sources:
        tagger = _tagger_for_source(src)
        if tagger is None:
            continue

        where = ["source = ?"]
        params: list = [src]
        # Skip items that already have curated-topic tags (they're already covered).
        if not retry:
            where.append(
                "(json_extract(metadata, '$.tags') IS NULL OR "
                "json_extract(metadata, '$.tags') = json('[]'))"
            )
        if limit:
            sql = (
                "SELECT fullname, title, url, metadata FROM items WHERE "
                + " AND ".join(where)
                + " ORDER BY last_seen_utc DESC LIMIT ?"
            )
            params.append(int(limit))
        else:
            sql = (
                "SELECT fullname, title, url, metadata FROM items WHERE "
                + " AND ".join(where)
                + " ORDER BY last_seen_utc DESC"
            )

        for r in conn.execute(sql, params).fetchall():
            md = parse_metadata(r["metadata"])
            tags = tagger({"title": r["title"], "url": r["url"], "metadata": md})
            if tags:
                for t in tags:
                    if create_suggestion(
                        conn,
                        r["fullname"],
                        t,
                        "rule",
                        f"Auto-detected by {src} heuristic rules",
                    ):
                        total_queued += 1
                        by_tag[t] += 1
    conn.commit()
    return {"queued": total_queued, "by_tag": dict(by_tag), "source": source or "all"}


def _tagger_for_source(source: str):
    """Return the pure tag function for a source, or None."""
    from content_hoarder.categorize import (
        firefox_tags,
        hackernews_tags,
        reddit_tags,
        youtube_tags,
    )

    return {
        "reddit": reddit_tags,
        "youtube": youtube_tags,
        "firefox": firefox_tags,
        "hackernews": hackernews_tags,
    }.get(source)


def suggest_from_discovery(
    conn,
    *,
    limit: int | None = None,
    min_count: int = _DISCOVERY_MIN_COUNT,
) -> dict[str, Any]:
    """Discover new tag-worthy subreddits/domains from untagged items.

    Scans untagged items, groups by subreddit (reddit) or domain (browser),
    and suggests tags when a source appears frequently among the untagged tail.

    Returns counts of queued discovery suggestions.
    """
    now = _now()
    total_queued = 0
    suggestions: dict[str, dict] = {}

    # --- Reddit: untagged subreddits ---
    rows = conn.execute(
        "SELECT fullname, title, metadata FROM items "
        "WHERE source='reddit' "
        "AND (json_extract(metadata, '$.tags') IS NULL OR json_extract(metadata, '$.tags') = json('[]'))"
        "AND json_extract(metadata, '$.subreddit') IS NOT NULL "
        "ORDER BY last_seen_utc DESC"
    ).fetchall()
    sub_counter: Counter = Counter()
    sub_samples: dict[str, list[str]] = {}
    for r in rows:
        md = parse_metadata(r["metadata"])
        sub = (md.get("subreddit") or "").lower()
        if not sub:
            continue
        sub_counter[sub] += 1
        if sub not in sub_samples:
            sub_samples[sub] = []
        if len(sub_samples[sub]) < 3:
            sub_samples[sub].append((r["title"] or "")[:80])

    for sub, count in sub_counter.most_common(limit or 100):
        if sub in _SUBREDDIT_TAGS:
            continue  # already mapped
        if count < min_count:
            continue
        # Suggest tags based on the subreddit name keywords (same logic as reddit_tags keyword fallback)
        hay = sub + " " + " ".join(sub_samples.get(sub, []))
        for tag, rx in _KEYWORD_TAGS:
            if rx.search(hay):
                # Pick one sample item to suggest on
                candidates = conn.execute(
                    "SELECT fullname FROM items WHERE source='reddit' "
                    "AND json_extract(metadata, '$.subreddit')=? COLLATE NOCASE "
                    "LIMIT 1",
                    (sub,),
                ).fetchall()
                if candidates:
                    fn = candidates[0]["fullname"]
                    if create_suggestion(
                        conn,
                        fn,
                        tag,
                        "discovery",
                        f"r/{sub} appears {count}x among untagged items — suggest '{tag}' tag",
                    ):
                        total_queued += 1
                        suggestions.setdefault(tag, []).append(sub)
                break

    # --- Browser: untagged domains ---
    browser_rows = conn.execute(
        "SELECT fullname, title, metadata FROM items "
        "WHERE source IN ('firefox', 'hackernews') "
        "AND (json_extract(metadata, '$.tags') IS NULL OR json_extract(metadata, '$.tags') = json('[]'))"
        "ORDER BY last_seen_utc DESC"
    ).fetchall()
    domain_counter: Counter = Counter()
    for r in browser_rows:
        md = parse_metadata(r["metadata"])
        domain = (md.get("domain") or "").lower()
        if domain:
            domain_counter[domain] += 1

    for domain, count in domain_counter.most_common(limit or 100):
        if count < min_count:
            continue
        # Check if any host tag would match this domain
        matched = False
        for key in _BROWSER_HOST_TAGS:
            if key in domain:
                matched = True
                break
        if matched:
            continue  # already covered
        # Check keywords in sample titles
        sample_titles = " ".join(
            r["title"] or ""
            for r in browser_rows
            if parse_metadata(r["metadata"]).get("domain", "").lower() == domain
        )[:500]
        from content_hoarder.categorize import _BROWSER_KEYWORD_TAGS

        for tag, rx in _BROWSER_KEYWORD_TAGS:
            if rx.search(sample_titles):
                candidates = conn.execute(
                    "SELECT fullname FROM items WHERE source IN ('firefox','hackernews') "
                    "AND json_extract(metadata, '$.domain')=? COLLATE NOCASE LIMIT 1",
                    (domain,),
                ).fetchall()
                if candidates:
                    fn = candidates[0]["fullname"]
                    if create_suggestion(
                        conn,
                        fn,
                        tag,
                        "discovery",
                        f"{domain} appears {count}x among untagged browser items — suggest '{tag}'",
                    ):
                        total_queued += 1
                        suggestions.setdefault(tag, []).append(domain)
                break

    conn.commit()
    return {
        "queued": total_queued,
        "discovered": {t: items for t, items in suggestions.items()},
    }


def suggest_from_llm(
    conn,
    *,
    limit: int | None = None,
    source: str | None = None,
) -> dict[str, Any]:
    """Generate LLM-based tag suggestions for untagged inbox items.

    Runs the LLM suggest function on items that have no existing suggestion
    and no topic tags. Queues any tags the LLM proposes as suggestions.

    Returns counts of queued suggestions. No-op when the LLM is unconfigured.
    """
    from content_hoarder.assist import llm

    if not llm.is_available():
        return {"available": False, "queued": 0}

    where = [
        "status='inbox'",
        "(json_extract(metadata, '$.tags') IS NULL OR json_extract(metadata, '$.tags') = json('[]'))",
        "fullname NOT IN (SELECT fullname FROM tag_suggestions WHERE source='ai' AND status='pending')",
    ]
    params: list = []
    if source:
        where.append("source = ?")
        params.append(source)
    sql = (
        "SELECT fullname, title, url, author, metadata FROM items WHERE "
        + " AND ".join(where)
    )
    sql += " ORDER BY last_seen_utc DESC"
    if limit:
        sql += " LIMIT ?"
        params.append(int(limit))
    rows = conn.execute(sql, params).fetchall()

    queued = 0
    for r in rows:
        item = dict(r)
        item["metadata"] = parse_metadata(r["metadata"])
        suggestion = llm.suggest(item)
        if suggestion is None:
            continue
        for t in suggestion.get("tags") or []:
            if create_suggestion(
                conn,
                r["fullname"],
                t,
                "ai",
                f"LLM suggestion: {suggestion.get('reason', '')[:120]}",
            ):
                queued += 1
    conn.commit()
    return {"available": True, "queued": queued, "scanned": len(rows)}
