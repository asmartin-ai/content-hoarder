"""Probe saved reddit image/gallery items for deleted media and classify them (Epic 4 P1
groundwork). Promoted from the one-off ``scripts/scan_deleted_media.py`` into a real,
config-driven, injectable-HTTP, testable pass.

For each media item we probe the image URL(s) the UI would display:
  - ALIVE         : the full image still loads (HTTP 200)              -> no change
  - SALVAGEABLE   : the full image is gone (403/404/410) but a preview
                    variant still loads -> record the live URL for archiving (Epic 4 P1)
  - GONE          : every known variant is gone -> unrecoverable
  - UNKNOWN       : transient/rate-limited (no decisive code) -> re-probe later

GONE items get a durable ``metadata.media_status='gone'`` (which ``categorize`` never
touches) plus a mirrored ``deleted`` tag for the filter UI. SALVAGEABLE items get
``metadata.media_status='salvageable'``. The durable filter is the ``is:deleted`` operator
(keyed on ``media_status``); the ``deleted`` tag is convenience only (a retag can wipe it).

Crash-safe + resumable: probes run concurrently in batches and each batch is COMMITTED
before the next, so a crash never loses prior progress nor holds a long write lock. Re-running
skips items already carrying a ``media_status`` (unless ``recheck``). Non-destructive: existing
tags are read and preserved. ``apply=False`` (default) probes + classifies but writes nothing.
"""
from __future__ import annotations

import json
import re
import sqlite3
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

# A browser-like UA — the probes hit the i.redd.it / preview.redd.it CDNs (not the API), so
# this is the transport identity, separate from the reddit OAuth/cookie paths.
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
_IMG = re.compile(r"\.(png|jpe?g|gif|webp|bmp)(\?|#|$)", re.I)
DEAD_CODES = (403, 404, 410)


def _direct_img(u: str) -> bool:
    return bool(u) and (bool(_IMG.search(u)) or "i.redd.it" in u)


def is_media(m: dict, url: str) -> bool:
    """Whether an item carries probe-able image/gallery media."""
    if m.get("media_type") in ("image", "gallery"):
        return True
    if isinstance(m.get("gallery"), list) and m["gallery"]:
        return True
    if "/gallery/" in (url or ""):
        return True
    return _direct_img(url) or _direct_img(m.get("media_url") or "")


def best_and_preview(m: dict, url: str) -> tuple[str, str]:
    """``(full_image_url, preview_url)`` the UI would display, ``''`` when absent."""
    gal = m.get("gallery")
    if isinstance(gal, list) and gal:
        best = gal[0]
    elif _direct_img(url):
        best = url
    elif _direct_img(m.get("media_url") or ""):
        best = m.get("media_url")
    elif m.get("media_type") == "image":
        best = m.get("media_url") or ""
    else:
        best = ""
    prev = m.get("thumbnail") or ""
    if "redd.it" not in prev:
        prev = ""
    if not best:
        best, prev = prev, ""
    return best, prev


def default_probe(u: str) -> int:
    """HTTP status of a GET (``-1`` on transport failure). Injectable for tests."""
    req = urllib.request.Request(u, headers={"User-Agent": UA}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:  # noqa: BLE001 - any transport error is an indecisive "unknown"
        return -1


def classify(target: tuple, probe: Callable[[str], int]) -> tuple:
    """``(fullname, best, prev, tags)`` -> ``(fullname, status, live_url, tags)``."""
    fn, best, prev, tags = target
    code = probe(best)
    if code == 200:
        return fn, "alive", None, tags
    if code in DEAD_CODES:
        if prev and prev != best and probe(prev) == 200:
            return fn, "salvageable", prev, tags
        return fn, "gone", None, tags
    return fn, "unknown", None, tags


def _targets(conn: sqlite3.Connection, *, status: str | None, recheck: bool) -> list[tuple]:
    sql = "SELECT fullname, status, url, metadata FROM items WHERE source='reddit'"
    params: list = []
    if status:
        sql += " AND status=?"
        params.append(status)
    out: list[tuple] = []
    for r in conn.execute(sql, params).fetchall():
        m = json.loads(r["metadata"] or "{}")
        if not is_media(m, r["url"]):
            continue
        if not recheck and m.get("media_status"):
            continue
        best, prev = best_and_preview(m, r["url"])
        if best:
            out.append((r["fullname"], best, prev, list(m.get("tags") or [])))
    return out


def scan(
    conn: sqlite3.Connection,
    *,
    status: str | None = None,
    limit: int | None = None,
    recheck: bool = False,
    apply: bool = False,
    workers: int = 10,
    batch: int = 200,
    probe: Callable[[str], int] = default_probe,
    progress: Callable[[str], None] | None = None,
) -> dict:
    """Probe + classify reddit media items; with ``apply`` stamp media_status (+ deleted tag).

    Returns ``{scanned, alive, salvageable, gone, unknown, applied, status_filter,
    salvageable_items}``. Crash-safe: each batch commits before the next.
    """
    targets = _targets(conn, status=status, recheck=recheck)
    if limit:
        targets = targets[:limit]

    counts = {"alive": 0, "salvageable": 0, "gone": 0, "unknown": 0}
    salvageable_items: list[dict] = []

    def _run(t):  # bind the injected probe into the threaded worker
        return classify(t, probe)

    with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        for start in range(0, len(targets), batch):
            chunk = targets[start:start + batch]
            for fn, st, live, tags in ex.map(_run, chunk):
                counts[st] += 1
                if st == "salvageable":
                    salvageable_items.append({"fullname": fn, "live_url": live})
                if apply and st in ("gone", "salvageable"):
                    patch: dict = {"media_status": st}
                    if st == "salvageable" and live:
                        # durable on the item — the future archive-media pass (Epic 4 P1) reads
                        # this; the JSON manifest is only a report and can be overwritten.
                        patch["media_salvage_url"] = live
                    if st == "gone" and "deleted" not in tags:
                        patch["tags"] = tags + ["deleted"]  # json_patch replaces the array; existing kept
                    conn.execute(
                        "UPDATE items SET metadata=json_patch(metadata, ?) WHERE fullname=?",
                        (json.dumps(patch), fn),
                    )
            if apply:
                conn.commit()  # per-batch: crash-safe, never a long write lock
            if progress:
                done = start + len(chunk)
                progress(f"  ...{done}/{len(targets)}  alive={counts['alive']} "
                         f"salvage={counts['salvageable']} gone={counts['gone']} "
                         f"unknown={counts['unknown']}")

    return {"scanned": len(targets), **counts, "applied": apply,
            "status_filter": status, "salvageable_items": salvageable_items}
