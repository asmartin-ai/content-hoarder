# Publication safety — public/private boundary for content-hoarder

**Status: ACTIVE (updated 2026-10-04).** Implements issue #73 (Pi.1). The repo is
already public (`github.com/asmartin-ai/content-hoarder`); this document
defines the boundary and the repeatable check to run before publication.

## Boundary

content-hoarder is **private-canonical with a rebuilt public copy**. Canonical history lives in
`asmartin-ai/content-hoarder-private` (remote `private`). The public repo
(`asmartin-ai/content-hoarder`, remote `origin`) is rebuilt from private `main` with every author
identity mapped to the GitHub no-reply address and private-only paths removed, then force-pushed.
The sensitive material it touches (live DBs, Takeout dumps, NSFW rule lists, exports and
saved-content text) is also **gitignored at the path level**. Run the Bun checker before every
publication.

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

## Refreshing the public repo

Private-only paths: `docs/FRIEND-PILOT.md` (hosted pilot operations). Add new ones to the
`--invert-paths` list below.

```sh
rm -rf /tmp/ch-public && git clone -q --single-branch --branch main . /tmp/ch-public
cd /tmp/ch-public
git filter-repo --force \
  --invert-paths --path docs/FRIEND-PILOT.md \
  --name-callback 'return name if name in (b"asmartin-ai", b"Claude", b"GitHub") else b"asmartin-ai"' \
  --email-callback 'return email if email.endswith(b"noreply.github.com") or email == b"noreply@anthropic.com" else b"291404369+asmartin-ai@users.noreply.github.com"'
git log --format='%an|%ae|%cn|%ce' | sort -u   # only no-reply identities
bun run <repo>/scripts/publish_safety_check.ts --history   # from /tmp/ch-public
git bundle create ../content-hoarder-public-pre-refresh.bundle --all   # in the real repo, of origin/main
git push --force https://github.com/asmartin-ai/content-hoarder.git main
```

A force-push doesn't remove what was public before: GitHub keeps old commits reachable by SHA,
and forks keep their history.

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
