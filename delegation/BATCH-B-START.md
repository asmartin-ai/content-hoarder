# Batch B kickoff notes — 2026-06-28

> **FOLDED INTO BACKLOG.md (2026-06-28).** The keyboard proposal, Firefox Sync research, and tag landscape data have been folded into BACKLOG.md Epics 5, 7, and 9. Retained as an archived decision record.

> Snapshot as of 2026-06-28.

This captures the decisions that started Batch B and the outcome after RedGifs shipped. It is a dated
planning/as-built snapshot, not an active implementation branch.

## Decisions from user

1. **RedGifs resolver v1:** metadata-only dry-run first.
2. **RedGifs safety gate:** require explicit NSFW/RedGifs opt-in.
3. **Watch Later/WL3:** defer for now; no sample export. Existing imported WL2 playlist can be used for
   analysis, but not as a format target for a new connector.
4. **Firefox tabs:** explore Firefox Accounts / Firefox Sync synced-tabs access instead of a local
   WebExtension/paste endpoint.
5. **Tags:** first produce a map of the current tag landscape before choosing coverage work.
6. **Keyboard:** do online research and propose a better keymap before implementation.

## Current tag landscape

### Code-defined curated tags

Curated rail tags are `REDDIT_TAGS + db.PROCESSING_TAGS` in `src/content_hoarder/categorize.py`:

- Reddit/topic/NSFW: `nsfw_erotic`, `nsfw_talk`, `nsfw_other`, `vtubers`, `coding`, `japan`, `anime`,
  `memes`, `minecraft`, `defense`, `science`, `tips`, `esports`, `gaming`, `investing`, `ephemeral`.
- Processing areas from `db.PROCESSING_TAGS`: `watch`, `listenable`, `wotagei`.

Rail groups:

| Group | Tags |
|---|---|
| Gaming | `gaming`, `esports`, `minecraft` |
| Anime & Otaku | `anime`, `vtubers`, `wotagei` |
| Educational | `science`, `coding`, `tips`, `investing` |
| Watchlist | `watch`, `listenable` |
| Memes & Trivial | `memes`, `ephemeral` |
| World & Culture | `defense`, `japan` |
| NSFW | `nsfw_erotic`, `nsfw_talk`, `nsfw_other` |

Resurfacing clusters: `tips`, `coding`, `science`, `japan` plus selected subreddits. Identity/meme content
is intentionally excluded from resurfacing.

### Live DB snapshot, 2026-06-28

Read-only probe against `data/app.db`:

```text
items_by_source [('reddit', 65432), ('youtube', 12125), ('hackernews', 9374), ('firefox', 2269)]
untagged_by_source [('reddit', 27533), ('hackernews', 9211), ('firefox', 2208), ('youtube', 305)]
curated_tag_counts [('memes', 17984), ('watch', 9083), ('anime', 5905), ('defense', 5842), ('vtubers', 2840), ('tips', 2500), ('listenable', 2500), ('coding', 2426), ('gaming', 2325), ('minecraft', 2215), ('esports', 2117), ('science', 2101), ('nsfw_erotic', 1025), ('japan', 572), ('nsfw_talk', 384), ('wotagei', 237), ('ephemeral', 203), ('investing', 131), ('nsfw_other', 52)]
manual_tag_counts_top30 [('memes', 5), ('minecraft', 2)]
categories [('watch', 9083), ('listenable', 2500), ('unknown', 305), ('wotagei', 237)]
folders []
json_errors 0
```

Interpretation:

- The biggest remaining untagged surfaces are **HN** and **Firefox** by percentage, and **Reddit** by raw count.
- HN/Firefox heuristics are intentionally tiny today: host tags for Steam/defense/business sites and a few title
  keywords. This is likely the best next coverage target if we want easy, low-risk wins.
- Reddit still has 27.5k untagged, but many intentionally skipped communities are discussion/identity/general subs;
  expansions should come from sampled inventories, not broad keywords.
- Manual tags are barely used yet; do not optimize user-tag vocabulary management before there is actual use.

## Firefox Accounts / Sync synced-tabs research

Sources checked:

- Mozilla Sync overview: Sync stores browser data on a server, but data is encrypted locally before upload; server
  operators cannot read it without the Sync key.
- Mozilla Sync object formats: synced tabs are a `tabs` collection. Version 1 stores one record per client with
  `clientName` and `tabs[]`; each tab has `title`, `urlHistory`, `icon`, and `lastUsed`. Version 2 proposes one
  record per tab with `clientID`, `title`, `history`, `lastUsed`, `icon`, and `groupName`.
- Mozilla Token Server API: a Sync client uses a Mozilla Account OAuth bearer token to obtain a short-lived Sync
  token and `api_endpoint` for the Sync Storage API.
- Maintained `syncstorage-rs` docs confirm Mozilla Sync storage is backend infrastructure for encrypted Sync data,
  not a simple readable account API.

Conclusion: **there is probably no simple “Firefox Accounts API: give me my synced tabs” endpoint**. A true synced-tabs
integration likely requires implementing enough of Firefox Sync client auth + key derivation + collection decryption
to read the encrypted `tabs` collection. That is T1/research, not a T2 implementation task yet.

Recommended next shape:

