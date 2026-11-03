# Publication safety — public/private boundary for content-hoarder

**Status: ACTIVE (updated 2026-11-02).** Implements issue #73 (Pi.1). The repo is
already public (`github.com/asmartin-ai/content-hoarder`); this document
defines the boundary and the repeatable check to run before publication.

## Boundary

content-hoarder is **private-canonical with a rebuilt public copy**. Canonical history lives in
`asmartin-ai/content-hoarder-private` (remote `private`). The public repo
(`asmartin-ai/content-hoarder`, remote `origin`) is rebuilt from private `main` with every author
identity mapped to the GitHub no-reply address and private-only paths removed, then pushed
fast-forward. There is exactly one publish path: build the candidate in `/tmp`, scan its full
history, then push it with an explicit URL. The canonical checkout's `origin` push URL is
disabled (`DISABLED-use-publish-mirror`), so a push by habit fails instead of publishing.
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
| `bakeoff/` | one-off model-bakeoff plans, routing notes and run artifacts (moved to private in `495498c`); they name personal machine paths |
| `docs/internal/` | private recording and other internal notes; never previously published |

### Tracked, private-only after the public cutoff

The already-published paths in [`scripts/public-exclude-after-cutoff.txt`](../scripts/public-exclude-after-cutoff.txt)
are removed only from commits after public main's cutoff
`ff570f629a4881b50c3753360050de04cfe6b2ff`. Earlier public history remains unchanged and
accessible: this is a normal removal from the current tree, not a history cleanup.

| Paths | Reason |
|---|---|
| `.agents/`, `.claude/`, `.impeccable/` | private contributor tooling |
| `docs/design/clear-overhaul.md`, `clear-v2.md`, `deck-pass.md`, `hooks.md`, `inline-reddit-reader/` | historical internal designs |
| `docs/reddit-derisking.md`, `docs/search-operators-spec.md`, `docs/taxonomy.md`, `docs/reddit-management.md` | historical internal plans and notes |
| `scripts/wp1_p13_defense_review.py`, `scripts/gen_sandbox_fixtures.py`, `scripts/flag_dead_gfycat.py` | local one-off analysis or data mutation |
| `requirements.txt`, `uv.lock` | obsolete Python application dependencies |

Kept because they support public workflows: `scripts/verify_mirror_media.ts` (pair it with your
own mirror command), `scripts/demo.sh`, and `scripts/serve_mobile.ps1`. The optional
`scripts/gen_splash_screens.py` regenerates iOS splash images and requires Python and Pillow;
neither is required to run the app. `docs/ai-suggestions.md` and `docs/DEMO.md` stay public
and must not name the handle, owner email, a sibling repository path or a private runbook.

### Needs-scrub (regenerate, don't commit output)

- Generated `tests/fixtures/sandbox/` data can contain real usernames, titles, URLs and comment
  text. Never commit regenerated personal data. The committed fixtures are hand-written synthetic
  examples.

## The repeatable check

`scripts/publish_safety_check.ts` — exit 0 clean, exit 1 with findings. Run it in the rebuilt
public tree (a `/tmp` clone), because the private tree still contains the excluded files.

