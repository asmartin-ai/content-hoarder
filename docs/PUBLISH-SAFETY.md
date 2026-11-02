# Publication safety — public/private boundary for content-hoarder

**Status: ACTIVE (updated 2026-11-02).** Implements issue #73 (Pi.1). The repo is
already public (`github.com/asmartin-ai/content-hoarder`); this document
defines the boundary and the repeatable check to run before publication.

## Boundary

content-hoarder is **private-canonical with a rebuilt public copy**. Canonical history lives in
`asmartin-ai/content-hoarder-private` (remote `private`). The public repo
(`asmartin-ai/content-hoarder`, remote `origin`) is rebuilt from private `main` with every author
identity mapped to the GitHub no-reply address and private-only paths removed, then force-pushed.
The sensitive material it touches (live DBs, Takeout dumps, NSFW rule lists, exports and
saved-content text) is also **gitignored at the path level**. Run the Bun checker on the rebuilt
tree, not on this one, before every publication.

### Public-safe (tracked, mirrors fine)

- `src/**/*.ts`, `src/static/`, and `tests/` — source, UI, and synthetic regressions.
- `README.md`, `AGENTS.md`, `CHANGELOG.md`, `PRODUCT.md`, `DESIGN.md`, `LICENSE`, and the docs
  listed below — prose is public only after review: no owner handle, no personal contact address,
  no real workstation paths, no operational runbooks.
- Bun project/tooling files such as `package.json`, `bun.lock`, `tsconfig.json`,
  and lint/format configuration.

`docs/` is **not** public-safe by default. Every new file under `docs/`, `scripts/` and
`fixtures/` needs a manual review against the list below before it can be published.

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

### Tracked, but excluded from every published revision

These live in private `main` and are removed by the `--invert-paths` pass. Renaming them, copying
their content into another file, or reintroducing the same material under a new name defeats the
boundary: audit every new docs, fixture and script path.

| Path | Why it never ships |
|---|---|
| `docs/FRIEND-PILOT.md` | owner email, tunnel/deployment and SSH alias names, Cloudflare account and zone IDs, token prefix/name/expiry, keyring reference |
| `NEXT.md` | session notes: the live pilot URL, the owner handle, operational open items |
| `docs/specs/10-media-backup.md` | workstation drive layout and backup procedure |
| `scripts/overnight-watchdog.py` | personal notification topic, machine-specific directories and a user-profile log path |
| `scripts/run-video-archive.ps1` | same notification topic, repo root drive path |
| `scripts/bakeoff_arm.py`, `scripts/bakeoff_batch.py` | one-off model-bakeoff plumbing with local drive paths |
| `scripts/mirror-media.bat` | media mirror job hard-coded to this workstation |
| `scripts/verify-media-mirror.bat`, `scripts/verify-mirror-media.bat` | mirror verifiers for those drive paths |
| `scripts/wp1_p4_backup_strategy.py` | one-off Windows disk-topology measurement |

Kept because they are generic and tested: `scripts/verify_mirror_media.ts` (pair it with your own
mirror command) and `scripts/demo.sh`. `docs/ai-suggestions.md`, `docs/DEMO.md` and
`docs/design/hooks.md` stay public but must not name the handle, the owner email, a sibling
repository path or a private runbook.

### Needs-scrub (regenerate, don't commit output)

- `tests/fixtures/sandbox/` output from `scripts/gen_sandbox_fixtures.py` —
  the script's own docstring warns: "output contains REAL personal data
  (usernames, titles, URLs, comment text). Do NOT commit." The committed
  fixtures under that path are hand-written synthetic examples; the script
  regenerates LOCAL-only copies for testing.

## The repeatable check

`scripts/publish_safety_check.ts` — exit 0 clean, exit 1 with findings. Run it in the rebuilt
public tree (a `/tmp` clone), because the private tree still contains the excluded files.

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
- `PRIVATE_IDENTIFIER` — a literal term from the private denylist, or a personal
  machine path, in a tracked file (source and `tests/` included).
- `HISTORY_IDENTIFIER` — the same two checks over historical blobs (`--history` only).

