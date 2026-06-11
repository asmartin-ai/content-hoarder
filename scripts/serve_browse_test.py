"""Serve the app against the rehearsal DB COPY (UI verification without touching
the live app.db — action clicks and resurface-state writes land in the copy)."""
import os
from pathlib import Path

COPY = Path(__file__).resolve().parents[1] / "data" / "rehearsal-decay" / "app.copy.db"
assert COPY.exists(), f"rehearsal copy missing: {COPY}"
os.environ["CONTENT_HOARDER_DB"] = str(COPY)

from content_hoarder.web import create_app  # noqa: E402  (env must be set first)

app = create_app()
print(f"Serving the REHEARSAL COPY ({COPY}) on http://127.0.0.1:8790/")
app.run(host="127.0.0.1", port=8790, debug=False)
