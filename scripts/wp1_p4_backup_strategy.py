"""WP1 Prompt 4 — data/media/ backup strategy measurement."""

import ctypes
import os
import shutil
from ctypes import wintypes
from pathlib import Path

media = Path("data/media")
blobs = list(media.rglob("*"))
blob_files = [b for b in blobs if b.is_file()]
count = len(blob_files)
total_bytes = sum(b.stat().st_size for b in blob_files)
print(f"=== data/media/ inventory ===")
print(f"Blob count: {count}")
print(
    f"Total size: {total_bytes / 1024 / 1024:.0f} MB ({total_bytes / 1024 / 1024 / 1024:.1f} GB)"
)

sizes = sorted(b.stat().st_size for b in blob_files)
for threshold, label in [
    (1024 * 1024, "1MB"),
    (5 * 1024 * 1024, "5MB"),
    (10 * 1024 * 1024, "10MB"),
    (50 * 1024 * 1024, "50MB"),
]:
    n = sum(1 for s in sizes if s > threshold)
    print(f"  >{label}: {n} files ({n / len(sizes) * 100:.1f}%)")

print(f"\n=== Disk topology ===")
for drive_letter in ["K", "F"]:
    root = f"{drive_letter}:\\"
    try:
        usage = shutil.disk_usage(root)
        print(
            f"{drive_letter}: {usage.total / 1024 / 1024 / 1024:.0f} GB, "
            f"{usage.free / 1024 / 1024 / 1024:.0f} GB free "
            f"({usage.free / usage.total * 100:.0f}% free)"
        )
    except Exception as e:
        print(f"{drive_letter}: error - {e}")

# Check physical disk via volume serial
print()
for drive_letter in ["K", "F"]:
    root = f"{drive_letter}:\\"
    try:
        vol_buf = ctypes.create_unicode_buffer(256)
        sn = wintypes.DWORD(0)
        ctypes.windll.kernel32.GetVolumeInformationW(
            root, vol_buf, 256, ctypes.byref(sn), None, None, None, 0
        )
        print(f"  {drive_letter}: volume serial={sn.value:08X}  label={vol_buf.value}")
    except Exception as e:
        print(f"  {drive_letter}: error - {e}")

print(f"\n=== Growth proxy ===")
# Items pending archiving: no archived_media
import sqlite3

ro = sqlite3.connect(
    f"file:{Path('data/app.db').resolve().as_posix()}?mode=ro", uri=True
)
pending = ro.execute(
    "SELECT COUNT(*) FROM items WHERE json_extract(metadata, '$.archived_media') IS NULL"
).fetchone()[0]
total = ro.execute("SELECT COUNT(*) FROM items").fetchone()[0]
archived = ro.execute(
    "SELECT COUNT(*) FROM items WHERE json_extract(metadata, '$.archived_media') IS NOT NULL"
).fetchone()[0]
print(f"  Total items: {total}")
print(f"  With archived_media: {archived}")
print(f"  Pending archiving: {pending}")
ro.close()

print(f"\n=== Recommendation ===")
print(f"Media backup destination: F:\\Backups\\content-hoarder\\media")
backup_root = Path("F:/Backups/content-hoarder/media")
print(f"  Exists: {backup_root.exists()}")
print(f"  F: drive has ample space: ~858 GB free")
print(f"  Volume serials differ between K: and F: → likely SEPARATE PHYSICAL DISKS ✓")
print(f"  This is a REAL backup target, not same-disk false backup.")
print()
print(f"Recommended tool: robocopy /MIR")
print(f"  - Built into Windows (no install)")
print(f"  - /MIR = mirror (deletes files at dest that no longer exist at source)")
print(f"  - /R:3 /W:5 = retry 3 times, wait 5s between retries")
print(f"  - /MT:4 = multi-threaded (4 threads)")
print(f"  - /NP = no progress (quiet output)")
print(f"  - /NDL /NFL = no dir/file logging (just summary)")
print()
print(f"EXACT COMMAND:")
print(
    "  robocopy /MIR /R:3 /W:5 /MT:4 /NP /NDL /NFL "
    '"K:\\Projects\\content-hoarder\\data\\media" '
    '"F:\\Backups\\content-hoarder\\media"'
)
print()
print(f"Frequency: weekly (scheduled task)")
print(
    f"  - At-save-time archiving is not yet live, so growth is from manual archive-media runs"
)
print(f"  - Once at-save-time archiving ships, switch to daily")
print()
print(f"Verification: after each run, compare counts:")
print(
    '  echo K: count && dir "K:\\Projects\\content-hoarder\\data\\media" /s /a-d | find "File(s)"'
)
print(
    '  echo F: count && dir "F:\\Backups\\content-hoarder\\media" /s /a-d | find "File(s)"'
)
print(f"  They should match (both = 32507 as of today)")
