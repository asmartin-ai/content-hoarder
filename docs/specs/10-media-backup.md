# Spec 10 — `data/media/` backup strategy (report-only)

**Status: PROPOSED 2026-07-03.** Report-only per DIRECTION §5 P1.2 (T1); no code
implemented. Deliverable = this document + one recommendation + open user
decisions. Execution is user-gated.

**Context:** `data/media/` is a content-addressed blob store (flat
`<sha256>.<ext>` files, ~18 GB / ~32,506 blobs as of 2026-07-02) holding the
ONLY local copies of deleted-Reddit media rescued by `archive-media`. The
directory is gitignored and excluded from the metadata-only DB backups
(`web.py`/`cli.py` `_backup_db` copy `app.db` only). Losing it is
irrecoverable — the remote CDN copies are gone, that's why these bytes were
hoarded. See `media_store.py`, `AGENTS.md` gotcha #7.

## Why a separate strategy

- **Size.** 18 GB doesn't fit in the existing DB-backup rotation; it's not a
  "copy the file" job, it's a small mirror.
- **Dedup is already done.** Content-addressing means every filename IS its
  hash — verification is `sha256(file) == filename[:64]`, nearly free. Any
  backup tool that re-hashes gets a perfect integrity check for free.
- **Append-only workload.** `media_store.store()` writes once and never
  mutates. No incremental/delta needs; a plain mirror catches everything new
  since the last run. Deletions don't happen (a "gone" media URL updates
  `metadata.media_status`, never deletes the rescued blob).
- **Windows + single-user.** No cloud, no off-site. The threat model is
  drive failure / accidental `rm` / corruption, not "the house burns down."

## Recommendation: robocopy mirror to a second local drive

**One job, one command, idempotent:**

```bat
robocopy K:\Projects\content-hoarder\data\media <DEST>\media /MIR /R:2 /W:5 /MT:16 /NP /LOG+:<DEST>\media-mirror.log
```

- `/MIR` — mirror mode (copies new+changed, purges dest files no longer in
  source). Since the source is append-only in practice, `/MIR` effectively
  behaves as `/E` (add-only) — the purge clause never fires on real data, but
  keeps the dest clean if a blob is ever legitimately removed.
- `/MT:16` — 16 threads; SHA-stable files hash fast on local SSD.
- `/R:2 /W:5` — 2 retries, 5s apart; bounded, no infinite stalls on a flaky
  dest drive.
- `/LOG+:...` — append to a rolling log so each run is auditable.

**Why robocopy over restic/Kopia:**
- Zero install (Windows built-in), zero config, zero encryption-key custody.
- Content-addressed source = no need for restic's dedup (already done).
- Single-user, LAN-only, threat model = drive failure — block-level mirror
  is the right primitive; restic's encrypted incremental snapshots add
  key-management burden for no threat coverage we actually face.
- If the threat model widens (off-site, ransomware), **then** restic to
  Backblaze B2 / a tailnet peer becomes the right escalation — see "Open
  decisions" below.

**Verify story (free):**
```bat
:: re-hash every dest blob; filename IS the expected sha256
for %f in (<DEST>\media\*) do @powershell -NoProfile -Command ^
  "if ((Get-FileHash -Algorithm SHA256 '%f').Hash.ToLower() -ne '%~nf' split at .) { echo MISMATCH %f }"
```
A populated blob whose `sha256(file)` ≠ `filename[:64]` is corruption. This
runs unattended and is the same check `media_store.is_valid_id` enforces on
the read path. A full 18 GB sha256 pass on SSD is ~2-3 min; cheap enough to
run after each mirror.

**Restore drill:**
1. Stop the app.
2. `robocopy <DEST>\media K:\Projects\content-hoarder\data\media /E` (reverse
   direction, no purge).
3. `python -m content_hoarder` — the app reads blobs by hash; no DB change
   needed.
4. Spot-check one `/media/<blob>` URL in the PWA.

## Scheduling

User decision (not automated here). Two sane options:
- **Manual, after each `archive-media --apply` pass** (lowest risk, the user
  already initiated the only thing that adds blobs).
- **Scheduled Task weekly** (`schtasks /Create /SC WEEKLY ...`) — fine if the
  user is running archive passes more often than weekly.

The first matches the "every action gated" posture in DIRECTION §7 better.

## Target drive/host

**Recommendation: a second physical drive on the same machine** (e.g. `D:\`
or `E:\` if the primary is `K:\`), NOT a subdir of the project. Rationale:
- Protects against the most likely failure (the K: drive dies).
- Stays LAN-local (no cloud, matches §7).
- If only one drive exists, an external USB-C SSD (1 TB is ~5x headroom on
  18 GB) is the cheap escalation.
- **Optional tailnet peer** as a second mirror (`robocopy` over UNC path to a
  trusted machine) covers "the house burns down" without leaving the
  tailnet — escalate only if the user wants it.

## Open user decisions

1. **Which drive/path is `<DEST>`?** Needs the user's actual drive layout.
2. **Manual-after-archive vs scheduled-weekly?** Recommended: manual, matches
   the existing gating posture.
3. **Second mirror to a tailnet peer?** No/yes. No is the default (single-user,
   one machine); yes if the user already runs a tailnet file server.
4. **Off-site (restic/B2) ever?** Defer until threat model widens; not needed
   for the current LAN-only single-user stance.

## What this spec does NOT cover

- The DB itself (`data/app.db`) — already backed up by the existing
  `_backup_db` path in `cli.py`/`web.py`. Separate concern.
- Live `archive-media --apply` runs (user-gated, see DIRECTION §7).
- The video-archive smoke procedure — that's spec 11 (P1.3).

## Next concrete action (literal first step)

Pick `<DEST>` (decision 1 above). Once chosen, the robocopy command above is
the entire implementation; paste it into a `scripts\mirror-media.bat` for
convenience and run once to seed.
