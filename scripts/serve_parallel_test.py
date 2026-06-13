"""Serve the PARALLEL WORKTREE's code against its DB COPY (UI verification for the
parallel session — never touches the live app.db or the main checkout's code)."""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]          # K:/Projects/ch-parallel
COPY = ROOT / "data" / "app.db"
assert COPY.exists(), f"worktree DB copy missing: {COPY}"
os.environ["CONTENT_HOARDER_DB"] = str(COPY)
sys.path.insert(0, str(ROOT / "src"))               # worktree code, not the main checkout

from content_hoarder.web import create_app  # noqa: E402  (env/path must be set first)

app = create_app()
print(f"Serving the WORKTREE COPY ({COPY}) on http://127.0.0.1:8799/")
app.run(host="127.0.0.1", port=8799, debug=False)
