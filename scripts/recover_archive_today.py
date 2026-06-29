"""Operator smoke harness for archive.today media-byte recovery.

Default mode is ``plan``: inspect eligible rows only, with no network and no writes.
Live archive.today requests require ``CONTENT_HOARDER_ARCHIVE_TODAY_LIVE=1`` and an
explicit ``--probe`` or ``--apply --yes``. Apply mode refuses the canonical live DB
(``data/app.db``) unless ``--allow-live-db`` is provided; copy the DB first.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
import urllib.parse
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TextIO, cast

# Run from the repo root so `src` is importable without an install.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from content_hoarder import config, db, media_store  # noqa: E402
from content_hoarder.archival.providers import default_media_providers  # noqa: E402
from content_hoarder.archival.service import archive_today_recover_media  # noqa: E402
from content_hoarder.media_archive import DEFAULT_MAX_BYTES, default_fetch  # noqa: E402
from content_hoarder.models import parse_metadata  # noqa: E402

UA = "content-hoarder/0.1 (archive.today media recovery smoke)"
REPORT_NAME = "archive-today-smoke.jsonl"
LIVE_ENV = "CONTENT_HOARDER_ARCHIVE_TODAY_LIVE"


@dataclass
class Candidate:
    fullname: str
    media_status: str
    urls: list[str]
    archived_count: int


def _mode(args: argparse.Namespace) -> str:
    if args.apply:
        return "apply"
    if args.probe:
        return "probe"
    return "plan"


def _canonical_live_db() -> Path:
    return (ROOT / "data" / "app.db").resolve()


def _resolve_db_path() -> Path:
    return Path(config.db_path()).resolve()


def _is_live_db(path: Path) -> bool:
    return path == _canonical_live_db()


def _urls_for_metadata(md: dict[str, Any]) -> list[str]:
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
    return [u for u in out if not (u in seen or seen.add(u))]


def _url_summary(url: str) -> dict[str, str]:
    parsed = urllib.parse.urlparse(url)
    return {
        "host": parsed.netloc.lower(),
        "sha256_12": hashlib.sha256(url.encode("utf-8")).hexdigest()[:12],
    }


def _as_int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float, str)):
        try:
            return int(value)
        except (TypeError, ValueError):
            return 0
    return 0


def _select_candidates(
    db_path: Path, *, fullname: str | None, limit: int, retry_archived: bool
) -> list[Candidate]:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        if fullname:
            rows = conn.execute(
                "SELECT fullname, metadata FROM items WHERE fullname=?",
                (fullname,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT fullname, metadata FROM items "
                "WHERE source='reddit' AND json_extract(metadata, '$.media_status')='gone' "
                "ORDER BY last_seen_utc DESC"
            ).fetchall()
    finally:
        conn.close()

    candidates: list[Candidate] = []
    for row in rows:
        md = parse_metadata(row["metadata"])
        urls = _urls_for_metadata(md)
        if not urls:
            continue
        archived = md.get("archived_media") or {}
        archived_count = len(archived) if isinstance(archived, dict) else 0
        if archived_count and not retry_archived:
            continue
        candidates.append(
            Candidate(
                fullname=row["fullname"],
                media_status=str(md.get("media_status") or ""),
                urls=urls,
                archived_count=archived_count,
            )
        )
        if len(candidates) >= limit:
            break
    return candidates


def _blob_ids_for_item(db_path: Path, fullname: str) -> list[str]:
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            "SELECT metadata FROM items WHERE fullname=?", (fullname,)
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return []
    md = parse_metadata(row[0])
    archived = md.get("archived_media") or {}
    if not isinstance(archived, dict):
        return []
    return [str(blob) for blob in archived.values()]


def _write_report(db_path: Path, row: dict[str, Any]) -> Path:
    report = db_path.parent / REPORT_NAME
    with report.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, sort_keys=True) + "\n")
    return report


def _report_row(
    *,
    mode: str,
    cand: Candidate,
    result: dict[str, Any],
    elapsed_ms: int,
    db_path: Path,
    verbose_urls: bool,
) -> dict[str, Any]:
    blob_ids = _blob_ids_for_item(db_path, cand.fullname) if mode == "apply" else []
    row: dict[str, Any] = {
        "ts": int(time.time()),
        "mode": mode,
        "fullname": cand.fullname,
        "media_status_before": cand.media_status,
        "candidate_original_count": len(cand.urls),
        "snapshot_candidate_count": _as_int(result.get("snapshot_candidates")),
        "bytes_archived": _as_int(result.get("bytes_archived")),
        "blob_ids": blob_ids,
        "elapsed_ms": elapsed_ms,
        "result": result.get("result") or "miss",
        "error_kind": ";".join(result.get("errors") or []),
        "original_url_summaries": [_url_summary(u) for u in cand.urls],
    }
    if verbose_urls:
        row["original_urls"] = cand.urls
    return row


def _print_plan(candidates: list[Candidate], *, out: TextIO) -> None:
    hosts = sorted(
        {urllib.parse.urlparse(u).netloc.lower() for c in candidates for u in c.urls}
    )
    media_url_count = sum(len(c.urls) for c in candidates)
    archived_existing = sum(1 for c in candidates if c.archived_count)
    print("Mode: plan (no network, no writes)", file=out)
    print(f"Eligible items: {len(candidates)}", file=out)
    print(f"Original media URLs: {media_url_count}", file=out)
    print(f"Source hostnames: {', '.join(hosts) if hosts else '-'}", file=out)
    print(f"Already has archived_media: {archived_existing}", file=out)
    for c in candidates:
        print(
            f"  {c.fullname}: {len(c.urls)} url(s), archived_media={c.archived_count}",
            file=out,
        )
    print("Report: not written in plan mode", file=out)


def _run_live_mode(
    args: argparse.Namespace,
    *,
    mode: str,
    db_path: Path,
    candidates: list[Candidate],
    out: TextIO,
) -> int:
    providers = default_media_providers(UA, throttle=True)
    report_path: Path | None = None
    hits = 0
    for cand in candidates:
        started = time.monotonic()
        try:
            fetch = None
            if mode == "apply":
                max_bytes = int(args.max_bytes)

                def fetch_bytes(url: str) -> tuple[bytes | None, str]:
                    return default_fetch(url, max_bytes=max_bytes)

                fetch = fetch_bytes
            conn = db.connect(str(db_path))
            try:
                result = archive_today_recover_media(
                    conn,
                    cand.fullname,
                    providers=providers,
                    fetch_bytes=fetch,
                    apply_bytes=(mode == "apply"),
                )
            finally:
                conn.close()
        except Exception as exc:  # noqa: BLE001 — smoke must keep going per item
            result = {
                "eligible": True,
                "attempted": True,
                "mode": mode,
                "bytes_archived": 0,
                "snapshot_candidates": 0,
                "result": "error",
                "errors": [type(exc).__name__],
            }
        elapsed_ms = int((time.monotonic() - started) * 1000)
        report_path = _write_report(
            db_path,
            _report_row(
                mode=mode,
                cand=cand,
                result=result,
                elapsed_ms=elapsed_ms,
                db_path=db_path,
                verbose_urls=args.verbose_urls,
            ),
        )
        if result.get("result") == "hit":
            hits += 1
        if mode == "probe":
            snapshot_candidates = _as_int(result.get("snapshot_candidates"))
            print(
                f"  {cand.fullname}: {result.get('result')} "
                f"({snapshot_candidates} snapshot candidate(s))",
                file=out,
            )
        else:
            bytes_archived = _as_int(result.get("bytes_archived"))
            print(
                f"  {cand.fullname}: {result.get('result')} "
                f"({bytes_archived} byte blob(s))",
                file=out,
            )
    print(f"Done. {hits}/{len(candidates)} item(s) hit.", file=out)
    if report_path:
        print(f"Report: {report_path}", file=out)
    if mode == "apply":
        print(f"Media directory: {media_store.media_dir()}", file=out)
        print("Reminder: media/ is not in the DB; back it up separately.", file=out)
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="Plan/probe/apply archive.today smoke recovery for gone reddit media."
    )
    modes = ap.add_mutually_exclusive_group()
    modes.add_argument(
        "--probe",
        action="store_true",
        help="Live archive.today HTML lookup only; no DB/media writes.",
    )
    modes.add_argument(
        "--apply",
        action="store_true",
        help="Live lookup + byte fetch + DB/media writes; requires --yes.",
    )
    ap.add_argument("--yes", action="store_true", help="Required with --apply.")
    ap.add_argument(
        "--allow-live-db",
        action="store_true",
        help="Allow apply against canonical data/app.db (not recommended).",
    )
    ap.add_argument("--fullname", help="Safest single-item smoke, e.g. reddit:t3_x.")
    ap.add_argument(
        "--limit",
        type=int,
        default=1,
        help="Max selected items (default 1; capped at 10 unless --yes-many).",
    )
    ap.add_argument("--yes-many", action="store_true", help="Allow --limit above 10.")
    ap.add_argument(
        "--retry-archived",
        action="store_true",
        help="Include rows that already have metadata.archived_media.",
    )
    ap.add_argument(
        "--max-bytes",
        type=int,
        default=DEFAULT_MAX_BYTES,
        help="Per-media byte cap for apply mode.",
    )
    ap.add_argument(
        "--verbose-urls",
        action="store_true",
        help="Include full original URLs in JSONL report.",
    )
    return ap


def main(
    argv: list[str] | None = None,
    *,
    out: TextIO | None = None,
    env: Mapping[str, str] | None = None,
) -> int:
    out_stream = out or sys.stdout
    env_map = env if env is not None else os.environ
    args = build_parser().parse_args(argv)
    mode = _mode(args)
    limit = int(args.limit)
    yes_many = bool(args.yes_many)
    yes = bool(args.yes)
    allow_live_db = bool(args.allow_live_db)
    fullname = cast(str | None, args.fullname)
    retry_archived = bool(args.retry_archived)
    if limit < 1:
        print("ERROR: --limit must be >= 1", file=out_stream)
        return 2
    if limit > 10 and not yes_many:
        print("ERROR: --limit above 10 requires --yes-many", file=out_stream)
        return 2
    if mode in ("probe", "apply") and env_map.get(LIVE_ENV) != "1":
        print(
            f"ERROR: live archive.today requests require {LIVE_ENV}=1", file=out_stream
        )
        return 2
    if mode == "apply" and not yes:
        print("ERROR: --apply requires --yes", file=out_stream)
        return 2

    db_path = _resolve_db_path()
    print(f"DB: {db_path}", file=out_stream)
    print(f"Media directory: {media_store.media_dir()}", file=out_stream)
    if mode == "apply" and _is_live_db(db_path) and not allow_live_db:
        print(
            f"ERROR: refusing apply against canonical live DB {db_path}; copy it first or pass --allow-live-db",
            file=out_stream,
        )
        return 2

    candidates = _select_candidates(
        db_path,
        fullname=fullname,
        limit=limit,
        retry_archived=retry_archived,
    )
    if not candidates:
        print("No eligible gone reddit media items found.", file=out_stream)
        return 0

    if mode == "plan":
        _print_plan(candidates, out=out_stream)
        return 0

    print(
        f"Mode: {mode} ({'writes DB/media' if mode == 'apply' else 'network only; no writes'})",
        file=out_stream,
    )
    return _run_live_mode(
        args, mode=mode, db_path=db_path, candidates=candidates, out=out_stream
    )


if __name__ == "__main__":
    raise SystemExit(main())
