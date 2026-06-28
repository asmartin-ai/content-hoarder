# SPEC — T3 tag editor: always show 3 suggestions

**Task ID:** `t3-tag-suggest-three`
**Worktree branch:** `delegate/t3-tag-suggest-three`
**Branch off:** `staging/mobile-polish-t2` (NOT `main`)
**SW cache version on success:** `ch-shell-v89` (bump from `v88` after `t3-peek-flicker` merges,
or the next free version — coordinate with orchestrator)
**Source:** T2 regression — `MOBILE-POLISH-T3-BATCH.md` item #4

## Goal

The T2 D1 tag-suggestions feature was specified as "show the last 2 categories + 1 recent tag (3
total) when the input is empty on mobile." The shipped code shows **only 1 suggestion** in
practice, because `_recentCategories()` is empty unless the item being tagged has a
`metadata.category`. For items without a category (most reddit/youtube items unless categorize
has run), the result is 0 categories + 1 tag = 1 suggestion.

The user expects 3 suggestions to show. Fix: **always show 3, backfilling with recent tags when
fewer than 2 categories are available.**

## Root cause (confirmed by reading the code)

In `src/content_hoarder/static/browse/tagedit.js`, the `options()` function (line 103):

```js
if (!q) {
  const applied = new Set(curTags.map(normTag));
  const cats = _recentCategories()
    .filter((c) => !applied.has(c))
    .slice(0, 2)
    .map((t) => ({ tag: t, create: false, kind: "category" }));
  const tags = _recentTags()
    .filter((t) => !applied.has(t))
    .filter((t) => !cats.some((c) => c.tag === t))
    .slice(0, 1)                            // ← always 1, regardless of how many cats showed
    .map((t) => ({ tag: t, create: false, kind: "tag" }));
  return [...cats, ...tags];
}
```

`_recentCategories()` is seeded only on editor open from `metadata.category` (line 318), and only
for items that HAVE a category. `_recentTags()` is seeded whenever a tag is added (line 213). So
for an item without a category, `cats.length === 0` and the result is `[...[], ...oneTag]` = 1
suggestion.

## Files in scope

- `src/content_hoarder/static/browse/tagedit.js` — the `options()` function (lines 103–128). The
  fix is in the empty-input branch (lines 106–117).
- `src/content_hoarder/static/sw.js` — bump `CACHE` to `ch-shell-v89` (or next free).
- `src/content_hoarder/static/browse/main.js` — bump `APP_VERSION`.

**Do NOT touch:** `core/tags.js` (the `suggestTags` helper is for the typed-query path, not the
empty-input path), `browse/reader.js`, any Python.

## Design constraints (locked)

- **Always 3 suggestions when the input is empty AND there are at least 3 candidate tags in the
  recent store.** The total is `cats.length + tags.length === 3` (or fewer if the recent stores
  are sparse — never pad with placeholder/synthetic suggestions).
- **Categories first, then tags.** Preserve the existing order: categories (with the `cat` kind
  badge) appear before plain tags. This matches the visual hierarchy (a category is a stronger
  suggestion than a free-form tag).
- **Backfill:** when `_recentCategories()` returns fewer than 2 items, take more tags to reach 3
  total. Concretely: `tags.slice(0, 3 - cats.length)`.
- **Deduplicate against applied tags AND against the cats already shown.** The existing two
  `.filter()` calls (lines 109, 113–114) stay; only the `.slice(0, 1)` changes.
- **Don't change the typed-query path.** When the user has typed something, the existing
  `suggestTags(known, curTags, q)` + "create new" logic (lines 119–127) is correct. Only the
  empty-input branch changes.
- **Don't seed `_recentCategories()` from anywhere new.** The seeding-on-editor-open behavior
  (line 318) is correct — categories surface as the user tags items that have them. Forcing
  categories into the store from elsewhere would pollute it. The backfill handles the sparse case.
- **No new localStorage keys.** Reuse `_RECENT_KEY` and `_CAT_RECENT_KEY`.
- **Mobile-only behavior unchanged.** The empty-input suggestions show on mobile (≤700px) and
  desktop. The `isPhone()` gate affects the close-on-Enter behavior (D3), not the suggestions.
  Don't conflate the two.

