# Publication safety — public/private boundary for content-hoarder

**Status: ACTIVE (updated 2026-10-04).** Implements issue #73 (Pi.1). The repo is
already public (`github.com/asmartin-ai/content-hoarder`); this document
defines the boundary and the repeatable check to run before publication.

## Boundary

content-hoarder is **single-repo public-canonical** (not private-canonical +
public-mirror). The sensitive material it touches — live DBs, Takeout dumps,
NSFW rule lists, exports, and saved-content text — is **gitignored at the
path level**, never scrubbed from history. The last recorded
`publish_safety_check.py --history` scan (2026-07-03) found no secrets or
sensitive data in tracked history. This historical result is not current;
re-run the Bun checker before publication.

### Public-safe (tracked, mirrors fine)

- `src/**/*.ts`, `src/static/`, and `tests/` — source, UI, and synthetic regressions.
- `docs/`, `scripts/`, `AGENTS.md`, `README.md`, `.env.example`, and
  `nsfw_rules.example.json` — review contents for private data before adding files.
- Bun project/tooling files such as `package.json`, `bun.lock`, `tsconfig.json`,
  and lint/format configuration.

### Private-only (gitignored — NEVER commit)

| Path | Why |
|---|---|
| `.env` | real secrets (Reddit OAuth, Karakeep token, PKMS credentials) |
| `data/` | the live SQLite DB + content-addressed media blobs (~18 GB) |
| `data/app.db*` | the items table — years of personal saved content |
| `data/media/` | hoarded deleted-media bytes (the only copy) |
| `data/*.backup-*` | DB backups (same data as the DB) |
| `data/delete-audit.jsonl`, `data/unsave-audit.jsonl` | real Reddit usernames |
| `nsfw_rules.json` | personal NSFW subreddit list |
| `exports/`, `*.csv`, `*.ndjson` | exported saved content |
| `takeout*/`, `*Takeout*.zip` | Google/Reddit archive dumps |
| `saved*.json`, `saved*.csv` | raw Reddit saves export |
| `RED_READER_APP_ID.txt` | (legacy) the borrowed public client id |

### Needs-scrub (regenerate, don't commit output)

- `tests/fixtures/sandbox/` output from `scripts/gen_sandbox_fixtures.py` —
  the script's own docstring warns: "output contains REAL personal data
  (usernames, titles, URLs, comment text). Do NOT commit." The committed
  fixtures under that path are hand-written synthetic examples; the script
  regenerates LOCAL-only copies for testing.

## The repeatable check

`scripts/publish_safety_check.ts` — exit 0 clean, exit 1 with findings.

```bash
# Working tree only (fast; always run before push)
bun run scripts/publish_safety_check.ts

# Include git blob history (slower; run before any force-push / history rewrite
# or the first publish of a fresh public mirror)
bun run scripts/publish_safety_check.ts --history
```

Findings categorized:
- `DATA_TRACKED` — a gitignored-sensitive path IS tracked (real leak; untrack
  + `git rm --cached` + commit before push).
- `SECRET` — a high-confidence credential pattern in a tracked file's
  content (AWS key, OAuth refresh-token blob, PEM header, `client_secret=...`).
- `HISTORY_SECRET` — same, but in a historical blob (`--history` only).

The script is read-only and offline. Placeholder values such as
`change-me`, `your-`, `<...>`, and `{{...}}` are ignored in a matched
credential value; an unrelated example comment cannot hide a real secret.
Test source files are excluded because they contain deliberate credential-shaped
fixtures. Serialized files under `tests/fixtures/` are still scanned.

## Workflow interaction with the existing public repo

The existing public repo **stays canonical**. There is no private-canonical
upstream and no sanitized-mirror generation step — the path-level gitignore +
this check IS the safety boundary. If a future need introduces genuinely
private-only code/docs (e.g. NSFW-aware classifiers, personal integration
notes), THEN the Life-OS pattern (`decisions/0012`: private canonical + sanitized
public mirror generated from an allowlist) becomes the right model:
- move canonical to a private repo,
- generate the public mirror from an **allowlist** of public-safe paths,
- run this check on every mirror build.

Until then: one repo, path-level ignore, this check before every push.

## Open decisions (deferred to user)

1. **Mirror to a second host** (e.g. Codeberg / self-hosted) — current
   posture is GitHub-only. Escalate only if the user wants redundancy.
2. **Sign tags / releases** — not currently done. Add if the user wants
   verifiable provenance.

## Concrete next action

Add `bun run scripts/publish_safety_check.ts` to whatever runs before `git push`
(pre-push hook or the user's manual checklist). A pre-push hook:

```bash
# .git/hooks/pre-push (chmod +x)
exec bun run scripts/publish_safety_check.ts || exit 1
```
