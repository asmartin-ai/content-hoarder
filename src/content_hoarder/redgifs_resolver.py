"""WP2 Task 25 — RedGifs resolver.

Gfycat shut down 2023-09-01. ~1,090 gfycat.com media_url items are dead.
NSFW Gfycat migrated to RedGifs under the same id (lowercase→CamelCase).
This resolver: extracts Gfycat id, resolves via RedGifs API, rewrites media_url.

RedGifs API docs: https://redgifs.readthedocs.io/en/stable/migrating.html
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from content_hoarder import config
from content_hoarder.media_store import is_valid_id, media_dir, path_for, store
from content_hoarder.models import parse_metadata

_USER_AGENT = config.get("USER_AGENT")
_RG_BASE = "https://api.redgifs.com"

# Gfycat URL patterns:
# https://gfycat.com/<id>
# https://gfycat.com/ifr/<id>
# https://gfycat.com/gifs/detail/<id>
_GFYCAT_RE = re.compile(r"gfycat\.com/(?:ifr/|gifs/detail/|gallery/)?([a-zA-Z0-9-]+)")

# Cache token to avoid re-auth per item
_token_cache: dict = {"token": None, "expires_at": 0}


def _get_token() -> str | None:
    """Get a temporary RedGifs API token (anonymous, no user auth needed)."""
    now = time.time()
    if _token_cache["token"] and now < _token_cache["expires_at"] - 60:
        return _token_cache["token"]

    try:
        req = urllib.request.Request(
            _RG_BASE + "/v2/auth/temporary",
            method="GET",
            headers={"User-Agent": _USER_AGENT, "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        token = data.get("token") or data.get("access_token")
        if token:
            _token_cache["token"] = token
            _token_cache["expires_at"] = now + 3600  # tokens last ~1h
        return token
    except Exception:
        return None


def extract_gfycat_id(url: str) -> str | None:
    """Extract the Gfycat id from a gfycat.com URL."""
    m = _GFYCAT_RE.search(url or "")
    return m.group(1) if m else None


def gfycat_to_redgifs_id(gfy_id: str) -> str:
    """Gfycat IDs are lowercase; RedGifs uses CamelCase."""
    if not gfy_id:
        return gfy_id
    return gfy_id[0].upper() + gfy_id[1:] if len(gfy_id) > 1 else gfy_id.upper()


def resolve_gfycat(url: str) -> dict | None:
    """Resolve a Gfycat URL to a live RedGifs media URL.

    Returns dict with redgifs media info, or None if unresolvable:
    {
        "redgifs_url": "https://redgifs.com/watch/...",
        "media_url": "https://...mp4",
        "media_type": "redgifs_video",
        "poster_url": "https://...jpg",
        "gfycat_id": "...",
    }
    """
    gfy_id = extract_gfycat_id(url)
    if not gfy_id:
        return None

    rg_id = gfycat_to_redgifs_id(gfy_id)
    token = _get_token()
    if not token:
        return None

    try:
        req = urllib.request.Request(
            _RG_BASE + f"/v2/gifs/{rg_id}",
            headers={
                "User-Agent": _USER_AGENT,
                "Authorization": f"Bearer {token}",
            },
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None  # not found on RedGifs
        return None  # other error
    except Exception:
        return None

    gif_data = data.get("gif") or {}
    urls = gif_data.get("urls") or {}
    media_url = urls.get("hd") or urls.get("sd") or ""
    poster_url = urls.get("poster") or urls.get("thumbnail") or ""
    redgifs_url = f"https://redgifs.com/watch/{rg_id}"

    if not media_url:
        return None

    return {
        "redgifs_url": redgifs_url,
        "media_url": media_url,
        "media_type": "redgifs_video",
        "poster_url": poster_url,
        "gfycat_id": gfy_id,
    }


def rewrite_item(conn, fullname: str, info: dict) -> bool:
    """Rewrite an item's metadata with resolved RedGifs info.

    Returns True if rewritten, False if item missing/resolution empty.
    """
    if not info:
        return False

    row = conn.execute(
        "SELECT metadata FROM items WHERE fullname=?", (fullname,)
    ).fetchone()
    if row is None:
        return False

    md = parse_metadata(row["metadata"])
    md["media_url"] = info["media_url"]
    md["media_type"] = info["media_type"]
    if info.get("poster_url"):
        md["thumbnail"] = info["poster_url"]
    md["redgifs_url"] = info["redgifs_url"]
    md["gfycat_id"] = info["gfycat_id"]
    md["media_resolved_at"] = int(time.time())
    md["media_resolved_from"] = "redgifs"

    conn.execute(
        "UPDATE items SET metadata=? WHERE fullname=?",
        (json.dumps(md, ensure_ascii=False), fullname),
    )
    return True


def resolve_all(
    conn,
    *,
    limit: int | None = None,
    dry_run: bool = False,
    allow_network: bool = False,
) -> dict:
    """Find all gfycat items and attempt RedGifs resolution.

    Args:
        allow_network: When False (default), the function counts candidates but never
            calls the RedGifs API. This safe-by-default behaviour requires an
            explicit opt-in (``--redgifs-ok``) before any network requests are made.

    Returns:
        dict with keys ``total``, ``resolved``, ``failed``, ``dry_run``,
        ``samples``, ``network``, ``requires_opt_in``, and ``message``.
    """
    sql = """
        SELECT fullname, json_extract(metadata, '$.media_url') AS mu
        FROM items
        WHERE json_extract(metadata, '$.media_url') LIKE '%gfycat.com%'
          AND json_extract(metadata, '$.media_resolved_from') IS NULL
        ORDER BY last_seen_utc DESC
    """
    params: list = []
    if limit:
        sql += " LIMIT ?"
        params.append(int(limit))

    rows = conn.execute(sql, params).fetchall()
    total = len(rows)

    if not allow_network:
        return {
            "total": total,
            "resolved": 0,
            "failed": 0,
            "dry_run": dry_run,
            "samples": [],
            "network": False,
            "requires_opt_in": True,
            "message": (
                "RedGifs network resolution is not enabled. "
                "Re-run with --redgifs-ok to activate RedGifs resolution."
            ),
        }

    resolved = 0
    failed = 0
    samples: list[dict] = []

    for r in rows:
        fn = r["fullname"]
        mu = r["mu"]
        info = resolve_gfycat(mu)
        if info:
            resolved += 1
            if not dry_run:
                rewrite_item(conn, fn, info)
            if len(samples) < 5:
                samples.append(
                    {
                        "fullname": fn,
                        "gfycat_id": info["gfycat_id"],
                        "redgifs_url": info["redgifs_url"],
                    }
                )
        else:
            failed += 1

    if not dry_run:
        conn.commit()

    return {
        "total": total,
        "resolved": resolved,
        "failed": failed,
        "dry_run": dry_run,
        "samples": samples,
        "network": True,
        "requires_opt_in": False,
        "message": "",
    }