```bash
# Working tree only (fast; always run before push)
bun run scripts/publish_safety_check.ts

# Include git blob history (slower; required before every publish)
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

## Publishing the public repo

Build the candidate in `/tmp`, scan it, then push it. Commit messages are rewritten by
`--message-callback`, because `--replace-text` only touches blobs. The filter passes are
deterministic: rebuilding from private `main` reproduces every published commit verbatim and
appends the new ones on top, so the candidate stays a fast-forward of public `main`.

**Never push from the canonical checkout** — its `origin` push URL is disabled on purpose. A
push that is not a fast-forward means the build lost commits: stop and investigate instead of
forcing.

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
  --path bakeoff/ --path docs/internal/ \
  --name-callback 'return name if name in (b"asmartin-ai", b"Claude", b"GitHub", b"Zed") else b"asmartin-ai"' \
  --email-callback 'return email if email.endswith(b"noreply.github.com") or email in (b"noreply@anthropic.com", b"hi@zed.dev") else b"291404369+asmartin-ai@users.noreply.github.com"'
git filter-repo --force --replace-text ~/.config/content-hoarder/public-replace.txt
git filter-repo --force --message-callback '
import os
path = os.path.expanduser("~/.config/content-hoarder/public-message-replace.txt")
for line in open(path, "rb").read().splitlines():
    if line:
        old, new = line.split(b"==>", 1)
        message = message.replace(old, new)
return message'
CUT=ff570f629a4881b50c3753360050de04cfe6b2ff
git ls-tree -r --name-only "$CUT" -- $(cat scripts/public-exclude-after-cutoff.txt) > /tmp/ch-public-delete.txt
CUT=$CUT git filter-repo --force \
  --invert-paths --paths-from-file scripts/public-exclude-after-cutoff.txt \
  --refs "$CUT..main" \
  --commit-callback '
import os
cut = os.environ["CUT"].encode()
if cut in commit.parents:
    for name in open("/tmp/ch-public-delete.txt", "rb").read().splitlines():
        commit.file_changes.append(FileChange(b"D", name))'
rm /tmp/ch-public-delete.txt
git log --format='%an|%ae|%cn|%ce' | sort -u   # only no-reply identities
bun install --frozen-lockfile && bun run check
bun run scripts/publish_safety_check.ts --history
gitleaks git --redact --no-banner .
git fetch origin main
git merge-base --is-ancestor origin/main HEAD || { echo "not a fast-forward"; exit 1; }
git push https://x-access-token:"$(GH_TOKEN= gh auth token -u asmartin-ai)"@github.com/asmartin-ai/content-hoarder.git HEAD:main
```

The scans that must be clean before the push line runs:

1. `bun run check` — tests and the Bun publish checker on the rebuilt tree.
2. `scripts/publish_safety_check.ts --history` — private denylist terms, personal paths, and
   credential patterns over every blob. Terms come from
   `~/.config/content-hoarder/publish-denylist.txt`; identity and path rewrites come from
   `public-replace.txt` / `public-message-replace.txt`. The shared private denylist
   `~/.config/git/publish-denylist.txt` is the same list for every repo.
3. `gitleaks git` — config auto-detected from `.gitleaks.toml`: default rules plus the repo
   allowlist for documented fixtures. Expect `no leaks found`; never publish with findings.

`public-replace.txt` and `public-message-replace.txt` (git filter-repo `Old==>New` rules, one per
line, no comments, longest `Old` first) live outside the repo because their rules name what they
hide: the owner handle in both cases, the personal contact address, the real name variants, real
workstation paths, and the Tailscale address a historical test used as a `Host` header (rewritten
to TEST-NET-1, RFC 5737). Keep both files at mode `0600`.

The push URL names the `asmartin-ai` account explicitly because `gh` is authenticated as that
account, while the git credential helper resolves to a different one. Pass the token through the
URL, never on the command line as a separate argument, and redact it from any captured output.

What the push does **not** clean: side branches, archive tags, `refs/pull/*` and issue/PR text keep
the old material until they are deleted, rewritten or edited, and GitHub keeps old commits
reachable by SHA after any rewrite. Deleting the branch tip is not a removal.

## CI gate

`.github/workflows/leak-scan.yml` runs on every push and PR in the public repo: the gitleaks action
for the pushed commits, then a `gitleaks git` pass over every commit (`fetch-depth: 0`), plus a
tracked-file scan for personal machine paths and Tailscale addresses. The path scan skips
`src/_http.ts` and `tests/http.test.ts`: they hold the SSRF blocklist, which must name the
`100.64.0.0/10` range and test addresses inside it.

`.gitleaks.toml` allowlists two things only: the two publication-safety test files (they commit
deliberate synthetic credentials) and the `"key": "epic-…"` backlog id that trips
`generic-api-key` entropy. It carries one `[allowlist]` block because that schema works across
gitleaks versions; commit-scoped allowlists do not — 8.x silently ignores a `commits` field, so
scoping is by path and line regex. No denylist terms.

Rule sets differ between gitleaks releases: 8.24.3 (what `gitleaks-action` installs by default at
time of writing) reports findings that 8.30.1 does not. Verify with the action's binary
(`GITLEAKS_VERSION`) before trusting a local `no leaks found`.

## Open decisions (deferred to user)

1. **Mirror to a second host** (e.g. Codeberg / self-hosted) — current
   posture is GitHub-only. Escalate only if the user wants redundancy.
2. **Sign tags / releases** — not currently done. Add if the user wants
   verifiable provenance.
