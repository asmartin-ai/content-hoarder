"""media_store.py — content-addressed on-disk blob store for local media archiving (Epic 4 P1).

Bytes live under ``data/media/<sha256>.<ext>`` (flat, content-addressed). Content-addressing
gives free dedup — identical bytes across reposts share one file — and keeps the SQLite DB lean
(no blobs in the DB). The directory is gitignored and is the ONLY copy of rescued deleted media,
so it must be backed up SEPARATELY from the metadata-only DB backups.

Deliberately dependency-light + side-effect-isolated (its own module, off the hot paths) so the
whole feature can be toggled/removed without touching the rest of the app. A "blob id" is the
on-disk filename (``<64-hex-sha256>.<ext>``); it's what gets stored on ``metadata.archived_media``
and served by the ``/media/<blob>`` route.
"""
from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

from content_hoarder import config

# mime -> extension; the inverse drives the served Content-Type in web.py.
_MIME_EXT = {
    "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
    "image/gif": ".gif", "image/webp": ".webp",
    "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
}
_EXT_MIME = {".jpg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
             ".webp": "image/webp", ".mp4": "video/mp4", ".webm": "video/webm",
             ".mov": "video/quicktime", ".bin": "application/octet-stream"}
_BLOB_RE = re.compile(r"^[0-9a-f]{64}(\.(jpg|png|gif|webp|mp4|webm|mov|bin))?$")


def media_dir() -> Path:
    """``<dir-of-the-DB>/media`` — beside data/app.db, so it travels with the data dir."""
    return Path(config.db_path()).resolve().parent / "media"


def ext_for(mime: str = "", url: str = "") -> str:
    m = (mime or "").split(";")[0].strip().lower()
    if m in _MIME_EXT:
        return _MIME_EXT[m]
    low = (url or "").lower()
    for e in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp4", ".webm", ".mov"):
        if e in low:
            return ".jpg" if e == ".jpeg" else e
    return ".bin"


def mime_for(blob_id: str) -> str:
    ext = Path(blob_id).suffix.lower()
    return _EXT_MIME.get(ext, "application/octet-stream")


def store(data: bytes, *, mime: str = "", url: str = "", base_dir: Path | None = None) -> str:
    """Write bytes content-addressed; return the blob id (``<sha256>.<ext>``). Idempotent —
    re-storing identical bytes is a no-op (dedup). Writes via a temp file + atomic replace so a
    crash never leaves a half-written blob."""
    h = hashlib.sha256(data).hexdigest()
    d = base_dir or media_dir()
    d.mkdir(parents=True, exist_ok=True)
    blob_id = h + ext_for(mime, url)
    p = d / blob_id
    if not p.exists():
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, p)  # atomic on the same filesystem
    return blob_id


def is_valid_id(blob_id: str) -> bool:
    """A blob id is exactly a 64-hex sha256 with an optional known extension — no slashes,
    no traversal. The serving route MUST gate on this before touching the filesystem."""
    return bool(blob_id) and bool(_BLOB_RE.match(blob_id))


def path_for(blob_id: str, *, base_dir: Path | None = None) -> Path | None:
    """Resolve a blob id to its file, or None (missing / invalid). Path-traversal safe."""
    if not is_valid_id(blob_id):
        return None
    d = base_dir or media_dir()
    base = blob_id.split(".")[0]
    if "." in blob_id:
        p = d / blob_id
        return p if p.exists() else None
    for e in (".jpg", ".png", ".gif", ".webp", ".mp4", ".webm", ".mov", ".bin"):  # bare hash → find the stored ext
        p = d / (base + e)
        if p.exists():
            return p
    return None
