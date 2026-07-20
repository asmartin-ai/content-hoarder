"""ocr.py — opt-in local OCR enrich for archived image bytes (Epic 12 / #26, Spec 14).

Reads ``metadata.archived_media`` blobs under ``data/media/``, runs Tesseract
(injectable for offline tests), and stamps ``metadata.ocr_text`` + ``ocr_at`` so
existing ``build_search_text`` / ``is:ocr`` wiring can find the text.

Dry-run by default. Lazy-imports ``pytesseract`` + Pillow so missing optional
deps never break ``serve`` / ``init-db``. Connectors never touch the DB — this
module is a pipeline-adjacent service like ``media_archive``.
"""

from __future__ import annotations

import json
import re
import shutil
import time
from pathlib import Path
from typing import Any, Callable

from content_hoarder import db, media_store
from content_hoarder.models import build_search_text, parse_metadata

DEFAULT_MIN_CONFIDENCE = 40.0
DEFAULT_LANG = "eng"
DEFAULT_MAX_CHARS = 20_000
MIN_IMAGE_SIDE = 80  # skip decorative / tiny thumbs
_IMAGE_EXT = re.compile(r"\.(png|jpe?g|gif|webp|bmp)$", re.I)
_VIDEO_EXT = re.compile(r"\.(mp4|webm|mov|mkv)$", re.I)


class OcrError(RuntimeError):
    """Raised when the OCR engine / binary is unavailable."""


def tesseract_available() -> bool:
    """True if a tesseract binary is on PATH or a common Windows install path."""
    if shutil.which("tesseract"):
        return True
    for p in (
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    ):
        if Path(p).is_file():
            return True
    return False


def _resolve_tesseract_cmd() -> str | None:
    which = shutil.which("tesseract")
    if which:
        return which
    for p in (
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    ):
        if Path(p).is_file():
            return p
    return None


def default_engine(
    path: str | Path,
    *,
    lang: str = DEFAULT_LANG,
    min_confidence: float = DEFAULT_MIN_CONFIDENCE,
) -> dict[str, Any]:
    """Run Tesseract on one image path. Lazy-imports optional deps.

    Returns ``{"text": str, "mean_confidence": float|None, "engine": "tesseract",
    "engine_version": str}``. Empty text when below confidence or no glyphs.
    """
    try:
        import pytesseract
        from PIL import Image
    except ImportError as e:
        raise OcrError(
            "OCR extras missing — install with: pip install -e '.[ocr]' "
            f"(need pytesseract + Pillow). Import error: {e}"
        ) from e

    cmd = _resolve_tesseract_cmd()
    if not cmd:
        raise OcrError(
            "tesseract binary not found on PATH. Install Tesseract OCR "
            "(e.g. winget install --id UB-Mannheim.TesseractOCR)."
        )
    pytesseract.pytesseract.tesseract_cmd = cmd

    p = Path(path)
    with Image.open(p) as im:
        # First frame only for multi-frame formats in v1.
        im = im.convert("RGB") if im.mode not in ("RGB", "L") else im
        w, h = im.size
        if min(w, h) < MIN_IMAGE_SIDE:
            return {
                "text": "",
                "mean_confidence": None,
                "engine": "tesseract",
                "engine_version": str(pytesseract.get_tesseract_version()),
                "skip_reason": "too_small",
            }
        data = pytesseract.image_to_data(im, lang=lang, output_type=pytesseract.Output.DICT)
        confs = []
        for c in data.get("conf") or []:
            try:
                v = float(c)
            except (TypeError, ValueError):
                continue
            if v >= 0:
                confs.append(v)
        mean_conf = sum(confs) / len(confs) if confs else None
        text = pytesseract.image_to_string(im, lang=lang) or ""
        text = text.strip()
        ver = str(pytesseract.get_tesseract_version())
        if mean_conf is not None and mean_conf < min_confidence:
            return {
                "text": "",
                "mean_confidence": mean_conf,
                "engine": "tesseract",
                "engine_version": ver,
                "skip_reason": "low_confidence",
            }
        return {
            "text": text,
            "mean_confidence": mean_conf,
            "engine": "tesseract",
            "engine_version": ver,
        }


