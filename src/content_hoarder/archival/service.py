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
from typing import Any

from content_hoarder import db
from content_hoarder.archival._http import ArchiveError
from content_hoarder.archival.providers import _PLACEHOLDERS, default_providers
from content_hoarder.models import parse_metadata

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


def _scope_where(scope: str) -> str:
    # "all" hydrates score/content for every reddit item; "removed" only the placeholders;
    # "gallery_preview" backfills galleries missing the sized variant (Epic 13 P2 — run with
    # retry=True since these were already hydrated; the gallery_preview IS NULL clause is what
    # makes it resumable, dropping each gallery out once backfilled).
    if scope == "all":
        return "source='reddit'"
    if scope == "gallery_preview":
        return (
            "source='reddit' AND json_extract(metadata, '$.gallery') IS NOT NULL "
            "AND json_extract(metadata, '$.gallery_preview') IS NULL"
        )
    return _TARGET_WHERE


def count_targets(conn, *, retry: bool = False, scope: str = "removed") -> int:
    sql = "SELECT COUNT(*) FROM items WHERE " + _scope_where(scope)
    if not retry:
        sql += " AND hydrated_at IS NULL"
    return conn.execute(sql).fetchone()[0]


def _select_targets(conn, *, retry: bool, limit, scope: str = "removed") -> list:
    sql = "SELECT * FROM items WHERE " + _scope_where(scope)
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
    # Don't clobber a navigable permalink with a bare v.redd.it (which renders no page);
    # videos keep their permalink click-URL, with the raw stream in metadata.media_url.
    if fields.get("url") and fields.get("media_type") != "reddit_video":
        overlay["url"] = fields["url"]
    cu = fields.get("created_utc")
    if cu:
        try:
            overlay["created_utc"] = int(float(cu))
        except (TypeError, ValueError):
            pass

    # subreddit/permalink + the refined media fields (media_type overrides the
    # connector's URL-heuristic value via merge_upsert's incoming-non-empty-wins).
    for key in (
        "subreddit",
        "permalink",
        "media_type",
        "media_url",
        "thumbnail",
        "gallery",
        "gallery_preview",
    ):
        if fields.get(
            key
        ):  # empty gallery list is falsy -> skipped for non-gallery posts
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


def recover(
    conn,
    *,
    limit=None,
    retry: bool = False,
    scope: str = "removed",
    providers=None,
    user_agent: str = DEFAULT_USER_AGENT,
    progress=None,
) -> dict:
    """Recover reddit items from web archives (bulk). ``scope='removed'`` (default)
    targets only the ``[removed]``/``[deleted]``/un-hydrated placeholders; ``scope='all'``
    hydrates score + current title/body for every reddit item.

    Tries each provider in order (PullPush → Arctic-Shift); ids not found, or only
    returning ``[removed]``, fall through to the next. Every attempted item is
    stamped ``hydrated_at`` so re-runs resume where this one stopped.
    """
    targets = _select_targets(conn, retry=retry, limit=limit, scope=scope)
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
                done = _collect(
                    prov.fetch_posts(sorted(remaining_posts)), "t3_", by_sid, recovered
                )
                remaining_posts -= done
                done_n += len(done)
            except ArchiveError as exc:
                errors[prov.name] = str(exc)
        if remaining_comments:
            try:
                done = _collect(
                    prov.fetch_comments(sorted(remaining_comments)),
                    "t1_",
                    by_sid,
                    recovered,
                )
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


def _try_archive_today(conn, item, *, providers, fetch_bytes, apply_bytes) -> int:
    """Post-chain media-byte recovery from archive.today. Runs only when the item's
    media is still ``gone`` (PullPush/Arctic didn't recover a live image). Asks each
    provider for the snapshot's image URLs, fetches the bytes, stores them via
    ``media_store`` (content-addressed, dedup), records ``archived_media`` and flips
    ``media_status``. Returns the count of blobs archived (0 if nothing/skipped).

    Non-destructive: writes only ``archived_media`` + ``media_status`` via ``json_set``
    (mirrors media_archive.py — no triage state, no last_seen bump, no search_text rebuild).
    Any provider failure is a soft miss (loud-fail tolerant) — recover_one swallows it.
    """
    md = item.get("metadata") or {}
    if isinstance(md, str):
        import json as _json

        md = _json.loads(md) if md else {}
    if md.get("media_status") != "gone":
        return (
            0  # we have a live image (or it was never media) → don't burn archive.today
        )

    from content_hoarder import media_store

    arch = dict(md.get("archived_media") or {})
    n = 0
    for prov in providers:
        try:
            candidates = prov.recover_media(item)
        except Exception:  # noqa: BLE001 — any provider failure is a soft miss
            continue
        if not candidates:
            continue
        for c in candidates:
            url = c.get("url")
            if not url or url in arch:
                continue
            if not apply_bytes:
                n += 1
                continue
            data, mime = fetch_bytes(url)
            if data is None:
                continue
            blob = media_store.store(data, mime=mime, url=url)
            arch[url] = blob
            n += 1
        if n:
            break  # first provider that found anything wins
    if n and apply_bytes:
        import json as _json

        conn.execute(
            "UPDATE items SET metadata=json_set(json_set(metadata, "
            "'$.archived_media', json(?)), '$.media_status', 'recovered_archive_today') "
            "WHERE fullname=?",
            (_json.dumps(arch), item["fullname"]),
        )
        conn.commit()
    return n


