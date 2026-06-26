"""Run media backup via robocopy, then run RedGifs resolve against a DB copy."""

import json
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

# === 1. Backup media ===
src = Path("K:/Projects/content-hoarder/data/media")
dst = Path("F:/Backups/content-hoarder/media")
dst.mkdir(parents=True, exist_ok=True)

print(f"=== Backup: {src} -> {dst} ===")
src_count = len(list(src.rglob("*")))
print(f"Source files: {src_count}")
print("Running robocopy...")
result = subprocess.run(
    [
        "robocopy",
        "/MIR",
        "/R:3",
        "/W:5",
        "/MT:4",
        "/NP",
        "/NDL",
        "/NFL",
        str(src),
        str(dst),
    ],
    capture_output=True,
    text=True,
    timeout=600,
)
print(result.stdout)
print(result.stderr)
exit_code = result.returncode
if exit_code <= 7:
    print(f"Backup completed (exit code {exit_code} = files copied successfully)")
else:
    print(f"Backup FAILED (exit code {exit_code})")
    sys.exit(1)

# Verify
dst_count = len(list(dst.rglob("*")))
print(
    f"Dest files: {dst_count}, Match: {'OK' if src_count == dst_count else 'MISMATCH!'}"
)

# === 2. RedGifs resolve_all (dry-run on DB copy) ===
print("\n=== RedGifs resolve_all ===")
live = Path("data/app.db")
copy_path = live.parent / "app.redgifs-preview.db"
shutil.copy2(live, copy_path)
print(f"DB copy created: {copy_path}")

# Need to add the src path for the redgifs module
sys.path.insert(0, str(Path("src").resolve()))
# Switch to the redgifs branch content by importing from the module path
from content_hoarder import db as db_mod

conn = db_mod.connect(str(copy_path))

# Import the resolver module manually
import importlib.util

spec = importlib.util.spec_from_file_location(
    "redgifs_resolver", Path("src/content_hoarder/redgifs_resolver.py").resolve()
)
rg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rg)

print("\nResolve up to 50 items...")
res = rg.resolve_all(conn, limit=50, dry_run=True)
print(json.dumps(res, indent=2, ensure_ascii=False))
conn.close()

# Clean up
copy_path.unlink()
print(f"\nCleaned up DB copy")
