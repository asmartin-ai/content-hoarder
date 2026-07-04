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
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

from content_hoarder import media_store
from content_hoarder._http import safe_fetch_url

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
DEFAULT_MAX_BYTES = 15 * 1024 * 1024  # 15 MB/media cap — skip pathological originals
DEFAULT_MAX_VIDEO_BYTES = (
    512 * 1024 * 1024
)  # videos are opt-in and much larger than images
DEFAULT_VIDEO_TIMEOUT = 15 * 60
_IMG_RE = re.compile(r"\.(png|jpe?g|gif|webp|bmp)(\?|#|$)", re.I)
_VIDEO_RE = re.compile(r"\.(mp4|webm|mov)(\?|#|$)", re.I)
_VREDDIT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
SCOPES = ("salvageable", "galleries", "images", "twitter", "videos")


def _is_img(u: str) -> bool:
    return bool(u) and (bool(_IMG_RE.search(u)) or "i.redd.it" in u)


def _is_twitter_img(u: str) -> bool:
    return bool(u) and "pbs.twimg.com/media/" in u and _is_img(u)


def _is_twitter_media(u: str) -> bool:
    return _is_twitter_img(u) or (
        bool(u) and "video.twimg.com/" in u and bool(_VIDEO_RE.search(u))
    )


def reddit_video_id(url: str) -> str | None:
    """Extract the canonical v.redd.it id from bare, fallback-MP4, HLS, or DASH URLs."""
    if not url:
        return None
    try:
        p = urllib.parse.urlparse(url)
    except Exception:
        return None
    if p.scheme not in ("http", "https") or p.netloc.lower() != "v.redd.it":
        return None
    parts = [seg for seg in p.path.split("/") if seg]
    if not parts:
        return None
    vid = parts[0]
    return vid if _VREDDIT_ID_RE.match(vid) else None


def is_vreddit_url(url: str) -> bool:
    return reddit_video_id(url) is not None


def canonical_vreddit_url(url: str) -> str | None:
    vid = reddit_video_id(url)
    return f"https://v.redd.it/{vid}" if vid else None


def default_fetch(
    url: str, *, max_bytes: int = DEFAULT_MAX_BYTES
) -> tuple[bytes | None, str]:
    """GET the URL → ``(bytes, mime)`` or ``(None, reason)``. Injectable for tests.

    SSRF gate: URLs resolving to loopback/private/link-local hosts are rejected
    before any network call is made.
    """
    allowed, reason = safe_fetch_url(url)
    if not allowed:
        return None, "blocked_" + reason
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


def _urls_for(md: dict[str, Any], scope: str) -> list[str]:
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
    elif scope == "twitter":
        out += [u for u in (md.get("media_urls") or []) if _is_twitter_media(u)]
    seen: set[str] = set()
    return [u for u in out if not (u in seen or seen.add(u))]


def _video_evidence_urls(item_url: str, md: dict[str, Any]) -> list[str]:
    rv = md.get("reddit_video") or {}
    if not isinstance(rv, dict):
        rv = {}
    raw = [
        md.get("media_url"),
        rv.get("fallback_url"),
        rv.get("hls_url"),
        rv.get("dash_url"),
        item_url,
    ]
    seen: set[str] = set()
    return [u for u in raw if u and not (u in seen or seen.add(u))]


def _video_candidate(
    fullname: str, item_url: str, md: dict[str, Any]
) -> dict[str, Any] | None:
    """Pure DB/metadata inspection for one Reddit-hosted video archive candidate."""
    evidence = _video_evidence_urls(item_url, md)
    first_vreddit = next((u for u in evidence if reddit_video_id(u)), "")
    if not first_vreddit:
        return None
    canonical = canonical_vreddit_url(first_vreddit)
    if not canonical:
        return None
    media_url = str(md.get("media_url") or "")
    primary_key = media_url if reddit_video_id(media_url) else canonical
    source_url = item_url if item_url and "reddit.com" in item_url.lower() else ""
    source_url = source_url or media_url or canonical
    archive_keys = [primary_key, canonical]
    seen: set[str] = set()
    archive_keys = [u for u in archive_keys if u and not (u in seen or seen.add(u))]
    rv = md.get("reddit_video") or {}
    if not isinstance(rv, dict):
        rv = {}
    return {
        "fullname": fullname,
        "kind": "reddit_video",
        "video_id": reddit_video_id(first_vreddit),
        "canonical_url": canonical,
        "source_url": source_url,
        "media_url": media_url,
        "archive_keys": archive_keys,
        "has_audio": rv.get("has_audio"),
        "is_gif": rv.get("is_gif"),
        "duration": rv.get("duration"),
        "width": rv.get("width"),
        "height": rv.get("height"),
    }