def _archive_today_item_image_urls(md: dict[str, Any]) -> list[str]:
    out: list[str] = []
    u = md.get("media_url") or ""
    if isinstance(u, str) and u.startswith("http"):
        out.append(u)
    out += [
        g
        for g in (md.get("gallery") or [])
        if isinstance(g, str) and g.startswith("http")
    ]
    seen: set[str] = set()
    return [x for x in out if not (x in seen or seen.add(x))]


def archive_today_media_eligibility(
    item: dict[str, Any] | None,
) -> tuple[bool, str, dict[str, Any], list[str]]:
    """Return whether an item can benefit from explicit archive.today media recovery.

    This is intentionally separate from the PullPush/Arctic metadata recovery chain:
    archive.today is URL-keyed, external, and only useful for reddit media rows whose
    original bytes are known gone and still have original media URLs to look up.
    """
    if not item:
        return False, "not_found", {}, []
    if item.get("source") != "reddit":
        return False, "non_reddit", {}, []
    md = parse_metadata(item.get("metadata"))
    if md.get("media_status") != "gone":
        return False, "media_not_gone", md, []
    if md.get("archived_media"):
        return False, "already_archived", md, []
    urls = _archive_today_item_image_urls(md)
    if not urls:
        return False, "missing_media_url", md, []
    return True, "eligible", md, urls


def archive_today_recover_media(
    conn,
    fullname: str,
    *,
    providers: list[Any],
    fetch_bytes: Any = None,
    apply_bytes: bool = False,
) -> dict[str, Any]:
    """Explicit per-item archive.today media recovery/preview.

    ``apply_bytes=False`` performs the live snapshot lookup only and writes nothing.
    ``apply_bytes=True`` also fetches bytes, stores blobs, and flips metadata. Provider
    and byte-fetch transports remain injectable so tests stay offline.
    """
    item = db.get_item(conn, fullname)
    eligible, reason, _md, _urls = archive_today_media_eligibility(item)
    out = {
        "eligible": eligible,
        "attempted": False,
        "mode": "apply" if apply_bytes else "preview",
        "bytes_archived": 0,
        "snapshot_candidates": 0,
        "result": "skipped" if not eligible else "miss",
        "errors": [] if eligible else [reason],
    }
    if not eligible:
        return out
    assert item is not None

    from content_hoarder.media_archive import default_fetch

    before = len(
        parse_metadata((item or {}).get("metadata")).get("archived_media") or {}
    )
    count = _try_archive_today(
        conn,
        item,
        providers=providers,
        fetch_bytes=fetch_bytes or default_fetch,
        apply_bytes=apply_bytes,
    )
    out["attempted"] = True
    if apply_bytes:
        fresh = db.get_item(conn, fullname) or {}
        fresh_md = parse_metadata(fresh.get("metadata"))
        after = len(fresh_md.get("archived_media") or {})
        out["bytes_archived"] = max(after - before, count)
        out["result"] = "hit" if out["bytes_archived"] else "miss"
    else:
        out["snapshot_candidates"] = count
        out["result"] = "hit" if count else "miss"
    return out


def recover_one(
    conn,
    fullname: str,
    *,
    providers=None,
    user_agent: str = DEFAULT_USER_AGENT,
    media_providers=None,
    fetch_bytes=None,
    apply_bytes=True,
) -> dict | None:
    """On-demand metadata recovery of a single reddit item (throttle off, for a UI button).

    Returns ``{recovered, title, body, url, bytes_archived}`` (post-recovery values),
    or None if it isn't a recoverable reddit item. archive.today media recovery is
    opt-in only: callers must pass ``media_providers`` explicitly.
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
            found = (
                prov.fetch_posts([bare])
                if sid.startswith("t3_")
                else prov.fetch_comments([bare])
            )
        except ArchiveError:
            continue
        if _collect(found, sid[:3], by_sid, recovered):
            break
    update = {"fullname": fullname, "hydrated_at": int(time.time())}
    update.update(recovered.get(sid, {}))
    db.merge_upsert(conn, update)
    conn.commit()

    # archive.today media-byte recovery remains opt-in for trusted callers/tests only.
    media = None
    bytes_n = 0
    if media_providers:
        media = archive_today_recover_media(
            conn,
            fullname,
            providers=media_providers,
            fetch_bytes=fetch_bytes,
            apply_bytes=apply_bytes,
        )
        bytes_n = (
            media.get("bytes_archived")
            if apply_bytes
            else media.get("snapshot_candidates", 0)
        )

    fresh = db.get_item(conn, fullname) or {}
    res = {
        "recovered": bool(recovered) or bool(bytes_n),
        "metadata_recovered": bool(recovered),
        "title": fresh.get("title"),
        "body": fresh.get("body"),
        "url": fresh.get("url"),
        "bytes_archived": bytes_n,
    }
    if media is not None:
        res["archive_today"] = media
    return res