## Implementation sketch

```js
// tagedit.js options(), replace the empty-input branch (lines 106-117):
if (!q) {
  const applied = new Set(curTags.map(normTag));
  const cats = _recentCategories()
    .filter((c) => !applied.has(c))
    .slice(0, 2)
    .map((t) => ({ tag: t, create: false, kind: "category" }));
  // Always aim for 3 total: backfill with recent tags when fewer than 2 categories.
  const tagsNeeded = Math.max(0, 3 - cats.length);
  const tags = _recentTags()
    .filter((t) => !applied.has(t))
    .filter((t) => !cats.some((c) => c.tag === t))
    .slice(0, tagsNeeded)
    .map((t) => ({ tag: t, create: false, kind: "tag" }));
  return [...cats, ...tags];
}
```

That's the entire code change. The rest is cache/version bumps.

## Acceptance

1. **Open the tag editor on an item with NO category AND ≥3 recent tags in localStorage → 3 tag
   suggestions show.** (Previously: 1.)
2. **Open the tag editor on an item WITH a category AND ≥3 recent tags → 2 category suggestions
   + 1 tag suggestion (3 total).** (Existing behavior — verify it still works.)
3. **Open the tag editor on an item with 1 category in the recent store AND ≥3 recent tags → 1
   category + 2 tags (3 total).** (Backfill case.)
4. **Open the tag editor on a fresh install (empty recent stores) → 0 suggestions.** Don't pad
   with synthetic placeholders; the "No tags yet." chip + empty input is the correct empty state.
5. **Suggestions disappear when the user types** (existing behavior — the typed-query path takes
   over). Verify.
6. **Tapping a suggestion adds the tag, doesn't focus the input (D2), and on mobile closes the
   editor (D3/D4).** Existing behavior — verify the suggestion-row click handler (line 255) still
   works.
7. **Already-applied tags don't appear in suggestions.** If the item already has tag `foo` and
   `foo` is in the recent store, it's filtered out. (Existing behavior — verify.)
8. **Desktop multi-tag flow still works.** On desktop, tapping a suggestion adds the tag and the
   editor stays open for more (D3/D4 are mobile-only). Verify.

## Validation block

```
# 1. Unit suite — same 5 known env failures, NO new failures.
git stash
.venv/Scripts/python.exe -m pytest -q -m "not ui" --tb=no 2>&1 | tail -3
git stash pop

# 2. SW cache bumped:
grep 'const CACHE' src/content_hoarder/static/sw.js   # → "ch-shell-v89" (or next free)

# 3. APP_VERSION bumped:
grep 'APP_VERSION' src/content_hoarder/static/browse/main.js | head -1

# 4. UI smoke (manual serve + Pixel-6 OR desktop):
#    a. In DevTools console, prime the recent stores:
#       localStorage.setItem("ch_recent_tags", JSON.stringify(["alpha","beta","gamma","delta"]));
#       localStorage.setItem("ch_recent_categories", JSON.stringify(["watch","listenable"]));
#    b. Open the tag editor on an item with no category → expect 3 tag suggestions
#       (alpha, beta, gamma — NOT the categories, since the item has none).
#       Wait — the categories ARE in the store, so they should show FIRST. Re-read:
#       → expect 2 category suggestions (watch, listenable) + 1 tag (alpha) = 3 total.
#    c. Clear categories: localStorage.setItem("ch_recent_categories", "[]");
#       Open the editor → expect 3 tag suggestions (alpha, beta, gamma).
#    d. Clear tags too: localStorage.setItem("ch_recent_tags", "[]");
#       Open the editor → expect 0 suggestions (the "No tags yet." chip + empty input).
#    e. Type "alph" → expect the typed-query path: "alpha" as a known tag (no "create" badge
#       if it's in the known vocabulary) or "create alpha" if not.
#    f. Tap a suggestion → tag is added; on mobile, editor closes.
```

## Report back

- Branch: `delegate/t3-tag-suggest-three`
- Files changed:
- Unit suite result:
- UI smoke result (each of items a–f):
- Anything punted to T1:
