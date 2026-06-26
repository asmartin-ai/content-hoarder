"""Generate sandbox test fixtures from live DB + live API responses.

Creates:
- tests/fixtures/sandbox/items.json — sample items (no NSFW)
- tests/fixtures/sandbox/api/ — cached API responses (reddit thread, HN, etc.)
- tests/fixtures/sandbox/reddit_threads.json — sample thread JSON

Safe: read-only on the live DB, a few API requests. No writes.
"""

import json
import re
import sqlite3
import time
import urllib.request
from pathlib import Path

OUT = Path("tests/fixtures/sandbox")
OUT.mkdir(parents=True, exist_ok=True)
API_DIR = OUT / "api"
API_DIR.mkdir(exist_ok=True)

UA = "content-hoarder/0.1 (sandbox fixture generator; local personal use)"

DB = Path("data/app.db")
ro = sqlite3.connect(f"file:{DB.resolve().as_posix()}?mode=ro", uri=True)
ro.row_factory = sqlite3.Row


def is_nsfw(md: dict) -> bool:
    """Check if an item is NSFW (tag or over_18 flag)."""
    tags = md.get("tags") or []
    if any("nsfw" in t for t in tags):
        return True
    if md.get("over_18"):
        return True
    return False


def fetch(url: str, timeout: int = 15) -> dict | None:
    """Fetch a URL and return JSON, or None on failure."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


# --- 1. Sample items: 5 per source, no NSFW ---
print("=== Building sample items ===")
samples = []
# Get total counts per source first
for src in ("reddit", "youtube", "firefox", "hackernews", "keep", "obsidian"):
    total = ro.execute("SELECT COUNT(*) FROM items WHERE source=?", (src,)).fetchone()[
        0
    ]
    limit = min(500, total * 2)  # enough to find 5 non-NSFW
    rows = ro.execute(
        "SELECT * FROM items WHERE source=? ORDER BY last_seen_utc DESC LIMIT ?",
        (src, limit),
    ).fetchall()
    for r in rows:
        d = dict(r)
        md = (
            json.loads(d["metadata"])
            if isinstance(d["metadata"], str)
            else d.get("metadata", {})
        )
        if is_nsfw(md):
            continue
        d["metadata"] = md
        d.pop("raw_json", None)
        samples.append(d)
        if len([s for s in samples if s["source"] == src]) >= 5:
            break
    got = len([s for s in samples if s["source"] == src])
    print(f"  {src}: {got} items")

with open(OUT / "items.json", "w", encoding="utf-8") as f:
    json.dump(samples, f, indent=2, ensure_ascii=False)
print(f"  Total: {len(samples)} items -> items.json")

# --- 2. Sample reddit threads (from cached DB) ---
print("\n=== Cached reddit threads ===")
threads = ro.execute(
    """SELECT t.fullname, t.thread_json, i.title
       FROM reddit_threads t
       JOIN items i ON i.fullname = t.fullname
       WHERE NOT EXISTS (
           SELECT 1 FROM json_each(i.metadata, '$.tags') WHERE value LIKE 'nsfw%'
       )
       LIMIT 3"""
).fetchall()
thread_out = []
for t in threads:
    try:
        tj = json.loads(t["thread_json"])
        thread_out.append(
            {"fullname": t["fullname"], "title": t["title"], "thread": tj}
        )
    except (ValueError, TypeError):
        pass
with open(OUT / "reddit_threads.json", "w", encoding="utf-8") as f:
    json.dump(thread_out, f, indent=2, ensure_ascii=False)
print(f"  {len(thread_out)} threads -> reddit_threads.json")

# --- 3. Live API responses (cached for offline use) ---
print("\n=== Live API snapshots ===")
# Reddit thread (via pushshift/ pullpush alternative)
reddit_rows = [s for s in samples if s["source"] == "reddit"]
if reddit_rows:
    r = reddit_rows[0]
    url = r.get("url", "")
    if url and "reddit.com" in url.lower() and "/comments/" in url.lower():
        thread_url = url.rstrip("/") + ".json"
        print(f"  Fetching reddit thread: {thread_url[:80]}...")
        data = fetch(thread_url)
        if data:
            with open(API_DIR / "reddit_thread.json", "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            print(f"    Saved")
        else:
            print(f"    Failed")

# HN item
hn_rows = [s for s in samples if s["source"] == "hackernews"]
if hn_rows:
    hn = hn_rows[0]
    sid = hn.get("source_id", "")
    hn_url = f"https://hacker-news.firebaseio.com/v0/item/{sid}.json"
    print(f"  Fetching HN item: {hn_url}")
    data = fetch(hn_url)
    if data:
        with open(API_DIR / "hn_item.json", "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        print(f"    Saved")

ro.close()
print("\n=== Done ===")
print(f"Fixtures in: {OUT}")
