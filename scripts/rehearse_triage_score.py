"""Rehearse the Epic 10 triage scorer against the rehearsal COPY of the live DB.

Requires data/rehearsal-decay/app.copy.db (created by rehearse_decay.py; left in the
post-categorize, undecayed state). Fits + applies scores ON THE COPY, prints the
model summary, the strongest features, and the top-scored inbox items, and writes
TRIAGE-SCORE-REPORT.md alongside the copy. The live DB is never opened.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
os.chdir(ROOT)

from content_hoarder import db, triage_score  # noqa: E402

COPY = ROOT / "data" / "rehearsal-decay" / "app.copy.db"
REPORT = ROOT / "data" / "rehearsal-decay" / "TRIAGE-SCORE-REPORT.md"


def main() -> int:
    if not COPY.exists():
        print(f"copy missing: {COPY} — run rehearse_decay.py first")
        return 1
    conn = db.connect(str(COPY))

    nsfw_before = {t: conn.execute(
        "SELECT COUNT(*) FROM items WHERE EXISTS "
        "(SELECT 1 FROM json_each(metadata,'$.tags') WHERE value=?)", (t,)).fetchone()[0]
        for t in ("nsfw_erotic", "nsfw_talk", "nsfw_other")}

    t0 = time.perf_counter()
    dry = triage_score.learn(conn, samples=15)
    t_fit = time.perf_counter() - t0

    t0 = time.perf_counter()
    res = triage_score.learn(conn, apply=True, samples=15)
    t_apply = time.perf_counter() - t0

    scored = conn.execute(
        "SELECT COUNT(*) FROM items WHERE json_extract(metadata,'$.triage_score') "
        "IS NOT NULL").fetchone()[0]
    nsfw_after = {t: conn.execute(
        "SELECT COUNT(*) FROM items WHERE EXISTS "
        "(SELECT 1 FROM json_each(metadata,'$.tags') WHERE value=?)", (t,)).fetchone()[0]
        for t in ("nsfw_erotic", "nsfw_talk", "nsfw_other")}

    smart = db.get_random_batch(conn, 10, mode="smart")
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    conn.close()

    problems = []
    if res["scored"] != scored:
        problems.append(f"scored {res['scored']} != stamped {scored}")
    if nsfw_after != nsfw_before:
        problems.append(f"nsfw drift: {nsfw_before} -> {nsfw_after}")
    verdict = "ALL INVARIANTS PASSED" if not problems else "PROBLEMS: " + "; ".join(problems)

    r = ["# Triage score — rehearsal report (on the decay-rehearsal copy)\n"]
    r.append(f"- **verdict: {verdict}**  ·  fit+score dry {t_fit:.1f}s · apply {t_apply:.1f}s")
    r.append(f"- trained on {res['trained_on']:,} rows ({res['processed']:,} human-processed; "
             f"prior {res['prior']}); {res['features_kept']:,} features kept; "
             f"{res['scored']:,} inbox items scored")
    r.append(f"- NSFW counts unchanged through the metadata writes: "
             f"{'✓' if nsfw_after == nsfw_before else '⚠'}")
    r.append("\n## Strongest features (|log-odds| from prior)\n")
    r.append("| feature | n | processed | rate |")
    r.append("| --- | --- | --- | --- |")
    for tf in res["top_features"]:
        r.append(f"| {tf['feature']} | {tf['n']} | {tf['k']} | {tf['rate']} |")
    r.append("\n## Top-scored inbox items (the smart-batch fuel)\n")
    for s in res["sample"]:
        r.append(f"- **{s['score']}** {s['item']} — {', '.join(s['why']) or '(prior only)'}")
    r.append("\n## Smart batch sample (mode=smart, n=10)\n")
    for b in smart:
        md = b.get("metadata")
        md = json.loads(md) if isinstance(md, str) else (md or {})
        r.append(f"- [{md.get('triage_score', '—')}] r/{md.get('subreddit') or '?'}: "
                 f"{(b.get('title') or '')[:60]}")
    r.append("\n## Live command (after sign-off; writes scores to live app.db)\n")
    r.append("```powershell")
    r.append(".\\.venv\\Scripts\\python.exe -m content_hoarder learn-triage          # dry")
    r.append(".\\.venv\\Scripts\\python.exe -m content_hoarder learn-triage --apply")
    r.append("# then smart batches: /random?mode=smart (triage UI toggle is an Epic 20 item)")
    r.append("```")
    REPORT.write_text("\n".join(r) + "\n", encoding="utf-8")
    print(f"report written: {REPORT}")
    print(verdict)
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
