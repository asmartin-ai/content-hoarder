# Parallel autonomous run — notes (2026-06-12)

Worktree: `K:\Projects\ch-parallel` (detached base = `feat/frontend-v3` @ 7994f53).
All branches local + UNMERGED. Verified headless with **Playwright Chromium**
(scratch venv at `O:\Temp\ch-verify-venv`) against the worktree server on port
8799 (`scripts/serve_parallel_test.py`, serving the **DB copy** at
`K:\Projects\ch-parallel\data\app.db` — the live app.db was never touched).

> Verification note: the Claude Preview MCP window wedged this session
> (`about:blank`, every eval/snapshot 30s-timeout, even after stop+restart +
> freeing the port). Fell back to headless Playwright, which exercises the real
> handlers + computes geometry/colors against the running worktree server. Each
> task's check count below is from that harness.

---

## Task 1 — Epic 14: Settings menu  ·  branch `feat/settings-menu`
**Commit:** `5c83059` feat(browse): stats sheet in the settings menu (Epic 14)

**Done / verified (27/27 checks @ 1280px + 380px, no console errors, suite green):**
- The v3 browse page already shipped the gear button + `#settings` sheet with
  THEME / DENSITY / LOADING (infinite vs Focus batches) / DAILY GOAL — those
  Epic 14 sub-items were already complete on `feat/frontend-v3`. Verified each
  still opens, applies, and persists (localStorage) + closes on Esc/scrim.
- **What was missing = Stats.** Added a COLLECTION group to the settings panel
  with a button that opens a new `#statsheet` sheetpanel, rendered from
  `GET /stats`: wins-first top lines (processed this week / total / with-link)
  + BY SOURCE and BY STATUS bar rows. Esc/scrim close it like the other sheets.
  Stats previously existed only on the v2 `/reddit` page; this brings it into
  the v3 settings menu as Epic 14 specified ("move the Stats button into it").
- Files: `templates/index.html` (+COLLECTION group, +#statsheet),
  `static/browse/main.js` (+stats fetch/render, statsheet in closeSheets list),
  `static/browse/browse.css` (.setbtn + .stats-list/.stat-row).
- Also added `scripts/serve_parallel_test.py` (worktree+DB-copy server on :8799).

**Remains:** nothing for Epic 14 itself. (Mobile sheet is the existing bottom-sheet
treatment; verified it anchors bottom + fits 380px.)

**BACKLOG ticks:** Epic 14 — "Settings cog + panel", "View density in settings",
"Stats in settings" (and the theme/loading/goal items already shipped on the base
branch). Recommend marking Epic 14 complete.

---

## Task 2 — UI polish sweep (Epic 13/5 P2s, non-media)  ·  branch `feat/ui-polish-sweep`
**Commit:** `62a9e1e` feat(browse): tag chips on log/ledger rows (Epic 13 polish sweep)

**Done / verified (19/19 checks @ 1280px + 380px, no console errors, suite green):**
- **Tag chips in every density (the one open code item).** `tagChips` only
  rendered on pin cards. Added an `{expand:false}` mode to `core/render.js`
  `tagChips` (curated-first, capped, static "+N" marker, no hidden chips) and
  wired it into both `logRow` (comfortable) and `ledgerRow` (compact) on the
  meta line. The locked fixed-height (100px) comfortable rows do NOT grow; the
  "+M more" expander stays card-only. Display-only — `metadata.tags` untouched.
  Files: `core/render.js`, `browse/render.js`, `browse/browse.css`.

**Already shipped on v3 — audited + verified, no change needed:**
- bulk Undo — `api.bulkUndo` snackbar; verified archive→undo restores the row.
- bulk bar shift — `.opsbar` is `position:fixed` overlay; first-row top is
  unchanged on select (no list jump).
- bulk button colors — already on `--status-keep/-archive/-done` tokens.
- NSFW blurred thumb width — blur is constrained to the fixed 128×76 monitor
  box in v3; verified box dims + veil.
- row click opens only title/link — v3 opens only via the title `<a>`/media
  slot; verified body + meta clicks open nothing.
- side-gutter scrolling — `document` wheel handler already forwards to the
  page; verified a body-target wheel scrolls.

**N/A on v3 — three-dot ⋯ menu (USER CONFIRMED 2026-06-12):**
- The item ("three-dot ⋯ menu stays open after a change") targets `#visual-menu-pop`,
  which exists only in the orphaned **v2** `static/app.js` that **no template loads**.
- The v3 settings sheet already covers this need (view density / theme / loading /
  goal in one panel that stays open across changes). The user confirmed **no v3 ⋯
  menu is needed** — the settings menu is the replacement. **Close this item as
  done/superseded; do not build a ⋯ menu.**

**Remains:** none of the targeted non-media P2s. (Media-adjacent P2s in Epic 13
were excluded per handoff and left untouched.)

**BACKLOG ticks (Epic 13):** "Tag chips only render in card view" (done);
and verify-and-tick the already-shipped: bulk Undo, bulk bar shift, bulk color
coding, NSFW thumb width, row-click scope, side-gutter scroll. The "three-dot
menu" item is **superseded by the settings menu** (Epic 14) — close it, no ⋯ menu
needed.

---

## Remaining tasks (not started this checkpoint)
3. [M] Epic 15 — Hacker News navigation  ·  `feat/hn-navigation`
4. [S] Epic 8 — App icon redesign  ·  `chore/app-icon`
5. [M, research] Epic 22 — Triage spin-off architecture doc  ·  `docs/triage-spinoff`
6. [M, read-only DB] Epic 10 — Learned-triage score design  ·  `docs/learned-triage`

## ⚠️ Changes the OTHER session should be aware of (outside my two branches)
1. **Main checkout `.claude/launch.json` was edited** (`K:\Projects\content-hoarder\.claude\launch.json`):
   added a `ch-parallel` entry (port 8799 → `serve_parallel_test.py`) for preview
   verification. **This file is gitignored**, so it will NOT appear in your
   `git status` or any commit and cannot conflict with your work — but it IS a
   working-tree change in the main checkout you're using. Remove the entry if you
   don't want it (the user said they'll do final cleanup).
2. **`scripts/serve_parallel_test.py` is committed** on branch `feat/settings-menu`
   (`5c83059`) — a small worktree-server helper that serves the DB **copy** on 8799.
   If these branches are merged, that script comes with them; drop it from the
   merge if you don't want it in the tree.
3. Both my branches (`feat/settings-menu`, `feat/ui-polish-sweep`) are **local +
   unmerged**; nothing was pushed. The worktree `K:\Projects\ch-parallel` still
   exists on disk.

## Cleanup done by me this session
- Deleted the throwaway Playwright venv (`O:\Temp\ch-verify-venv`), the verify
  scripts (`O:\Temp\ch-verify\`), the temp commit-message files
  (`O:\Temp\ch-parallel-msg*.txt`), and the freshly-downloaded Chromium cache
  (`%LOCALAPPDATA%\ms-playwright`). The `claude-preview-verify` skill §12 carries
  the rebuild commands if headless verification is needed again.
- Test server stopped; port 8799 freed.
- LEFT for the user/other session to clean: the worktree, the two branches, and
  the gitignored launch.json entry above.