def local_image_blobs(md: dict[str, Any]) -> list[tuple[str, str]]:
    """Return ``[(archive_key, blob_id), ...]`` for local image blobs on the item."""
    arch = md.get("archived_media") or {}
    if not isinstance(arch, dict):
        return []
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for key, blob in arch.items():
        if not isinstance(blob, str) or not blob or blob in seen:
            continue
        if _VIDEO_EXT.search(blob):
            continue
        if not (_IMAGE_EXT.search(blob) or media_store.is_valid_id(blob)):
            # content-addressed ids without image ext still ok if path resolves as image
            if not media_store.is_valid_id(blob):
                continue
        path = media_store.path_for(blob)
        if not path:
            continue
        if _VIDEO_EXT.search(path.name):
            continue
        if not _IMAGE_EXT.search(path.name):
            continue
        seen.add(blob)
        out.append((str(key), blob))
    return out


def needs_ocr(md: dict[str, Any], *, force: bool = False) -> bool:
    if force:
        return True
    if md.get("ocr_at") and (md.get("ocr_text") or md.get("ocr_empty")):
        return False
    return True


def _join_texts(parts: list[str], *, max_chars: int = DEFAULT_MAX_CHARS) -> str:
    text = "\n".join(p for p in parts if p).strip()
    if len(text) > max_chars:
        return text[:max_chars].rstrip()
    return text


def ocr_item(
    conn,
    fullname: str,
    *,
    apply: bool = False,
    force: bool = False,
    lang: str = DEFAULT_LANG,
    min_confidence: float = DEFAULT_MIN_CONFIDENCE,
    engine: Callable[..., dict[str, Any]] = default_engine,
    max_chars: int = DEFAULT_MAX_CHARS,
) -> dict[str, Any]:
    """OCR one item. Returns a result dict; writes only when ``apply``."""
    row = conn.execute(
        "SELECT fullname, metadata FROM items WHERE fullname=?", (fullname,)
    ).fetchone()
    if row is None:
        return {"fullname": fullname, "status": "missing"}
    md = json.loads(row["metadata"] or row[1] or "{}") if not isinstance(row, dict) else json.loads((row.get("metadata") or "{}"))
    # sqlite3.Row support
    if hasattr(row, "keys"):
        md = json.loads(row["metadata"] or "{}")
    blobs = local_image_blobs(md)
    if not blobs:
        return {"fullname": fullname, "status": "no_local_image", "blobs": 0}
    if not needs_ocr(md, force=force):
        return {"fullname": fullname, "status": "skipped", "blobs": len(blobs)}

    texts: list[str] = []
    details: dict[str, Any] = {}
    engine_version = None
    skip_reasons: list[str] = []
    for key, blob in blobs:
        path = media_store.path_for(blob)
        if not path:
            skip_reasons.append("missing_blob")
            continue
        try:
            res = engine(path, lang=lang, min_confidence=min_confidence)
        except OcrError:
            raise
        except Exception as e:
            skip_reasons.append(f"engine_error:{type(e).__name__}")
            continue
        engine_version = res.get("engine_version") or engine_version
        if res.get("skip_reason"):
            skip_reasons.append(str(res["skip_reason"]))
        t = (res.get("text") or "").strip()
        if t:
            texts.append(t)
        details[key] = {
            "blob": blob,
            "chars": len(t),
            "mean_confidence": res.get("mean_confidence"),
            "lang": lang,
        }

    joined = _join_texts(texts, max_chars=max_chars)
    out: dict[str, Any] = {
        "fullname": fullname,
        "status": "ok" if joined else "empty",
        "blobs": len(blobs),
        "chars": len(joined),
        "text_preview": joined[:80],
    }
    if not apply:
        out["status"] = "would_ocr" if joined else "would_empty"
        return out

    now = int(time.time())
    updates: dict[str, Any] = {
        "ocr_at": now,
        "ocr_engine": "tesseract",
        "ocr_details": details,
    }
    if engine_version:
        updates["ocr_engine_version"] = str(engine_version)
    if joined:
        updates["ocr_text"] = joined
        updates["ocr_empty"] = False
    else:
        # Keep is:ocr false (no truthy ocr_text); stamp empty so we don't retry forever.
        updates["ocr_empty"] = True
        # Explicitly clear prior text if force re-run produced nothing.
        # patch_item_metadata skips falsy values — use a direct write path.
        item_row = conn.execute("SELECT * FROM items WHERE fullname=?", (fullname,)).fetchone()
        full = dict(item_row)
        md2 = parse_metadata(full.get("metadata"))
        md2.update(updates)
        # Prefer absence of key for is:ocr filter
        md2.pop("ocr_text", None)
        full["metadata"] = json.dumps(md2, ensure_ascii=False)
        full["search_text"] = build_search_text(full, md2)
        conn.execute(
            "UPDATE items SET metadata=?, search_text=? WHERE fullname=?",
            (full["metadata"], full["search_text"], fullname),
        )
        conn.commit()
        out["status"] = "empty"
        out["applied"] = True
        return out

    # Success with text — rebuild search_text via build_search_text.
    # Also clear ocr_empty if previously set.
    item_row = conn.execute("SELECT * FROM items WHERE fullname=?", (fullname,)).fetchone()
    full = dict(item_row)
    md2 = parse_metadata(full.get("metadata"))
    md2.update(updates)
    md2.pop("ocr_empty", None)
    full["metadata"] = json.dumps(md2, ensure_ascii=False)
    full["search_text"] = build_search_text(full, md2)
    conn.execute(
        "UPDATE items SET metadata=?, search_text=? WHERE fullname=?",
        (full["metadata"], full["search_text"], fullname),
    )
    conn.commit()
    out["applied"] = True
    out["status"] = "ok"
    return out


