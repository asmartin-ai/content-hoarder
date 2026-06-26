"""Flag unresolvable Gfycat items for cleanup.

Run against a DB copy. Sets metadata.media_status='gone'
and metadata.media_resolved_from='gfycat_unresolvable' on items whose
gfycat.com media_url couldn't be resolved via RedGifs.

Run: `python scripts/flag_dead_gfycat.py --apply` to write, or omit for dry-run.
"""

import json
import sqlite3
import sys
from pathlib import Path

DB = Path("data/app.db")
APPLY = "--apply" in sys.argv

ro = sqlite3.connect(f"file:{DB.resolve().as_posix()}?mode=ro", uri=True)

# Switch to writable connection if --apply
if APPLY:
    bak = DB.parent / f"app.backup-pre-gfycat-flag-{int(__import__('time').time())}.db"
    import shutil

    shutil.copy2(DB, bak)
    print(f"Backup: {bak}")
    conn = sqlite3.connect(str(DB))
    conn.row_factory = sqlite3.Row
else:
    conn = sqlite3.connect(f"file:{DB.resolve().as_posix()}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row

rows = conn.execute(
    "SELECT fullname FROM items "
    "WHERE json_extract(metadata, '$.media_url') LIKE '%gfycat.com%'"
).fetchall()

count = len(rows)
print(f"Found {count} items with dead Gfycat URLs")

if APPLY:
    for r in rows:
        md = json.loads(
            conn.execute(
                "SELECT metadata FROM items WHERE fullname=?", (r["fullname"],)
            ).fetchone()[0]
        )
        md["media_status"] = "gone"
        md["media_status_reason"] = "gfycat_shutdown"
        md["media_resolved_from"] = "gfycat_unresolvable"
        conn.execute(
            "UPDATE items SET metadata=? WHERE fullname=?",
            (json.dumps(md, ensure_ascii=False), r["fullname"]),
        )
    conn.commit()
    print(f"Marked {count} items with media_status='gone' (gfycat_shutdown)")
else:
    print("Dry-run — use --apply to write")
    counts = {}
    for r in rows:
        status = conn.execute(
            "SELECT json_extract(metadata, '$.media_status') FROM items WHERE fullname=?",
            (r["fullname"],),
        ).fetchone()[0]
        counts[status or "unset"] = counts.get(status or "unset", 0) + 1
    print(f"Current media_status distribution: {counts}")

conn.close()
