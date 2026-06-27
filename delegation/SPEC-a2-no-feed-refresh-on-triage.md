# SPEC — A2: Don't refresh the feed on reader Done/Archive/Keep

**Task ID:** `a2-no-feed-refresh-on-triage`
**Worktree branch:** `delegate/a2-no-feed-refresh-on-triage`
**SW cache version on success:** `ch-shell-v80` (bump from `v77`)
**Source backlog item:** Epic 15, `BACKLOG.md` ~L937 ("Don't refresh the feed on reader Done/Archive/Keep")

## Goal

Triaging the reader's item (F/A/D keyboard shortcuts, the new semi-circle dock buttons, or the
Snooze action) currently calls `onTriage` → `act()` → `render()` which can reflow the list and lose
scroll position. The feed should NOT refresh on a reader triage action — only on a manual pull-to-
refresh or a full app reload. The triaged item should disappear from the list **lazily** (on the
next natural `loadMore` / refresh), and the reader should close to the **exact scroll position** the
user was at.

## Files in scope

- `src/content_hoarder/static/browse/main.js` — the `act()` function (~L297–335) and the
  `readerUI = initReader({onTriage: act, …})` wiring (~L402). The fix lives in how `act` behaves
  when called from the reader path vs. the inline row path.
- `src/content_hoarder/static/browse/reader.js` — `closeReader()` (~L1380) and the F/A/D/Snooze
  keyboard + dock-button handlers (~L1427, ~L1649) that call `closeReader(false)` then
  `onTriage(fn, status)`. The order matters: close first (which restores `feedScrollY`), then triage.
- `src/content_hoarder/static/sw.js` — bump `CACHE` to `ch-shell-v80`, update the comment.
- `src/content_hoarder/static/browse/main.js` — bump `APP_VERSION` to `v74`.

