# Delegation prompts — sandbox-agent batch

Self-contained prompts for **isolated sandbox agents**: no live DB, no external APIs
(Reddit / HN / Twitter / YouTube / archive.today), no network. Each prompt is grounded in
verified file/line context and an offline-testable contract. Paste a prompt into a fresh
subagent; it does the rest.

Selection criteria for this batch: pure code + offline tests (or Playwright UI tests),
disjoint write scopes across the four so they can run **in parallel**, and no item that needs
a user decision gate, live data, visual design review, or external API as the oracle. See
`../BACKLOG.md` for the full backlog and `../AGENTS.md` for the architecture/gotchas every
agent must honor (especially: merge_upsert is non-destructive; connectors never touch the DB;
external-content FTS5 rebuilds via `INSERT INTO tbl(tbl) VALUES('rebuild')`; HTTP is stdlib
`urllib`; `data/media/` and `data/app.db` are never committed).

## The batch (4 agents)

| Agent | Feature | BACKLOG | Files owned (write scope) | Effort |
|---|---|---|---|---|
| [A](agent-a-note-with-video-reader.md) | Note-with-video reader (Keep/Obsidian) — play the video where comments go | Epic 15 #931 | `static/browse/reader.js`, `static/browse/browse.css`, `static/browse/main.js` | med |
| [B](agent-b-triage-score-refit.md) | Triage-score feedback loop: periodic re-fit + drift signal | Epic 10 #472 | `triage_score.py`, `cli.py` (one new subcommand) | low-med |
| [C](agent-c-triage-back-guard.md) | `/triage` as first PWA entry — back should return to `/`, not exit | Epic 16 #995 | `static/triage.js`, `templates/triage.html` | low |
| [D](agent-d-snooze-primitive.md) | Snooze backend primitive (`metadata.snoozed_until`) + escalation | Epic 5 #184 / Epic 20 #1245 | `db.py`, `search_query.py`, `resurface.py`, `cli.py` (one new subcommand) | med |

## Parallelism / write-scope conflicts

- **A and C** are both frontend but **disjoint files** (`reader.js`/`main.js`/`browse.css` vs
  `triage.js`/`triage.html`) → safe in parallel.
- **B** is isolated to `triage_score.py` (+ one `cli.py` subcommand) → safe with all others.
- **D** owns `db.py`, `search_query.py`, `resurface.py`, and adds a `cli.py` subcommand. The
  only overlap is `cli.py` (B and D each add one subcommand) — append-disjoint, but to be safe
  **run B and D sequentially or have each append at the END of the argparse setup** so a merge
  doesn't collide. `db.py` is owned by D alone.

Net: run **A + C in parallel anytime**; run **B and D in parallel with each other and with
A/C**, but if both edit `cli.py` in the same working copy, land one before the other.

## Why these four (and not the obvious picks)

Two of the items originally floated for this batch turned out to be **already shipped** and
were replaced:
- *Note→YouTube link promotion (Epic 11 P2)* → shipped `49e9fc9` (`note_youtube.py`,
  `migrate-note-youtube` CLI). Replaced by **Agent A** (the natural follow-on: a *reader mode*
  for notes that have real content AND a YouTube link — explicitly NOT promoted, the note text
  is the irreplaceable thing).
- *Twitter/X bookmarks connector (Epic 7 P2)* → shipped `d654011` + `5fe3def` + `2fa8add`
  (`connectors/twitter.py`, `fixtures/twitter/`). Replaced by **Agent C**.

The *user_tags table* item (Epic 26 P3) was considered for this slot but deferred: it shares
`db.py` with the snooze primitive (Agent D) and is lower-priority (P3). Run it as a follow-up
after D merges.

## Verification gates (every agent)

- **Baseline first:** record `python -m pytest` pass/fail count before any change.
- **New offline tests + full suite green** — "no regressions" only vs the recorded baseline.
  Tests are offline, `:memory:` SQLite, synthetic fixtures, **no network** (see AGENTS.md).
- **Frontend agents (A, C):** add/extend Playwright UI tests under `tests/ui/` per AGENTS.md
  (`pytest -m ui`, Pixel-6 viewport + PWA-standalone emulation against a copy of the live DB
  with autosync OFF). Add a regression test per UI behavior added.
- **No irreversible external actions.** No live DB writes, no network in tests, no pushing.
- **Commit per-feature** with the standard commit style (imperative subject ≤50 chars); do NOT
  push or merge to `main` unless the handoff says otherwise — leave the branch for review.
- Honor the Qwen gotcha (AGENTS.md): after any LLM-delegated code, grep for un-awaited async
  calls and `python -m py_compile` the file. This codebase is **synchronous** — prefer plain
  functions over async.
