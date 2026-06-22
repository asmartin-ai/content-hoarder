"""media_archive.py — download + store media bytes for saved items (Epic 4 P1, "hoard the bytes").

Fetches the image URL(s) an item depends on and stores them content-addressed via ``media_store``,
recording ``metadata.archived_media = {original_url: blob_id}`` on the item. Then a deletion of the
remote copy is survivable: the same-origin ``/media/<blob>`` route serves the local bytes.

Scopes (what to archive), cheap→urgent first:
  - ``salvageable`` : items whose original 404'd but ``media_salvage_url`` (a still-live preview)
                      was recorded by ``scan-media`` — a SHORT window, archive first.
  - ``galleries``   : the sized ``gallery_preview`` variants (~1080px) — small + high value.
  - ``images``      : direct reddit images (``media_url``) that aren't already gone — the big set.

Non-destructive + resumable: a URL already in ``archived_media`` is skipped, so re-runs only fetch
what's missing. ``apply=False`` (default) reports the plan without fetching/writing. The HTTP fetch
is INJECTED (``fetch=``) so the whole pass is offline-testable. Commits per item (crash-safe).
"""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from typing import Callable

from content_hoarder import media_store

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
DEFAULT_MAX_BYTES = 15 * 1024 * 1024  # 15 MB/image cap — skip pathological originals
_IMG_RE = re.compile(r"\.(png|jpe?g|gif|webp|bmp)(\?|#|$)", re.I)
SCOPES = ("salvageable", "galleries", "images")


def _is_img(u: str) -> bool:
    return bool(u) and (bool(_IMG_RE.search(u)) or "i.redd.it" in u)


def default_fetch(url: str, *, max_bytes: int = DEFAULT_MAX_BYTES) -> tuple[bytes | None, str]:
    """GET the URL → ``(bytes, mime)`` or ``(None, reason)``. Injectable for tests."""
    req = urllib.request.Request(url, headers={"User-Agent": UA}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read(max_bytes + 1)
            if len(data) > max_bytes:
                return None, "too_large"
            return data, (r.headers.get("Content-Type") or "")
    except urllib.error.HTTPError as e:
        return None, f"http_{e.code}"
    except Exception:  # noqa: BLE001 - any transport failure is a soft miss; retry next run
        return None, "error"


def _urls_for(md: dict, scope: str) -> list[str]:
    """The original URLs an item wants archived for ``scope`` (order preserved, de-duped)."""
    out: list[str] = []
    if scope == "salvageable":
        u = md.get("media_salvage_url")
        if u:
            out.append(u)
    elif scope == "galleries":
        out += [u for u in (md.get("gallery_preview") or []) if u]
    elif scope == "images":
        u = md.get("media_url") or ""
        if _is_img(u) and md.get("media_status") != "gone":
            out.append(u)
    seen: set = set()
    return [u for u in out if not (u in seen or seen.add(u))]


def _candidates_sql(scope: str) -> str:
    base = "source='reddit'"
    if scope == "salvageable":
        return base + " AND json_extract(metadata, '$.media_salvage_url') IS NOT NULL"
    if scope == "galleries":
        return base + " AND json_extract(metadata, '$.gallery_preview') IS NOT NULL"
    # images: an image-shaped media_url that isn't already known-gone
    return (base + " AND COALESCE(json_extract(metadata, '$.media_status'),'') <> 'gone'"
            " AND (json_extract(metadata, '$.media_url') LIKE '%i.redd.it%'"
            " OR json_extract(metadata, '$.media_url') LIKE '%.jpg%'"
            " OR json_extract(metadata, '$.media_url') LIKE '%.png%'"
            " OR json_extract(metadata, '$.media_url') LIKE '%.webp%'"
            " OR json_extract(metadata, '$.media_url') LIKE '%.gif%')")


def archive(
    conn,
    *,
    scopes=("salvageable", "galleries"),
    limit: int | None = None,
    apply: bool = False,
    fetch: Callable[..., tuple] = default_fetch,
    throttle: float = 0.3,
    max_bytes: int = DEFAULT_MAX_BYTES,
    sleep=time.sleep,
    progress: Callable[[str], None] | None = None,
) -> dict:
    """Archive media bytes for items in ``scopes``. Returns counts + bytes. ``limit`` caps the
    number of ITEMS that have work (per the whole run). Commits per item (crash-safe/resumable)."""
    res = {"items": 0, "urls": 0, "archived": 0, "skipped": 0, "failed": 0, "bytes": 0,
           "applied": apply, "by_scope": {}}
    budget = limit
    for scope in scopes:
        if scope not in SCOPES:
            continue
        sc = {"items": 0, "archived": 0, "failed": 0}
        rows = conn.execute(
            f"SELECT fullname, metadata FROM items WHERE {_candidates_sql(scope)}"
        ).fetchall()
        for fn, meta in rows:
            if budget is not None and budget <= 0:
                break
            md = json.loads(meta or "{}")
            arch = dict(md.get("archived_media") or {})
            todo = [u for u in _urls_for(md, scope) if u not in arch]
            if not todo:
                continue
            res["items"] += 1
            sc["items"] += 1
            if budget is not None:
                budget -= 1
            for u in todo:
                res["urls"] += 1
                if not apply:
                    continue
                data, mime = fetch(u, max_bytes=max_bytes)
                if data is None:
                    res["failed"] += 1
                    sc["failed"] += 1
                else:
                    blob = media_store.store(data, mime=mime, url=u)
                    arch[u] = blob
                    res["archived"] += 1
                    sc["archived"] += 1
                    res["bytes"] += len(data)
                if throttle:
                    sleep(throttle)
            if apply and arch != (md.get("archived_media") or {}):
                # direct metadata UPDATE (like scan-media): no last_seen bump (don't reorder the
                # feed) and no search_text rebuild (archived_media isn't searched).
                conn.execute(
                    "UPDATE items SET metadata=json_set(metadata, '$.archived_media', json(?)) "
                    "WHERE fullname=?",
                    (json.dumps(arch), fn),
                )
                conn.commit()  # per-item: crash-safe, resumable
            if progress and res["items"] % 25 == 0:
                progress(f"  [{scope}] {res['items']} items, {res['archived']} blobs, "
                         f"{res['bytes'] // 1024 // 1024} MB")
        res["by_scope"][scope] = sc
        if budget is not None and budget <= 0:
            break
    return res