def _present_archived_blob(arch: dict[str, Any], keys: list[str]) -> str | None:
    for key in keys:
        blob = arch.get(key)
        if isinstance(blob, str) and media_store.path_for(blob):
            return blob
    return None


def _candidates_sql(scope: str) -> str:
    base = "source='reddit'"
    if scope == "salvageable":
        return base + " AND json_extract(metadata, '$.media_salvage_url') IS NOT NULL"
    if scope == "galleries":
        return base + " AND json_extract(metadata, '$.gallery_preview') IS NOT NULL"
    if scope == "twitter":
        return "source='twitter' AND json_extract(metadata, '$.media_urls') IS NOT NULL"
    if scope == "videos":
        return (
            base + " AND (json_extract(metadata, '$.media_type') = 'reddit_video'"
            " OR json_extract(metadata, '$.media_url') LIKE '%v.redd.it%'"
            " OR url LIKE '%v.redd.it%')"
        )
    # images: an image-shaped media_url that isn't already known-gone
    return (
        base + " AND COALESCE(json_extract(metadata, '$.media_status'),'') <> 'gone'"
        " AND (json_extract(metadata, '$.media_url') LIKE '%i.redd.it%'"
        " OR json_extract(metadata, '$.media_url') LIKE '%.jpg%'"
        " OR json_extract(metadata, '$.media_url') LIKE '%.png%'"
        " OR json_extract(metadata, '$.media_url') LIKE '%.webp%'"
        " OR json_extract(metadata, '$.media_url') LIKE '%.gif%')"
    )


def default_video_downloader(
    candidate: dict[str, Any],
    temp_dir: str | Path,
    *,
    max_bytes: int = DEFAULT_MAX_VIDEO_BYTES,
    timeout: float = DEFAULT_VIDEO_TIMEOUT,
) -> tuple[Path | None, dict[str, Any] | str]:
    """Download/mux one Reddit video with yt-dlp. Lazy/optional and injectable for tests."""
    exe = shutil.which("yt-dlp")
    if not exe:
        return None, "missing_downloader"
    out_tpl = str(Path(temp_dir) / "%(id)s.%(ext)s")
    cmd = [
        exe,
        "--no-playlist",
        "--format",
        "bv*+ba",
        "--merge-output-format",
        "mp4",
        "--paths",
        str(temp_dir),
        "--output",
        out_tpl,
        "--print",
        "after_move:filepath",
        candidate["source_url"],
    ]
    try:
        env = os.environ.copy()
        env["TMP"] = str(temp_dir)
        env["TEMP"] = str(temp_dir)
        cp = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, check=False, env=env
        )
    except subprocess.TimeoutExpired:
        return None, "timeout"
    except OSError:
        return None, "extractor_error"
    if cp.returncode != 0:
        err = (cp.stderr or "").lower()
        if "ffmpeg" in err or "merge" in err or "mux" in err:
            return None, "missing_ffmpeg_or_mux_failed"
        return None, "extractor_error"
    paths = [line.strip() for line in (cp.stdout or "").splitlines() if line.strip()]
    if not paths:
        paths = [str(p) for p in Path(temp_dir).glob("*.mp4")]
    if not paths:
        return None, "extractor_error"
    path = Path(paths[-1])
    if not path.exists():
        return None, "extractor_error"
    if path.stat().st_size > max_bytes:
        try:
            path.unlink()
        except OSError:
            pass
        return None, "too_large"
    return path, {
        "mime": "video/mp4",
        "downloader": "yt-dlp",
        "container": "mp4",
        "has_audio": True,
    }


