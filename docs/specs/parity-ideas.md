# Parity ideas — features for one item type that should apply to others

Status: **suggestions, not yet queued.** Created 2026-06-14.
Item types: `reddit`, `youtube`, `hackernews`, `firefox`, `obsidian`, `keep`.
Lane key: **T2** = backend/offline-testable, no Fable-5 design → overnight-safe. **Parked** = needs
Fable-5-grade UI design (frontend-v3 design is paused).

The recurring insight: several Reddit-only features are really *generic* features that happen to have
only been built for Reddit. Generalizing them removes per-source special-casing.

---

## A. Unified "discussion vs. content" affordance  — **T2 (frontend logic)**
**Asymmetry today:** Reddit image opens the raw image (fixed in spec 05); HN opens the discussion and
the article needs a chip (spec 04B); YouTube items can carry a saved companion discussion
(`companionsHtml`). Three bespoke solutions to one idea: *an item has a **content** target and a
**discussion** target; surface both.*
**Parity feature:** add `discussionUrl(item)` + `contentUrl(item)` to `core/render.js`, source-aware
(reddit: permalink vs url; hn: `item?id=` vs url; youtube: watch url vs companion thread). Title opens
one, a single shared chip component opens the other — one code path for all sources.
**Why now:** specs 04+05 already build the two halves; this folds them into one helper instead of two
one-offs. Low risk, high consistency. Effort: low-med.

## B. Author/handle link for every source  — **T2 (verify YouTube data)**
**Asymmetry:** Reddit `u/author` links to the user page; HN author link is spec 04A; YouTube channel is
**not** linked.
**Parity feature:** in `metaHtml`, when `item.author`/`metadata.channel` is present, link it to the
source's profile: reddit→`/user/<a>` (done), hn→`user?id=<a>` (spec 04), youtube→`youtube.com/@<handle>`
or `/channel/<id>`. Single "author anchor" helper keyed on `item.source`.
**Check first:** does the YouTube connector store a channel id/handle in `metadata`? (api-mapping-validation
— confirm the field before wiring.) Effort: low (after spec 04 lands the pattern).

## C. HN comment-thread viewer (parity with the Reddit thread viewer)  — **T2 (backend-heavy, reuses UI)**
**Asymmetry:** Reddit has a full hydrated comment-thread viewer (`reddit_threads` table + `/thread`
route + the lightbox). HN discussions have no in-app thread view — tapping just opens HN in a new tab.
**Parity feature:** fetch HN comment trees from the **Algolia HN API** (`https://hn.algolia.com/api/v1/items/<id>`
— no auth, returns the full nested tree), convert to the same render shape, store, and render in the
**existing lightbox**. Strongly consider generalizing `reddit_threads` → a source-agnostic `threads`
table (`fullname` PK already namespaces by source) so one viewer serves both.
**Why it's a good T2:** the fetch+convert+store is pure backend (offline-testable with injected
`get_json`, exactly like archival), and the viewer reuses what exists. High value — it's the single
biggest "make HN a first-class citizen" lever. Effort: med-high. (Would pair naturally with a future
`hn-hydrate` CLI mirroring `reddit-hydrate`.)

## D. Per-source enrich/hydrate lane  — **T2 (backend)**
**Asymmetry:** Reddit enriches scores via archives + hydrates threads; YouTube recovers titles via
yt-dlp; HN enrich exists for points/descendants but there's no "hydrate the discussion" step.
**Parity feature:** a consistent per-source hydrate verb. HN gets comment-tree hydration (see C);
the `enrich`/`hydrate` CLI surface stays uniform across sources. Mostly falls out of C. Effort: med.

## E. Score / age / "consume" meta parity  — **T2 (small)**
**Asymmetry:** `metaHtml` already shows `score + " pts"`, `ageMeta`, `consumeMeta` generically — but the
*labels* are Reddit-flavored ("pts"). Minor: YouTube could show view count / duration in the same slot;
HN shows points already.
**Parity feature:** make the meta slot source-aware for the numeric badge (pts / views / —) so every
card has a consistent "signal" line. Effort: low. Low priority.

## F. Source sub-facet rails  — **backend T2; rail UI Parked**
**Asymmetry:** `/reddit` has a subreddit rail; browse has a generic SOURCES+TAGS rail with no
sub-faceting.
**Parity feature:** sub-facets per source — HN by domain or Ask/Show/Story; YouTube by channel —
analogous to the subreddit rail. The **faceting/aggregation backend** (group counts in `search_items`/a
stats query) is T2-able and offline-testable; the **rail UI** is design work → park the visual side for
Fable 5, but the query layer can be built now.

---

## Suggested parity pickups (if you want to extend the overnight batch)
1. **C — HN thread viewer** (highest value; mostly backend; makes HN a first-class item type).
2. **A — unified discussion/content affordance** (cheap; folds specs 04+05 into one helper).
3. **B — author link parity for YouTube** (cheap follow-on to spec 04; verify the channel field first).

D/E/F are lower priority or partly design-gated. None of A–E need Fable-5 design; F's UI does.