The private terms are **not** in this repository. The script reads them, one per line, from
`~/.config/content-hoarder/publish-denylist.txt` (or the file named by
`CONTENT_HOARDER_PUBLISH_DENYLIST`), and treats the file as absent, not as an error, outside this
machine. Put the owner handle in both cases, the personal contact address and the real name
variants there; keep the file mode `0600`.

Personal machine paths are detected without a denylist: `/home/<name>/`, `/Users/<name>/`,
drive-letter paths under personal roots (`Users`, `Projects`, `Backups`, `Documents`, …), and
`/mnt/<letter>/`. Generic examples such as `C:\path\to\app` and `/home/user/app` pass.

The script is read-only and offline. Placeholder values such as
`change-me`, `your-`, `<...>`, and `{{...}}` are ignored in a matched
credential value; an unrelated example comment cannot hide a real secret.
Test source files are excluded from the credential scan because they contain deliberate
credential-shaped fixtures — but **not** from the identifier scan. Serialized files under
`tests/fixtures/` are scanned by both.

## Refreshing the public repo

Back up the current public mirror first, then rebuild from private `main` in `/tmp`. Commit
messages are rewritten by `--message-callback`, because `--replace-text` only touches blobs.

```sh
git -C <public-clone> bundle create /tmp/content-hoarder-public-before.bundle --all
rm -rf /tmp/ch-public && git clone -q --single-branch --branch main . /tmp/ch-public
cd /tmp/ch-public
git filter-repo --force \
  --invert-paths \
  --path docs/FRIEND-PILOT.md --path NEXT.md \
  --path docs/specs/10-media-backup.md \
  --path scripts/overnight-watchdog.py --path scripts/run-video-archive.ps1 \
  --path scripts/bakeoff_arm.py --path scripts/bakeoff_batch.py \
  --path scripts/mirror-media.bat --path scripts/verify-media-mirror.bat \
  --path scripts/verify-mirror-media.bat --path scripts/wp1_p4_backup_strategy.py \
  --name-callback 'return name if name in (b"asmartin-ai", b"Claude", b"GitHub") else b"asmartin-ai"' \
  --email-callback 'return email if email.endswith(b"noreply.github.com") or email == b"noreply@anthropic.com" else b"291404369+asmartin-ai@users.noreply.github.com"'
git filter-repo --force --replace-text ~/.config/content-hoarder/public-replace.txt
git filter-repo --force --message-callback '
import os
path = os.path.expanduser("~/.config/content-hoarder/public-message-replace.txt")
for line in open(path, "rb").read().splitlines():
    if line:
        old, new = line.split(b"==>", 1)
        message = message.replace(old, new)
return message'
git log --format='%an|%ae|%cn|%ce' | sort -u   # only no-reply identities
bun install --frozen-lockfile && bun run check
bun run scripts/publish_safety_check.ts --history
```

`public-replace.txt` and `public-message-replace.txt` (git filter-repo `Old==>New` rules, one per
line, no comments) live outside the repo because their rules name what they hide: the owner
handle in both cases, the personal contact address, the real name variants, and real
workstation paths longest-first. Keep both files at mode `0600`.

A `git push --force` of `main` does not clean the rest of GitHub: side branches, archive tags,
`refs/pull/*` and issue/PR text keep the old material until they are deleted, rewritten or edited.
A force-push also doesn't remove what was public before — GitHub keeps old commits reachable by SHA,
and forks keep their history.

## Open decisions (deferred to user)

1. **Mirror to a second host** (e.g. Codeberg / self-hosted) — current
   posture is GitHub-only. Escalate only if the user wants redundancy.
2. **Sign tags / releases** — not currently done. Add if the user wants
   verifiable provenance.

## Concrete next action

Add `bun run scripts/publish_safety_check.ts` to whatever runs before `git push`
of the public mirror (pre-push hook or the user's manual checklist). A pre-push hook:

```bash
# .git/hooks/pre-push (chmod +x)
exec bun run scripts/publish_safety_check.ts || exit 1
```