**Do NOT touch:** the inline row `act()` path (swipe / row action buttons / bulk — those SHOULD
still reflow, that's the existing correct behavior), `core/api.js`, `core/overlaynav.js`, any
Python.

## Current behavior (confirmed by reading the code)

```js
// main.js ~L297
async function act(fullname, status) {
  lastUndone = null;
  if (window.chHaptic) window.chHaptic(status);
  const row = rowEl(fullname);
  if (row && !row.classList.contains("leaving")) {
    row.classList.add("leaving", "lv-" + status);
    await new Promise((r) => setTimeout(r, 180));   // <-- 180ms leave animation
  }
  try {
    await api.setStatus(fullname, status);
    clearItemFirstPageCache();
  } catch (e) { /* rollback + toast */ return; }
  state.items = state.items.filter((it) => it.fullname !== fullname);   // <-- removes from list
  if (state.focus) state.batchCleared += 1;
  bumpPulse(status === "inbox" ? 0 : 1);
  render();   // <-- FULL reflow of #items
  snackbar(/* undo */);
}
```

```js
// reader.js ~L1427 (F/A/D), ~L1649 (dock buttons)
closeReader(false);                              // restores feedScrollY via window.scrollTo(0, feedScrollY)
if (typeof onTriage === "function") onTriage(fn, status);   // → act() → render() → reflow
```

**The bug:** `closeReader` restores `feedScrollY` correctly, but `act()` then calls `render()`,
which rebuilds `#items` from `state.items` (now missing the triaged row). The rebuild can shift
scroll position (especially under the collapsing `.console` header, which re-evaluates on scroll),
and the leave-animation's 180ms delay means the user sees the row vanish from the list while the
reader is still closing. The combination feels janky and "loses your place."

## Design constraints (locked — these are the user's decisions from the backlog)

1. **The feed does NOT refetch on a reader triage action.** No `/items` call, no `clearItemFirstPageCache`
   + reload. (The status POST to `/items/<fn>/status` still happens — that's the persistence, not a
   feed refresh.)
2. **The triaged item leaves the list lazily** — on the next natural `loadMore` / pull-to-refresh /
   app reload, not immediately. The reader closes to a list that still contains the item (with its
   prior status). This is the explicit design decision in `BACKLOG.md` L937–943.
3. **Scroll position is preserved unconditionally across reader open/close.** `feedScrollY` already
   handles the close side (reader.js ~L1393: `if (feedScrollY) window.scrollTo(0, feedScrollY)`).
   Verify it survives the act path — the fix is to NOT call `render()` from the reader triage path.
4. **The inline row `act()` path is unchanged.** Swiping a row, tapping a row action button, or a
   bulk action SHOULD still animate the row out + reflow. Only the reader path gets the lazy
   behavior.
5. **Undo still works.** The reader triage undo (the snackbar) must still reverse the status. Since
   the row is still in `state.items` (lazy removal), undo is even simpler — just revert the
   in-memory status + the API undo call. No re-insert needed.

## Implementation sketch

The cleanest split: give `act()` an options arg, or add a `actFromReader()` variant. The agent
picks; the sketch below uses an options arg because it keeps one code path.

```js
// main.js — act() gains an {fromReader} option
async function act(fullname, status, opts = {}) {
  const fromReader = !!opts.fromReader;
  lastUndone = null;
  if (window.chHaptic) window.chHaptic(status);

  if (!fromReader) {
    // inline row path: leave-animation + immediate removal (existing behavior)
    const row = rowEl(fullname);
    if (row && !row.classList.contains("leaving")) {
      row.classList.add("leaving", "lv-" + status);
      await new Promise((r) => setTimeout(r, 180));
    }
  }

  try {
    await api.setStatus(fullname, status);
    if (!fromReader) clearItemFirstPageCache();  // reader path: don't invalidate; lazy on next load
  } catch (e) {
    if (!fromReader && rowEl(fullname)) rowEl(fullname).classList.remove("leaving", "lv-" + status);
    toast("That didn't stick — try again.");
    return;
  }

  if (fromReader) {
    // LAZY: keep the item in state.items; just update its status in memory so the next render
    // (on loadMore / refresh) shows the right folder. Don't call render() — the reader's
    // closeReader already restored feedScrollY; a render() here would reflow and lose it.
    const it = state.items.find((x) => x.fullname === fullname);
    if (it) { it.status = status; it.processed_utc = Math.floor(Date.now() / 1000); }
    bumpPulse(status === "inbox" ? 0 : 1);
    if (state.focus) state.batchCleared += 1;
    snackbar(COPY[status] || "Logged.", async () => {
      if (window.chHaptic) window.chHaptic("undo");
      try {
        await api.undoItem(fullname);
        // no cache to clear (we didn't invalidate); no render() — the row never left
        const it2 = state.items.find((x) => x.fullname === fullname);
        if (it2) { it2.status = it2.status_prev || "inbox"; it2.processed_utc = null; }
        bumpPulse(status === "inbox" ? 0 : -1);
        if (state.focus) state.batchCleared = Math.max(0, state.batchCleared - 1);
        lastUndone = { fullname, status };
        toast("Undone.");   // no full render — the row stayed put
      } catch (e) {
        toast("Undo failed.");
      }
    });
    return;
  }

  // inline row path (existing behavior — unchanged)
  state.items = state.items.filter((it) => it.fullname !== fullname);
  if (state.focus) state.batchCleared += 1;
  bumpPulse(status === "inbox" ? 0 : 1);
  render();
  snackbar(COPY[status] || "Logged.", async () => { /* existing undo — unchanged */ });
}
```

Then update the reader wiring to pass `{fromReader: true}`:

```js
// main.js ~L402
const readerUI = initReader({
  onTriage: (fn, status) => act(fn, status, { fromReader: true }),
  onSnooze: (fn) => snooze(fn, { fromReader: true }),   // if snooze() shares the act() shape; see below
  …
});
```

**Snooze:** check `snooze()` in `main.js` — if it also calls `render()`, give it the same
`{fromReader}` treatment. The dock's Snooze button + the `s` keyboard shortcut both route through
`onSnooze`, so the same lazy-removal applies.

**Edge case — `state.focus` (Focus batch mode):** in Focus mode, the deck pulls one batch at a
time and clearing is counted. The reader is opened from the deck in Focus mode too. The design
decision says the item leaves lazily — so even in Focus mode, the reader triage does NOT trigger
a batch reload. The `state.batchCleared` counter still increments (the "PAGE CLEARED" stamp logic
reads it), and the next natural batch load picks up the new state. Verify the Focus-mode
"PAGE CLEARED" stamp still fires correctly when the batch is drained via reader triage — if it
doesn't, that's a follow-up, not a blocker (note it in the report).

**Edge case — the triaged item's row is still in the DOM when the reader closes.** The user sees
it briefly with its old status before the next refresh. That's the **intended** lazy behavior per
the backlog. Don't add a fade-out or status-pill update on the row — that would be a half-measure
that confuses the "lazy" contract. The row just stays as-is until the next load.

## Acceptance

1. **Scroll position preserved:** open the reader from a row near the bottom of a long feed, press
   `F` (Archive) → reader closes, feed is at the **exact** same scroll position (within 1px). No
   reflow flicker. The triaged row is still visible in the list (lazy).
2. **No `/items` refetch:** with the browser devtools Network tab open, press `F`/`A`/`D` in the
   reader → only the `POST /items/<fn>/status` fires. No `GET /items?…`. (Confirm
   `clearItemFirstPageCache` is NOT called on the reader path.)
3. **Lazy removal:** after the reader triage, scroll the feed — the triaged row is still there with
   its old status. Trigger a `loadMore` (scroll past the bottom) or a pull-to-refresh → the row
   finally disappears (the next page reflects the new status, excluding it from the inbox view).
4. **Undo works:** after a reader `F`, tap the snackbar Undo → the item's status reverts (the row
   that's still in the list keeps its place; no reflow). Network: `POST /undo` fires.
5. **Inline row path unchanged:** swipe a row to Archive → 180ms leave animation, row removed,
   list reflows (existing behavior). The reader path is the only one that changed.
6. **Snooze from reader:** press `S` in the reader (or tap the dock Snooze) → reader closes, feed
   stays put, no refetch. Same lazy behavior.
7. **Focus mode:** reader triage in Focus mode still increments the cleared counter and the deck
   advances; the "PAGE CLEARED" stamp still fires when the batch is drained. (If this is broken,
   note it — don't block the merge for it.)
8. **Dock buttons + keyboard + Snooze all route through the new path.** No `render()` call from any
   reader-initiated triage.

## Validation block

```
# 1. Unit suite — same 5 known env failures, no new.
python -m pytest -q -m "not ui" 2>&1 | tail -20

# 2. grep proves the reader path is wired:
grep -n 'fromReader' src/content_hoarder/static/browse/main.js   # appears in act() + the onTriage/onSnooze wiring
grep -n 'clearItemFirstPageCache' src/content_hoarder/static/browse/main.js | head   # NOT in the fromReader branch

# 3. SW + APP_VERSION bumped:
grep 'const CACHE' src/content_hoarder/static/sw.js   # -> "ch-shell-v80"
grep 'APP_VERSION' src/content_hoarder/static/browse/main.js | head -1   # -> "v74"

# 4. UI smoke (manual, against data/app.db or a synthetic DB):
python -m content_hoarder serve
# - open the feed, scroll down ~5 screens, click a row to open the reader
# - press F → reader closes, scroll position unchanged, row still in list
# - open devtools Network → confirm no GET /items fired
# - pull-to-refresh (or scroll past bottom) → row finally disappears
# - repeat with the dock buttons + S key + A + D
# - undo via the snackbar → row stays, status reverted

# 5. Playwright (only if chromium is available; do NOT write a new test in this task):
pytest -m ui -k reader   # if any reader-related UI test exists
```

## Report back

- Branch: `delegate/a2-no-feed-refresh-on-triage`
- Files changed:
- Unit suite result:
- UI smoke result (scroll preserved? no GET /items on triage? lazy removal on next load?):
- Did `snooze()` need the same treatment? (yes/no + what you did):
- Focus-mode "PAGE CLEARED" still fires? (yes/no/needs-followup):
- Anything punted to T1:
