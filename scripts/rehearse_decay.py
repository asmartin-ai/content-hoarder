"""Epic 21 decay backfill — full dress rehearsal against a COPY of the live DB.

Copies data/app.db (opened strictly read-only) to data/rehearsal-decay/app.copy.db via
the sqlite3 backup API, then on the COPY: retags all reddit items (the new gaming/
esports/ephemeral buckets), dry-runs + applies the proposed decay waves, verifies the
undecay round trip, and writes DECAY-REHEARSAL-REPORT.md for user sign-off. The live DB
is never written; the copy is left in the post-categorize, undecayed state.

    python scripts/rehearse_decay.py                 # full rehearsal
    python scripts/rehearse_decay.py --backup-live   # just a timestamped live-DB backup

Exit code != 0 means a rehearsal invariant failed — read the report before any live run.
"""
from __future__ import annotations

import datetime
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
os.chdir(ROOT)  # nsfw_rules.json is resolved relative to the CWD

from content_hoarder import categorize, db  # noqa: E402

LIVE = ROOT / "data" / "app.db"
OUT = ROOT / "data" / "rehearsal-decay"
COPY = OUT / "app.copy.db"
REPORT = OUT / "DECAY-REHEARSAL-REPORT.md"

# The proposed backfill policy (user-confirmed 2026-06-10). Wave 2 is age-gated so
# still-live promos survive; wave 1 is the entertainment bulk, no cutoff.
WAVE1_TAGS = ["anime", "memes", "vtubers", "minecraft", "gaming", "esports",
              "defense", "japan"]
EPHEMERAL_CUTOFF_DAYS = 60

NSFW_TAGS = ("nsfw_erotic", "nsfw_talk", "nsfw_other")

timings: dict[str, float] = {}
problems: list[str] = []


def log(msg: str) -> None:
    print(msg, flush=True)


def timed(label: str, fn):
    t0 = time.perf_counter()
    r = fn()
    timings[label] = time.perf_counter() - t0
    log(f"  [{timings[label]:7.1f}s] {label}")
    return r


def backup_live(dest: Path) -> None:
    """Page-consistent copy of the live DB; source opened read-only (cannot write live)."""
    src = sqlite3.connect("file:" + LIVE.as_posix() + "?mode=ro", uri=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()
    dst = sqlite3.connect(str(dest))
    with dst:
        src.backup(dst)
    dst.close()
    src.close()


def status_histogram(conn) -> dict:
    return dict(
        (r[0], r[1])
        for r in conn.execute("SELECT status, COUNT(*) FROM items GROUP BY status")
    )


def tag_count(conn, tag: str, *, inbox_only: bool = False) -> int:
    where = "EXISTS (SELECT 1 FROM json_each(metadata, '$.tags') WHERE value = ?)"
    if inbox_only:
        where += " AND status='inbox'"
    return conn.execute(f"SELECT COUNT(*) FROM items WHERE {where}", (tag,)).fetchone()[0]


def wal_size() -> int:
    wal = Path(str(COPY) + "-wal")
    return wal.stat().st_size if wal.exists() else 0


def md_table(rows, headers) -> str:
    out = ["| " + " | ".join(headers) + " |",
           "| " + " | ".join("---" for _ in headers) + " |"]
    for r in rows:
        out.append("| " + " | ".join(str(c) for c in r) + " |")
    return "\n".join(out)


def main() -> int:
    if "--backup-live" in sys.argv:
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M")
        dest = ROOT / "data" / f"app.backup-{stamp}.db"
        log(f"backing up live DB -> {dest}")
        timed("backup", lambda: backup_live(dest))
        log(f"done: {dest} ({dest.stat().st_size:,} bytes)")
        return 0

    log(f"rehearsal output dir: {OUT}")
    live_size = LIVE.stat().st_size
    free = __import__("shutil").disk_usage(ROOT).free
    if free < 3 * live_size:
        log("ABORT: less than 3x DB size free on disk")
        return 1

    log("copying live DB (read-only source) -> rehearsal copy ...")
    timed("copy live -> app.copy.db", lambda: backup_live(COPY))

    conn = db.connect(str(COPY))

    # ---------------- preflight ----------------
    bad_json = conn.execute(
        "SELECT COUNT(*) FROM items WHERE NOT json_valid(metadata)").fetchone()[0]
    if bad_json:
        problems.append(f"{bad_json} rows with invalid metadata JSON")
    rules = categorize._load_nsfw_rules("nsfw_rules.json")
    nsfw_rules_ok = bool(rules["erotic"] or rules["talk"])
    if not nsfw_rules_ok:
        problems.append("nsfw_rules.json missing/empty — a retag would strip NSFW tags "
                        "from multi-tag items; ABORTING before the retag")
        REPORT.write_text("# DECAY REHEARSAL — ABORTED\n\n" + "\n".join(problems),
                          encoding="utf-8")
        return 1

    base_hist = status_histogram(conn)
    base_nsfw = {t: tag_count(conn, t) for t in NSFW_TAGS}
    base_tags = db.tag_counts(conn)
    reddit_inbox = conn.execute(
        "SELECT COUNT(*) FROM items WHERE source='reddit' AND status='inbox'"
    ).fetchone()[0]
    log(f"baseline: {base_hist}, reddit inbox {reddit_inbox}")

    # ---------------- categorize retag (= the live `categorize --source reddit --all`) ----
    retag = timed("categorize retag (retry=True, all reddit rows)",
                  lambda: categorize.tag_reddit_source(conn, retry=True))
    wal_after_retag = wal_size()
    after_nsfw = {t: tag_count(conn, t) for t in NSFW_TAGS}
    after_tags = db.tag_counts(conn)
    for t in NSFW_TAGS:
        if after_nsfw[t] < base_nsfw[t]:
            problems.append(f"NSFW REGRESSION: {t} {base_nsfw[t]} -> {after_nsfw[t]}")

    hist_post_categorize = status_histogram(conn)
    if hist_post_categorize != base_hist:
        problems.append(f"categorize changed statuses?! {base_hist} -> {hist_post_categorize}")

    # untagged tail (feeds the coverage expansion task)
    untagged_subs = conn.execute(
        "SELECT COALESCE(lower(json_extract(metadata,'$.subreddit')),'(none)') s, COUNT(*) n "
        "FROM items WHERE source='reddit' AND status='inbox' "
        "AND json_extract(metadata,'$.tags') IS NULL "
        "GROUP BY s ORDER BY n DESC LIMIT 200").fetchall()
    (OUT / "untagged-subs.txt").write_text(
        "\n".join(f"{r[1]:6d}  {r[0]}" for r in untagged_subs), encoding="utf-8")

    # ---------------- decay dry runs ----------------
    now = int(time.time())
    eph_cutoff = now - EPHEMERAL_CUTOFF_DAYS * 86400
    eph_cutoff_date = datetime.date.fromtimestamp(eph_cutoff).isoformat()

    dry1 = timed("decay wave 1 DRY (entertainment tags)",
                 lambda: db.decay(conn, tags=WAVE1_TAGS, samples=8, top_subs=25))
    dry2 = timed("decay wave 2 DRY (ephemeral, age-gated)",
                 lambda: db.decay(conn, tags=["ephemeral"], before_utc=eph_cutoff, samples=8))

    # overlap: items both ephemeral-tagged and wave-1-tagged (wave order note in report)
    overlap = conn.execute(
        "SELECT COUNT(*) FROM items WHERE source='reddit' AND status='inbox' "
        "AND EXISTS (SELECT 1 FROM json_each(metadata,'$.tags') WHERE value='ephemeral') "
        "AND EXISTS (SELECT 1 FROM json_each(metadata,'$.tags') WHERE value IN ("
        + ",".join("?" for _ in WAVE1_TAGS) + "))", WAVE1_TAGS).fetchone()[0]

    # ephemeral precision samples, split by detection path
    eph_subs = sorted(s for s, ts in categorize._SUBREDDIT_TAGS.items() if "ephemeral" in ts)
    ph = ",".join("?" for _ in eph_subs)
    def eph_samples(in_map: bool):
        op = "IN" if in_map else "NOT IN"
        return conn.execute(
            "SELECT lower(json_extract(metadata,'$.subreddit')), title FROM items "
            "WHERE source='reddit' AND status='inbox' "
            "AND EXISTS (SELECT 1 FROM json_each(metadata,'$.tags') WHERE value='ephemeral') "
            f"AND COALESCE(lower(json_extract(metadata,'$.subreddit')),'') {op} ({ph}) "
            "ORDER BY RANDOM() LIMIT 15", eph_subs).fetchall()
    eph_by_sub = eph_samples(True)
    eph_by_kw = eph_samples(False)
    eph_kw_total = conn.execute(
        "SELECT COUNT(*) FROM items WHERE source='reddit' AND status='inbox' "
        "AND EXISTS (SELECT 1 FROM json_each(metadata,'$.tags') WHERE value='ephemeral') "
        f"AND COALESCE(lower(json_extract(metadata,'$.subreddit')),'') NOT IN ({ph})",
        eph_subs).fetchone()[0]
    eph_sub_total = tag_count(conn, "ephemeral", inbox_only=True) - eph_kw_total

    # capture spot-check fullnames before the apply
    spot = [r[0] for r in conn.execute(
        "SELECT fullname FROM items WHERE source='reddit' AND status='inbox' "
        "AND EXISTS (SELECT 1 FROM json_each(metadata,'$.tags') WHERE value IN ("
        + ",".join("?" for _ in WAVE1_TAGS) + ")) ORDER BY RANDOM() LIMIT 10",
        WAVE1_TAGS).fetchall()]

    # ---------------- apply + round trip (on the copy) ----------------
    ap1 = timed("decay wave 1 APPLY",
                lambda: db.decay(conn, tags=WAVE1_TAGS, apply=True))
    time.sleep(1.5)  # distinct wave stamps (second resolution)
    ap2 = timed("decay wave 2 APPLY",
                lambda: db.decay(conn, tags=["ephemeral"], before_utc=eph_cutoff, apply=True))
    wal_after_decay = wal_size()

    if ap1["total"] != dry1["total"]:
        problems.append(f"wave1 apply {ap1['total']} != dry {dry1['total']}")
    if ap2["total"] != dry2["total"]:
        problems.append(f"wave2 apply {ap2['total']} != dry {dry2['total']}")
    if ap1["decayed_at"] == ap2["decayed_at"] and ap2["total"]:
        problems.append("wave stamps not distinct")

    stamped = conn.execute(
        "SELECT COUNT(*) FROM items WHERE json_extract(metadata,'$.decayed_at') IS NOT NULL"
    ).fetchone()[0]
    if stamped != ap1["total"] + ap2["total"]:
        problems.append(f"stamped {stamped} != applied {ap1['total'] + ap2['total']}")

    und = timed("undecay APPLY (full restore)", lambda: db.undecay(conn, apply=True))
    if und["total"] != stamped:
        problems.append(f"undecay restored {und['total']} != stamped {stamped}")
    hist_final = status_histogram(conn)
    if hist_final != hist_post_categorize:
        problems.append(f"round-trip histogram drift: {hist_post_categorize} -> {hist_final}")
    left = conn.execute(
        "SELECT COUNT(*) FROM items WHERE json_extract(metadata,'$.decayed_at') IS NOT NULL"
    ).fetchone()[0]
    if left:
        problems.append(f"{left} stamps left after full undecay")
    for fn in spot:
        st = conn.execute("SELECT status FROM items WHERE fullname=?", (fn,)).fetchone()[0]
        if st != "inbox":
            problems.append(f"spot-check {fn}: status {st} != inbox after round trip")

    conn.commit()
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    conn.close()

    # ---------------- report ----------------
    sha = __import__("subprocess").run(
        ["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"],
        capture_output=True, text=True).stdout.strip()
    verdict = "ALL INVARIANTS PASSED" if not problems else "PROBLEMS FOUND — DO NOT RUN LIVE"
    pct = 100.0 * (ap1["total"] + ap2["total"]) / reddit_inbox if reddit_inbox else 0.0

    tag_rows = [(t, base_tags.get(t, 0), after_tags.get(t, 0),
                 after_tags.get(t, 0) - base_tags.get(t, 0))
                for t in categorize.FILTER_TAGS
                if base_tags.get(t, 0) or after_tags.get(t, 0)]

    r = []
    r.append("# Decay backfill — rehearsal report (sign-off)\n")
    r.append(f"- date: {datetime.datetime.now().isoformat(timespec='minutes')}  ·  "
             f"commit: `{sha}`  ·  copy: `{COPY}`")
    r.append(f"- **verdict: {verdict}**")
    if problems:
        r.append("\n## PROBLEMS\n")
        r += [f"- ⚠ {p}" for p in problems]
    r.append(f"\n- live DB untouched (read-only source); rehearsal ran on the copy")
    r.append(f"- baseline statuses: `{base_hist}`  ·  reddit inbox: {reddit_inbox:,}")
    r.append(f"- proposed decay total: **{ap1['total'] + ap2['total']:,} items "
             f"({pct:.1f}% of reddit inbox)** — wave 1 {ap1['total']:,} + wave 2 {ap2['total']:,}")

    r.append("\n## Categorize retag (the live `categorize --source reddit --all`)\n")
    r.append(f"selected {retag['selected']:,} · tagged {retag['tagged']:,} · "
             f"untagged {retag['untagged']:,}")
    r.append("\n" + md_table(tag_rows, ["tag", "before", "after", "Δ"]))
    r.append(f"\nNSFW preservation: before `{base_nsfw}` → after `{after_nsfw}` "
             + ("✓ (no losses)" if not any("NSFW" in p for p in problems) else "⚠ SEE PROBLEMS"))
    r.append(f"\nTop-30 still-untagged inbox subs (full top-200 in `untagged-subs.txt`):\n")
    r.append(md_table([(n, s) for s, n in untagged_subs[:30]], ["items", "subreddit"]))

    r.append("\n## Wave 1 — entertainment tags (no age cutoff)\n")
    r.append(f"tags: `{', '.join(WAVE1_TAGS)}` → **{dry1['total']:,} items**")
    r.append("\nPer-tag membership (overlapping by design — total above is the "
             "distinct-row count, never this column's sum):\n")
    r.append(md_table(sorted(dry1["by_tag"].items(), key=lambda kv: -kv[1]), ["tag", "items"]))
    r.append("\nTop subreddits in the wave:\n")
    r.append(md_table(list(dry1["by_subreddit"].items()), ["subreddit", "items"]))
    r.append("\nAge bands (content age — add `--before` to wave 1 at sign-off if desired):\n")
    r.append(md_table(dry1["age_bands"].items(), ["band", "items"]))
    r.append("\nSamples:\n")
    r += [f"- {s}" for s in dry1["sample"]]

    r.append(f"\n## Wave 2 — ephemeral, age-gated (older than {eph_cutoff_date})\n")
    r.append(f"**{dry2['total']:,} items** · age bands: `{dry2['age_bands']}`")
    r.append(f"\nDetection-path split (inbox, all ages): subreddit-mapped {eph_sub_total}, "
             f"keyword-fallback {eph_kw_total}.")
    r.append("\nSubreddit-path samples:\n")
    r += [f"- r/{s}: {(t or '')[:70]}" for s, t in eph_by_sub] or ["- (none)"]
    r.append("\nKeyword-path samples (judge precision here):\n")
    r += [f"- r/{s}: {(t or '')[:70]}" for s, t in eph_by_kw] or ["- (none)"]
    r.append(f"\nOverlap note: {overlap} item(s) carry both an ephemeral and a wave-1 tag; "
             "wave 1 takes them ungated via the other tag. Expected to be small; if it "
             "bothers you, run wave 2 first and inspect.")

    r.append("\n## Round-trip verification (on the copy)\n")
    r.append(f"- apply == dry: wave1 {ap1['total']:,} / wave2 {ap2['total']:,} ✓")
    r.append(f"- stamped {stamped:,} → undecayed {und['total']:,}; residual stamps {left}")
    r.append(f"- status histogram after round trip identical: "
             f"{'✓' if hist_final == hist_post_categorize else '⚠ DRIFT'}")
    r.append(f"- 10-item spot check restored to inbox: "
             f"{'✓' if not any('spot-check' in p for p in problems) else '⚠'}")

    r.append("\n## Timings / IO\n")
    r += [f"- {k}: {v:.1f}s" for k, v in timings.items()]
    r.append(f"- WAL after retag: {wal_after_retag:,} B · after decay waves: "
             f"{wal_after_decay:,} B (copy checkpointed+truncated at the end)")

    r.append("\n## Live command block (run after sign-off, from the repo root)\n")
    r.append("```powershell")
    r.append("# 0) stop `serve` if running, then back up (timestamped, read-only source):")
    r.append(".\\.venv\\Scripts\\python.exe scripts\\rehearse_decay.py --backup-live")
    r.append("# 1) retag all reddit items with the new buckets (dry first, then apply):")
    r.append(".\\.venv\\Scripts\\python.exe -m content_hoarder categorize --source reddit --dry-run")
    r.append(".\\.venv\\Scripts\\python.exe -m content_hoarder categorize --source reddit --all")
    r.append("# 2) wave 1 — entertainment (append e.g. --before 2025-06-10 for an age cutoff):")
    w1 = " ".join(f"--tag {t}" for t in WAVE1_TAGS)
    r.append(f".\\.venv\\Scripts\\python.exe -m content_hoarder decay {w1}")
    r.append(f".\\.venv\\Scripts\\python.exe -m content_hoarder decay {w1} --apply")
    r.append("# 3) wave 2 — ephemeral, age-gated:")
    r.append(f".\\.venv\\Scripts\\python.exe -m content_hoarder decay --tag ephemeral --before {eph_cutoff_date}")
    r.append(f".\\.venv\\Scripts\\python.exe -m content_hoarder decay --tag ephemeral --before {eph_cutoff_date} --apply")
    r.append("# 4) live round-trip confidence check on a tiny sub (8 items), then restore it:")
    today = datetime.date.today().isoformat()
    r.append(".\\.venv\\Scripts\\python.exe -m content_hoarder decay --subreddit freebies --apply")
    r.append(f".\\.venv\\Scripts\\python.exe -m content_hoarder decay --undo --decayed-after {today} --apply")
    r.append("#    (the freebies items return; re-decay them with wave 2 when satisfied)")
    r.append("```")
    r.append("\nUndo at any time: `decay --undo --decayed-after/--decayed-before <date>` "
             "selects a wave by its stamp; `decay --undo --apply` with no window restores "
             "every decayed item.")

    REPORT.write_text("\n".join(r) + "\n", encoding="utf-8")
    log(f"report written: {REPORT}")
    log(verdict)
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
