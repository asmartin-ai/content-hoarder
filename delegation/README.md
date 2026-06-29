# Delegation handoff

This directory is intentionally small. Active work is tracked in GitHub Issues; local backlog history is split under `docs/backlog/` so sandboxed agents do not need to read one monolithic file.

## Source of truth

- Active issue tracker: <https://github.com/asmartin-ai/content-hoarder/issues>
- Local issue/epic index: `BACKLOG.md`
- Offline backlog history: `docs/backlog/README.md` + `docs/backlog/epic-*.md`
- Issue mapping for scripts/agents: `docs/backlog/github-issues.json`
- Current delegation queue: `delegation/NEXT-DELEGATION.md`
- Mobile/PWA verification guidance: `docs/QA-CHECKLIST.md` and `tests/ui/`

## Recently folded/migrated (2026-06-29)

- Historical per-task delegation specs were folded into `BACKLOG.md` / `docs/backlog/` and removed.
- 61 active/half-open backlog items were migrated to GitHub Issues (#11–#71).
- 26 GitHub milestones were created, one per epic.
- Labels now encode priority, type, area, safety, and validation needs.

## Delegation rules

1. Use one task per branch/worktree and keep write scopes disjoint.
2. If delegating to a sandboxed/offline agent, include the GitHub issue body in the prompt and point it to the relevant `docs/backlog/epic-*.md` file.
3. No live/private data or external account mutations in delegated work unless explicitly authorized.
4. UI work must use the project `frontend-design` skill and update/bump service-worker cache versions when needed.
5. Tests should be offline and deterministic; UI tests use synthetic DB fixtures.
6. For Reddit unsave, archive.today, media downloads, or anything irreversible/costly, keep preview/dry-run as the default and require explicit live/apply gates.