def ocr_all(
    conn,
    *,
    limit: int | None = None,
    apply: bool = False,
    force: bool = False,
    lang: str = DEFAULT_LANG,
    min_confidence: float = DEFAULT_MIN_CONFIDENCE,
    engine: Callable[..., dict[str, Any]] = default_engine,
    throttle: float = 0.0,
    sleep=time.sleep,
    progress: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Batch OCR over items that have local archived images."""
    res: dict[str, Any] = {
        "items": 0,
        "ocr_ok": 0,
        "empty": 0,
        "skipped": 0,
        "no_local_image": 0,
        "failed": 0,
        "applied": apply,
        "fail_reasons": {},
    }
    # Cheap prefilter: rows that mention archived_media (JSON key). Further filtered in Python.
    rows = conn.execute(
        "SELECT fullname, metadata FROM items "
        "WHERE metadata LIKE '%archived_media%' "
        "ORDER BY last_seen_utc DESC"
    ).fetchall()
    budget = limit
    for row in rows:
        if budget is not None and budget <= 0:
            break
        fn = row["fullname"] if hasattr(row, "keys") else row[0]
        meta = row["metadata"] if hasattr(row, "keys") else row[1]
        try:
            md = json.loads(meta or "{}")
        except (TypeError, ValueError):
            continue
        if not local_image_blobs(md):
            continue
        if not needs_ocr(md, force=force):
            res["skipped"] += 1
            continue
        res["items"] += 1
        if budget is not None:
            budget -= 1
        try:
            one = ocr_item(
                conn,
                fn,
                apply=apply,
                force=force,
                lang=lang,
                min_confidence=min_confidence,
                engine=engine,
            )
        except OcrError as e:
            res["failed"] += 1
            reason = "ocr_unavailable"
            res["fail_reasons"][reason] = res["fail_reasons"].get(reason, 0) + 1
            if progress:
                progress(f"ocr unavailable: {e}")
            # Don't hammer every item if binary missing.
            break
        st = one.get("status")
        if st in ("ok", "would_ocr"):
            res["ocr_ok"] += 1
        elif st in ("empty", "would_empty"):
            res["empty"] += 1
        elif st == "skipped":
            res["skipped"] += 1
        elif st == "no_local_image":
            res["no_local_image"] += 1
        else:
            res["failed"] += 1
            res["fail_reasons"][st or "error"] = res["fail_reasons"].get(st or "error", 0) + 1
        if progress:
            progress(f"{fn}: {st} chars={one.get('chars', 0)}")
        if throttle and apply:
            sleep(throttle)
    return res
