"""WP1 Prompt 13 — Defense bucket pre-decay review.

Break down the defense tag by subreddit, classify as evergreen vs time-sensitive,
and recommend a decay strategy.
"""

import sqlite3
from pathlib import Path

DB = Path("data/app.db")
ro = sqlite3.connect(f"file:{DB.resolve().as_posix()}?mode=ro", uri=True)
ro.row_factory = sqlite3.Row

# --- 1. Break down by subreddit ---
print("=== Defense bucket: breakdown by subreddit ===")
rows = ro.execute("""
    SELECT json_extract(metadata, '$.subreddit') AS sub, COUNT(*) AS c
    FROM items
    WHERE source='reddit'
      AND EXISTS (SELECT 1 FROM json_each(json_extract(metadata, '$.tags')) WHERE value='defense')
    GROUP BY sub ORDER BY c DESC LIMIT 50
""").fetchall()

total_defense = sum(r["c"] for r in rows)
print(f"Total defense-tagged items: {total_defense}")
print()

# Classification data
classifications = {
    "time-sensitive": "Ukraine/Russia war news — decays with news cycle",
    "evergreen": "Defense tech, hardware, aviation engineering — value persists",
    "evergreen-memes": "Defense-adjacent humor — identity content, keep separate",
}

# Per-sub classification
# These are inferred from the subreddit name and purpose
subs = []
for r in rows:
    sub = r["sub"]
    count = r["c"]
    sub_lower = sub.lower() if sub else ""

    # NonCredibleDefense / NonCredibleDiplomacy = defense memes (identity content)
    if "noncredible" in sub_lower:
        klass = "evergreen-memes"
    # Time-sensitive: Ukraine war, conflict reporting
    elif any(
        kw in sub_lower for kw in ["ukraine", "ukrainianconflict", "combatfootage"]
    ):
        klass = "time-sensitive"
    # Evergreen: defense tech, hardware, aviation engineering
    elif any(
        kw in sub_lower
        for kw in [
            "credible",
            "warcollege",
            "militaryporn",
            "tankporn",
            "warplaneporn",
            "aviation",
            "acecombat",
            "shermanposting",
            "military",
            "lesscredible",
        ]
    ):
        klass = "evergreen"
    else:
        klass = "evergreen"  # default conservative

    subs.append((sub, count, klass))

for sub, count, klass in subs:
    note = classifications[klass]
    print(f"  {sub:35s} {count:6d}  [{klass}] {note}")

print()

# --- 2. Summarize ---
evergreen_total = sum(c for _, c, k in subs if k == "evergreen")
timesensitive_total = sum(c for _, c, k in subs if k == "time-sensitive")
meme_total = sum(c for _, c, k in subs if k == "evergreen-memes")
unclassified = total_defense - evergreen_total - timesensitive_total - meme_total
print(f"=== Summary ===")
print(
    f"  Evergreen (keep):          {evergreen_total:6d} ({evergreen_total / total_defense * 100:.0f}%)"
)
print(
    f"  Time-sensitive (sweep):    {timesensitive_total:6d} ({timesensitive_total / total_defense * 100:.0f}%)"
)
print(
    f"  Defense memes (keep):      {meme_total:6d} ({meme_total / total_defense * 100:.0f}%)"
)
print(
    f"  Unclassified tail:         {unclassified:6d} ({unclassified / total_defense * 100:.0f}%)"
)
print()

# --- 3. Recommended commands ---
ts_subs = [sub for sub, _, k in subs if k == "time-sensitive"]
ts_sub_list = ",".join(ts_subs)
print(f"=== Recommended decay commands ===")
print(f"Time-sensitive subs ({len(ts_subs)}): {', '.join(ts_subs)}")
print()
print("# Dry-run preview:")
print(
    f"content_hoarder decay --tag defense --subreddit {ts_sub_list} --before 90d --dry-run"
)
print()
print("# Apply (REVIEW first):")
print(
    f"content_hoarder decay --tag defense --subreddit {ts_sub_list} --before 90d --label swept --apply"
)
print()

ro.close()