1. Make this a **research spike**, not a feature build.
2. Look for an existing maintained Python library or CLI that can authenticate to Firefox Sync and decrypt collections.
3. If no trustworthy library exists, prefer the simpler WebExtension/manual-push path rather than implementing Sync
   crypto in content-hoarder.
4. If a library exists, build a read-only proof that lists tab titles/URLs from the `tabs` collection without writing
   to the DB.

Tier: **T1-led research**. A weaker agent can do library/source discovery and return candidates, but should not write
production code.

## Keyboard research and proposed direction

Sources checked:

- Gmail shortcuts: `j/k` older/newer navigation, `o`/Enter open, `x` select, `e` archive, `b` snooze, `z` undo,
  `/` search, `?` help, `g ...` navigation prefixes.
- Firefox shortcuts: avoid browser/system conflicts like Ctrl/Cmd chords, `/` quick find/search behavior, Esc close,
  arrows/Page/Home/End for native navigation/media.
- Current content-hoarder browse keys: `/` search, `?` help, `w/s` cursor movement, `f` keep, `a` archive, `d` done,
  `x` back-to-inbox when off-inbox, `e` open original URL, `t` tag, `q` select, `z` undo, `y` redo, Space media preview.
- Current triage keys: `s` keep, `e`/→ archive, `y`/← done, Space skip, `z`/`u` undo, `?` help.

Problems in current map:

- Browse and triage disagree (`F/A/D` vs `S/E/Y`) for the core actions.
- Browse uses `w/s` for movement, but `s` means keep in triage and means star in Gmail-like apps.
- `q` select is nonstandard; Gmail uses `x` for select.
- `e` currently opens original in browse but means Archive in triage/Gmail.
- `y` redo in browse but Done in triage; this is a standing ambiguity.

Recommended v1 keymap for review:

| Action | Browse | Triage | Reader | Rationale |
|---|---|---|---|---|
| Move prev/next item | `k` / `j` | n/a | maybe comment prev/next later | Gmail/Vim convention; frees `s`. |
| Open focused item / reader | `o` or Enter | ↑ already opens reader by gesture | n/a | Gmail uses `o`; Enter is accessible. |
| Keep | `f` | `f` | `f` | Existing reader/backlog uses F; mnemonic “favorite/file for later”; avoids Gmail `s` star ambiguity. |
| Archive | `e` | `e` / → | `e` | Gmail archive = `e`; aligns triage. |
| Done | `d` | `d` / ← | `d` | Mnemonic; aligns browse. Keep arrow fallback in triage. |
| Snooze | `b` | `b` or long-left/button | `b` | Gmail snooze = `b`; frees `s`. |
| Skip/pass | Space | Space | n/a | Already natural in triage; browse Space can remain media preview only if focused media exists. |
| Tag | `t` | `t` if exposed | `t` | Existing and mnemonic. |
| Select row | `x` | n/a | n/a | Gmail standard; current bulk buttons already show X for back-to-inbox, so resolve conflict first. |
| Back to Inbox | `i` or `Shift+I` | n/a | n/a | Avoids stealing `x` from selection. |
| Undo | `z`, Ctrl+Z | `z` / `u` | `z` if action toast exists | Existing; Gmail uses `z`. |
| Redo | Ctrl+Y / Ctrl+Shift+Z only | none | none | Remove bare `y` redo to free `y`/avoid accidental action. |
| Search | `/` | `/` maybe focus source/filter later | n/a | Standard; matches current. |
| Help | `?` | `?` | `?` | Standard. |
| Surprise | `r` or keep `q` | n/a | n/a | `q` is okay but nonstandard; `r` means random but conflicts with reply in email apps. Low priority. |

Implementation guidance:

- Keep legacy aliases for one release if cheap: browse `w/s` can still move; triage `s`/`y` can keep/done temporarily,
  but the cheatsheet should advertise the new map.
- Do not bind bare keys while typing or while modals/editors own focus.
- Do not override browser Ctrl/Cmd chords except existing undo/redo.
- Update templates/cheatsheets and Playwright coverage in the same task.

Tier: **T2 after user approves the map**. Implementation may touch `browse/main.js`, `triage.js`, `templates/index.html`,
`templates/triage.html`, and tests, so run it as a single task or split browse vs triage deliberately.

## Batch B readiness after this pass

| Task | Status | Recommended next step | Delegation tier |
|---|---|---|---|
| RedGifs resolver dry-run | Shipped | `resolve-redgifs` CLI + opt-in gate + dry-run/apply oracle tests landed on `main`. Targeted `tests/test_redgifs_resolver.py` passes; broad non-UI suite still has the known Windows `tmp_path`/SQLite URI failures. | Done |
| Watch Later/WL3 | Deferred | Use WL2 only for analysis; wait for a real export sample before new connector work. | none now |
| Firefox synced tabs | Research spike | Find existing Sync client/decryption libraries; prove read-only tab listing before DB work. | T1-led, maybe weak-agent research |
| Tag landscape | Initial map done | Decide target: HN/Firefox host/domain coverage is the likely lowest-risk expansion. | T2 once target chosen |
| Keyboard keymap | Proposal ready | User approves/edits keymap, then write implementation spec. | T2, likely one task |

## Cost/minimization note

Do not use headless Aider for research/design decisions. Use it once there is a tight implementation spec with an
oracle test. RedGifs proved the pattern: lock offline oracle tests first, then let a weaker executor implement the
bounded code path under the aider integrity gate.
