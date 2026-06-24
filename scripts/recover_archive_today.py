"""Standalone runner: archive.today media-byte recovery for `gone` reddit items.

This is the live-smoke harness for the (currently dormant) ArchiveTodayProvider until
a proper CLI flag lands. Run against a COPY of the live DB — it hits the real archive.ph
network (Cloudflare-gated, ~2s throttle each).

Usage (Git Bash on Windows):
    python scripts/recover_archive_today.py --limit 5
    CONTENT_HOARDER_DB=data/app.smoke.db python scripts/recover_archive_today.py --limit 5 --apply
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

# Run from the repo root so `src` is importable without an install.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from content_hoarder import config, db, media_store  # noqa: E402
from content_hoarder.archival.service import recover_one  # noqa: E402
from content_hoarder.archival.providers import default_media_providers  # noqa: E402

UA = "content-hoarder/0.1 (archive.today media recovery)"


def main() -> int:
    ap = argparse.ArgumentParser(description="Recover media bytes from archive.today for gone reddit items.")
    ap.add_argument("--limit", type=int, default=5,
                    help="Max items to attempt this run (default 5 — archive.today is slow/Cloudflare-gated).")
    ap.add_argument("--apply", action="store_true",
                    help="Actually fetch bytes + write to DB. WITHOUT it: dry-run (reports hits only, writes nothing).")
    args = ap.parse_args()

    path = config.db_path()
    print(f"DB: {path}")
    print(f"Mode: {'APPLY (will fetch + write)' if args.apply else 'DRY-RUN (no writes)'}")
    if not args.apply:
        print("  (add --apply to actually recover + store bytes)")

    # Select gone image items (mirror media_archive's images scope, minus the gone exclusion).
    where = ("source='reddit' AND json_extract(metadata, '$.media_status')='gone' "
             "AND json_extract(metadata, '$.media_url') LIKE '%i.redd.it%'")
    rows = sqlite3.connect(path).execute(
        f"SELECT fullname FROM items WHERE {where} LIMIT ?", (args.limit,)
    ).fetchall()
    if not rows:
        print("No 'gone' i.redd.it items found — nothing to attempt.")
        return 0
    print(f"Attempting {len(rows)} item(s)...\n")

    providers = default_media_providers(UA, throttle=True)  # ~2s spacing
    conn = db.connect(path)
    hits = 0
    for (fn,) in rows:
        try:
            res = recover_one(conn, fn, media_providers=providers, apply_bytes=args.apply)
        except Exception as e:  # noqa: BLE001 — keep going per-item on network blips
            print(f"  {fn}: ERROR {e}")
            continue
        n = res.get("bytes_archived", 0) if res else 0
        if n:
            hits += 1
            md = json.loads(db.get_item(conn, fn)["metadata"])
            print(f"  {fn}: RECOVERED {n} image(s)")
            for url, blob in md.get("archived_media", {}).items():
                p = media_store.path_for(blob)
                size = p.stat().st_size if p else 0
                print(f"      {blob}  ({size} bytes)  <- {url}")
        else:
            print(f"  {fn}: no snapshot / no bytes (miss)")

    print(f"\nDone. {hits}/{len(rows)} items recovered.")
    if hits and args.apply:
        print("NOTE: data/media/ now holds the recovered bytes — back it up separately "
              "(it's the ONLY copy; gitignored, not in DB backups).")
    conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