def archive(
    conn,
    *,
    scopes=("salvageable", "galleries"),
    limit: int | None = None,
    apply: bool = False,
    fetch: Callable[..., tuple[Any, ...]] = default_fetch,
    video_downloader: Callable[..., tuple[Any, ...]] = default_video_downloader,
    throttle: float = 0.3,
    max_bytes: int = DEFAULT_MAX_BYTES,
    max_video_bytes: int = DEFAULT_MAX_VIDEO_BYTES,
    video_timeout: float = DEFAULT_VIDEO_TIMEOUT,
    sleep=time.sleep,
    progress: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Archive media bytes for items in ``scopes``. Returns counts + bytes. ``limit`` caps the
    number of ITEMS that have work (per the whole run). Commits per item (crash-safe/resumable)."""
    res: dict[str, Any] = {
        "items": 0,
        "urls": 0,
        "archived": 0,
        "skipped": 0,
        "failed": 0,
        "bytes": 0,
        "applied": apply,
        "by_scope": {},
        "fail_reasons": {},
    }
    budget = limit
    for scope in scopes:
        if scope not in SCOPES:
            continue
        sc = {"items": 0, "archived": 0, "failed": 0, "skipped": 0}
        rows = conn.execute(
            f"SELECT fullname, url, metadata FROM items WHERE {_candidates_sql(scope)}"
        ).fetchall()
        for fn, item_url, meta in rows:
            if budget is not None and budget <= 0:
                break
            md = json.loads(meta or "{}")
            arch = dict(md.get("archived_media") or {})
            if scope == "videos":
                cand = _video_candidate(fn, item_url or "", md)
                if not cand:
                    continue
                if _present_archived_blob(arch, cand["archive_keys"]):
                    res["skipped"] += 1
                    sc["skipped"] += 1
                    continue
                res["items"] += 1
                sc["items"] += 1
                res["urls"] += 1
                if budget is not None:
                    budget -= 1
                if not apply:
                    continue
                reason: str | None = None
                try:
                    tmp_parent = media_store.media_dir().parent / "tmp"
                    tmp_parent.mkdir(parents=True, exist_ok=True)
                    with tempfile.TemporaryDirectory(
                        prefix="content-hoarder-vreddit-", dir=tmp_parent
                    ) as td:
                        out_path, info = video_downloader(
                            cand,
                            td,
                            max_bytes=max_video_bytes,
                            timeout=video_timeout,
                        )
                        if out_path is None:
                            reason = str(info or "error")
                        else:
                            p = Path(out_path)
                            size = p.stat().st_size
                            if size > max_video_bytes:
                                reason = "too_large"
                            else:
                                details = dict(info) if isinstance(info, dict) else {}
                                mime = details.get("mime") or "video/mp4"
                                blob = media_store.store_path(
                                    p, mime=mime, url=cand["canonical_url"]
                                )
                                if not media_store.path_for(blob):
                                    reason = "disk_error"
                                else:
                                    for key in cand["archive_keys"]:
                                        arch[key] = blob
                                    amd = dict(md.get("archived_media_details") or {})
                                    amd[cand["canonical_url"]] = {
                                        "kind": "reddit_video",
                                        "blob": blob,
                                        "canonical_url": cand["canonical_url"],
                                        "source_url": cand["source_url"],
                                        "downloader": details.get("downloader")
                                        or "yt-dlp",
                                        "container": details.get("container") or "mp4",
                                        "has_audio": details.get(
                                            "has_audio", cand.get("has_audio")
                                        ),
                                        "bytes": size,
                                        "fetched_utc": int(time.time()),
                                    }
                                    conn.execute(
                                        "UPDATE items SET metadata=json_set(json_set(metadata, "
                                        "'$.archived_media', json(?)), "
                                        "'$.archived_media_details', json(?)) WHERE fullname=?",
                                        (json.dumps(arch), json.dumps(amd), fn),
                                    )
                                    conn.commit()
                                    res["archived"] += 1
                                    sc["archived"] += 1
                                    res["bytes"] += size
                except OSError:
                    reason = "disk_error"
                if reason:
                    res["failed"] += 1
                    sc["failed"] += 1
                    res["fail_reasons"][reason] = res["fail_reasons"].get(reason, 0) + 1
                if throttle:
                    sleep(throttle)
                continue

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
                    res["fail_reasons"][mime] = res["fail_reasons"].get(mime, 0) + 1
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
                progress(
                    f"  [{scope}] {res['items']} items, {res['archived']} blobs, "
                    f"{res['bytes'] // 1024 // 1024} MB"
                )
        res["by_scope"][scope] = sc
        if budget is not None and budget <= 0:
            break
    return res
