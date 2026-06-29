"""Live-data smoke test for recently shipped features.

Runs against the real app.db with :memory: copies for safety.
Tests: tag suggestion queue, folders, duplicate review, done-retention,
unsave-by-tag preview.
"""

import sqlite3
import sys
from pathlib import Path

from content_hoarder import db, folders, tag_suggest

# Use live DB path
DB = Path(__file__).resolve().parents[1] / "data/app.db"
if not DB.exists():
    print(f"SKIP: live DB not found at {DB}")
    sys.exit(0)

print(f"Live DB: {DB} ({DB.stat().st_size / 1024 / 1024:.0f} MB)")
print()

# Open read-only copy for safety
ro = sqlite3.connect(f"file:{DB.as_posix()}?mode=ro", uri=True)
ro.row_factory = sqlite3.Row

# --- 1. Tag suggestion queue (dry-run) ---
print("=== 1. Tag suggestion: rule-based (dry-run on reddit) ===")
try:
    # Open an in-memory copy of the schema
    mem = db.connect(":memory:")
    # Copy the live data in
    with mem:
        ro.backup(mem)
    res = tag_suggest.suggest_from_rule_matches(mem, source="reddit", limit=100)
    print(
        f"  Queued: {res['queued']} suggestions in dry run (rule-based, reddit, limit=100)"
    )
    if res.get("by_tag"):
        for tag, c in sorted(res["by_tag"].items(), key=lambda x: -x[1])[:10]:
            print(f"    {tag}: {c}")
    # Rollback: discard the in-memory copy
    mem.close()
except Exception as e:
    print(f"  ERROR: {e}")

# --- 2. Discovery suggestions ---
print("\n=== 2. Tag suggestion: discovery (dry-run) ===")
try:
    mem = db.connect(":memory:")
    with mem:
        ro.backup(mem)
    res = tag_suggest.suggest_from_discovery(mem, min_count=2, limit=20)
    print(f"  Queued: {res['queued']} discovery suggestions")
    if res.get("discovered"):
        for tag, sources in res["discovered"].items():
            print(f"    {tag}: {sources}")
    mem.close()
except Exception as e:
    print(f"  ERROR: {e}")

# --- 3. Accept+reject workflow ---
print("\n=== 3. Tag suggestion: accept/reject workflow ===")
try:
    mem = db.connect(":memory:")
    with mem:
        ro.backup(mem)
    # Create a suggestion for an item that exists
    sample = mem.execute("SELECT fullname FROM items LIMIT 1").fetchone()
    if sample:
        fn = sample["fullname"]
        tag_suggest.create_suggestion(mem, fn, "smoke-test")
        pending = tag_suggest.list_suggestions(mem)
        print(f"  Created suggestion on {fn}: {len(pending)} pending")
        if pending:
            sid = pending[0]["id"]
            acc = tag_suggest.accept_suggestion(mem, sid)
            print(
                f"  Accepted suggestion {sid}: status={acc['status'] if acc else 'FAILED'}"
            )
        after = tag_suggest.list_suggestions(mem)
        print(f"  Remaining pending: {len(after)}")
    mem.close()
except Exception as e:
    print(f"  ERROR: {e}")

# --- 4. Folder creation + evaluation ---
print("\n=== 4. Folders: create + evaluate ===")
try:
    mem = db.connect(":memory:")
    with mem:
        ro.backup(mem)
    f = db.create_folder(mem, "smoke-test", {"source": "reddit", "status": "inbox"})
    print(f"  Created folder [{f['id']}] {f['name']}")
    res = folders.evaluate_folder(mem, f["id"])
    print(
        f"  Evaluated: {res['total']} matched, {res['newly_assigned']} newly assigned"
    )
    counts_before = db.folder_counts(mem)
    print(f"  Folder counts: {counts_before}")

    # Rename
    renamed = db.rename_folder(mem, f["id"], "smoke-renamed")
    assert renamed is not None
    print(f"  Renamed: {renamed['name']}")
    assert db.get_folder_by_name(mem, "smoke-renamed") is not None

    # Delete
    assert db.delete_folder(mem, f["id"])
    print(f"  Deleted folder {f['id']}")
    assert db.get_folder_by_name(mem, "smoke-renamed") is None
    mem.close()
except Exception as e:
    print(f"  ERROR: {e}")

# --- 5. Duplicate review ---
print("\n=== 5. Duplicates: find groups ===")
try:
    from content_hoarder import dedup

    mem = db.connect(":memory:")
    with mem:
        ro.backup(mem)
    groups = dedup.find_groups(mem, by="url", status="inbox")
    print(f"  URL groups (inbox): {len(groups)} groups")
    if groups:
        for g in groups[:5]:
            print(
                f"    Group: keep={g.get('keep')}, archives={len(g.get('items', [])) - 1}"
            )
    groups_t = dedup.find_groups(mem, by="title", status="inbox")
    print(f"  Title groups (inbox): {len(groups_t)} groups")
    mem.close()
except Exception as e:
    print(f"  ERROR: {e}")

# --- 6. Done-retention preview ---
print("\n=== 6. Done retention: preview ===")
try:
    mem = db.connect(":memory:")
    with mem:
        ro.backup(mem)
    now = int(__import__("time").time())
    preview = db.purge_done(mem, now=now, apply=False)
    print(
        f"  Purge preview: {preview['total']} Done items older than {preview.get('retention_days', '?')} days"
    )
    mem.close()
except Exception as e:
    print(f"  ERROR: {e}")

# --- 7. Unsave-by-tag preview ---
print("\n=== 7. Unsave-by-tag preview ===")
try:
    mem = db.connect(":memory:")
    with mem:
        ro.backup(mem)
    # Try a few common tags
    for tag in ("memes", "anime", "minecraft", "coding", "nsfw_erotic"):
        preview = db.preview_unsave_by_tag(mem, tag)
        if preview["matched"]:
            print(
                f"  {tag}: {preview['matched']} matched, {preview['eligible']} eligible"
                f" (skipped: {preview['skipped']})"
            )
    mem.close()
except Exception as e:
    print(f"  ERROR: {e}")

# --- 8. Folder evaluate all (dry-run) ---
print("\n=== 8. Folders: evaluate all (dry-run) ===")
try:
    mem = db.connect(":memory:")
    with mem:
        ro.backup(mem)
    # Create a few sample folders
    for name, qd in [
        ("reddit-inbox", {"source": "reddit", "status": "inbox"}),
        ("youtube", {"source": "youtube"}),
        ("keep-items", {"source": "keep"}),
    ]:
        f = db.create_folder(mem, name, qd)
        res = folders.evaluate_folder(mem, f["id"])
        print(f"  {name}: {res['total']} matched")
    counts = db.folder_counts(mem)
    print(
        f"  Total folder counts: {sum(counts.values())} items across {len(counts)} folders"
    )
    mem.close()
except Exception as e:
    print(f"  ERROR: {e}")

ro.close()
print()
print("=== ALL SMOKE TESTS COMPLETE ===")
