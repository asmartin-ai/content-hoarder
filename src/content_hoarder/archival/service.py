"""Bulk recovery of removed / unhydrated reddit items from web archives.

Optional, removable feature (network-only). Selects reddit items whose body/title
is a ``[removed]``/``[deleted]`` placeholder (or a saved comment whose body was
never captured), fetches the originals from PullPush.io then Arctic-Shift, and
overlays the recovered fields non-destructively via ``db.merge_upsert`` (triage
state preserved; ``hydrated_at`` marks every attempt so re-runs resume). Degrades
gracefully per provider when offline or rate-limited.
"""
from __future__ import annotations

import time

from content_hoarder import db
from content_hoarder.archival._http import ArchiveError
from content_hoarder.archival.providers import _PLACEHOLDERS, default_providers

DEFAULT_USER_AGENT = "content-hoarder/0.1 (reddit archival recovery)"

# Reddit items worth attempting: explicit removal placeholders, or a saved comment
# whose body was never captured (RSM stored id + metadata only for most comments).
_TARGET_WHERE = (
    "source='reddit' AND ("
    "body IN ('[removed]','[deleted]') OR title IN ('[removed]','[deleted]') "
    "OR body LIKE '[ removed by%' OR title LIKE '[ removed by%' OR title LIKE 'deleted by user%' "
    "OR (kind='comment' AND (body IS NULL OR body=''))"
    ")"
)


def count_targets(conn, *, retry: bool = False) -> int:
    sql = "SELECT COUNT(*) FROM items WHERE " + _TARGET_WHERE
    if not retry:
        sql += " AND hydrated_at IS NULL"
    return conn.execute(sql).fetchone()[0]


def _select_targets(conn, *, retry: bool, limit) -> list:
    sql = "SELECT * FROM items WHERE " + _TARGET_WHERE
    if not retry:
        sql += " AND hydrated_at IS NULL"
    sql += " ORDER BY last_seen_utc DESC"
    params: tuple = ()
    if limit:
        sql += " LIMIT ?"
        params = (int(limit),)
    return [db._row_to_public(r) for r in conn.execute(sql, params).fetchall()]


def _overlay_fields(fields: dict):
    """Map an archive record to a partial content-hoarder overlay dict.

    ``meaningful`` is True only when a real title (posts) or body (comments) was
    recovered — placeholders don't count, so the id stays eligible for the next
    provider. ``db.merge_upsert`` applies the overlay non-destructively.
    """
    overlay: dict = {}
    md: dict = {}
    meaningful = False

    title = fields.get("title")
    if title and title not in _PLACEHOLDERS:
        overlay["title"] = title
        meaningful = True
    body = fields.get("body")
    if body and body not in _PLACEHOLDERS:
        overlay["body"] = body
        meaningful = True

    author = fields.get("author")
    if author and author not in _PLACEHOLDERS:
        overlay["author"] = author
    if fields.get("url"):
        overlay["url"] = fields["url"]
    cu = fields.get("created_utc")
    if cu:
        try:
            overlay["created_utc"] = int(float(cu))
        except (TypeError, ValueError):
            pass

    for key in ("subreddit", "permalink"):
        if fields.get(key):
            md[key] = fields[key]
    if fields.get("score"):
        md["score"] = fields["score"]
    if fields.get("over_18"):
        md["over_18"] = 1
    if md:
        overlay["metadata"] = md
    return overlay, meaningful


def _collect(found: dict, prefix: str, by_sid: dict, recovered: dict) -> set:
    """Record meaningful recoveries; return the set of bare ids filled."""
    done = set()
    for bare, fields in found.items():
        item = by_sid.get(prefix + bare)
        if not item:
            continue
        overlay, meaningful = _overlay_fields(fields)
        if not meaningful:
            continue
        recovered[prefix + bare] = overlay
        done.add(bare)
    return done


def recover(conn, *, limit=None, retry: bool = False, providers=None,
            user_agent: str = DEFAULT_USER_AGENT, progress=None) -> dict:
    """Recover removed/unhydrated reddit items from web archives (bulk).

    Tries each provider in order (PullPush → Arctic-Shift); ids not found, or only
    returning ``[removed]``, fall through to the next. Every attempted item is
    stamped ``hydrated_at`` so re-runs resume where this one stopped. Returns
    counts + per-provider tallies + any per-provider errors.
    """
    targets = _select_targets(conn, retry=retry, limit=limit)
    if not targets:
        return {"selected": 0, "recovered": 0, "missed": 0, "by_provider": {}}

    providers = providers or default_providers(user_agent, throttle=True)
    by_sid = {it["source_id"]: it for it in targets}
    remaining_posts = {sid[3:] for sid in by_sid if sid.startswith("t3_")}
    remaining_comments = {sid[3:] for sid in by_sid if sid.startswith("t1_")}

    recovered: dict = {}
    by_provider: dict = {}
    errors: dict = {}
    for prov in providers:
        done_n = 0
        # One provider failing (timeout, outage, rate-limit) must not lose progress —
        # record the error and let the chain continue with the next provider.
        if remaining_posts:
            try:
                done = _collect(prov.fetch_posts(sorted(remaining_posts)), "t3_", by_sid, recovered)
                remaining_posts -= done
                done_n += len(done)
            except ArchiveError as exc:
                errors[prov.name] = str(exc)
        if remaining_comments:
            try:
                done = _collect(prov.fetch_comments(sorted(remaining_comments)), "t1_", by_sid, recovered)
                remaining_comments -= done
                done_n += len(done)
            except ArchiveError as exc:
                errors[prov.name] = str(exc)
        if done_n:
            by_provider[prov.name] = by_provider.get(prov.name, 0) + done_n
        if progress:
            progress(f"  {prov.name}: {len(recovered)}/{len(targets)} recovered")
        if not remaining_posts and not remaining_comments:
            break

    now = int(time.time())
    for sid, item in by_sid.items():
        update = {"fullname": item["fullname"], "hydrated_at": now}
        update.update(recovered.get(sid, {}))  # recovered fields, if any
        db.merge_upsert(conn, update)
    conn.commit()

    result = {
        "selected": len(targets),
        "recovered": len(recovered),
        "missed": len(remaining_posts) + len(remaining_comments),
        "by_provider": by_provider,
    }
    if errors:
        result["errors"] = errors
    return result


def recover_one(conn, fullname: str, *, providers=None,
                user_agent: str = DEFAULT_USER_AGENT) -> dict | None:
    """On-demand recovery of a single reddit item (throttle off, for a UI button).

    Returns ``{recovered, title, body, url}`` (post-recovery values), or None if it
    isn't a recoverable reddit item.
    """
    item = db.get_item(conn, fullname)
    if not item or item.get("source") != "reddit":
        return None
    sid = item.get("source_id") or ""
    if not sid.startswith(("t1_", "t3_")):
        return None
    providers = providers or default_providers(user_agent, throttle=False)
    by_sid = {sid: item}
    recovered: dict = {}
    bare = sid[3:]
    for prov in providers:
        try:
            found = prov.fetch_posts([bare]) if sid.startswith("t3_") else prov.fetch_comments([bare])
        except ArchiveError:
            continue
        if _collect(found, sid[:3], by_sid, recovered):
            break
    update = {"fullname": fullname, "hydrated_at": int(time.time())}
    update.update(recovered.get(sid, {}))
    db.merge_upsert(conn, update)
    conn.commit()
    fresh = db.get_item(conn, fullname) or {}
    return {"recovered": bool(recovered), "title": fresh.get("title"),
            "body": fresh.get("body"), "url": fresh.get("url")}
