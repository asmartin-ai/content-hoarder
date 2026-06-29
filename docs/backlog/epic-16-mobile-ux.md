## Epic 16 — Mobile UX  (`enhancement`, `area:mobile`)
*Make the PWA feel native on the phone (Chrome / Pixel-6 target; switched from Firefox 2026-06-21).
Absorbs "make the Reddit view more mobile-friendly".*

### Mobile real-device QA observations — 2026-06-29

- [ ] **P1 — Lightbox blank-space drag must not scroll the inbox.** When the media preview lightbox is
  open, sliding on blank/backdrop space can still move the underlying inbox. Treat the whole lightbox/backdrop
  as a scroll-locked overlay: blank-space drags should either do nothing or close the lightbox via the existing
  gesture, but never scroll `#items`/document behind it. Add a mobile UI regression around feed scroll staying
  fixed while dragging blank lightbox space.
- [ ] **P1 — Long-press row menu shifts scroll position / feels awkward.** Long-pressing an inbox item to
  open the Relay strip can move the feed scroll position, making the item jump under the finger. Reproduce on
  real mobile, then keep the row anchored during long-press activation (likely snapshot scrollY + item rect,
  avoid layout-height changes, and prevent accidental drag/scroll during the activation window). Consider
  whether long-press should be narrowed to a handle or replaced by a less awkward gesture.
- [ ] **P1 — Hold-to-preview lightbox allows panning/zooming into empty space.** A long-press media preview
  can zoom out or pan right even when there is only blank space. Clamp zoom scale to `>=1`, clamp pan bounds
  to the image/video content box, reset transform on close/open, and disable pan while the preview is in
  temporary “peek” mode unless zoomed in.
- [ ] **P2 — Revisit inbox swipe controls / inertia.** Rapid left swipes currently tend to hit the long-left
  Snooze action; in real use, a fast decisive swipe probably means **Done**, not Snooze. Re-tune gesture
  recognition so velocity and travel are considered separately (fast flick → primary action; deliberate long
  hold/travel → secondary action), or revisit the whole left/right action map. This may supersede the current
  friction-asymmetry mapping from Epic 20.
- [ ] **P2 — Text Reddit post rendered with a misleading preview play button.** Repro: Reddit post titled
  “People who bring your dog literally everywhere, why?” shows a preview/play affordance even though it is an
  r/AskReddit text post. Fix media classification/rendering so text/self posts without playable media show a
  text/thread preview affordance, not a play button. Likely area: `media_type`, thumbnail fallback, and
  `browse/render.js` media tile selection.
- [ ] **P2 — Reader should swipe up from bottom when opened via triage swipe-up.** The triage ↑ gesture
  currently opens the reader functionally, but the transition should match the gesture: reader sheet/card
  enters upward from the bottom and returns to the triage deck on close. Coordinate with `overlaynav.js` so OS
  back and nested lightboxes still close correctly.
- [ ] **P3 — Surprise-me view should include a preview/blurb.** The Surprise card already renders media and
  opens the reader; add a short preview (text snippet, cached summary, or non-AI blurb) so the user can decide
  whether to open it. Cross-links Epic 20 Surprise card and Epic 15 reader/text-post preview blurbs.
- [ ] **P3 — Bring back subtle triage-card tilt on side swipes.** Low priority: the old Tinder-like tilt made
  triage swipes feel more physical. Restore a subtle `rotate()`/depth animation during horizontal triage drags,
  respecting reduced-motion and keeping the current shared `core/swipe.js` path.
- [ ] **Research / design-ref — Capture Relay-style interaction video for analysis.** User may provide a new
  video showing Relay-like features (lightbox captions, row gestures, reader motion, etc.). Once provided,
  analyze it into concrete design notes before implementing more gesture polish.

- [x] ~~**P2 — Swipe haptics are too strong — reduce them.**~~ ✅ SHIPPED 2026-06-22 (`haptics.js` +
  `core/swipe.js`, sw.js v54→v55). *(User-reported 2026-06-22.)* Commit patterns softened ~45%
  (archived 18→10, done 10→6, keep [10,30,10]→single 5, inbox 8→4, skip 6→3, milestone shortened, undo 8→4)
  AND the compounding `swipe.js` stage-2 threshold pulse 8→3 — a long swipe fired TWO buzzes (threshold +
  commit), which read as "too strong." Friction-asymmetry hierarchy kept.
- [x] ~~**P2 — Tag-add box clips into the bottom bar on mobile when idle (not fully hidden).**~~ ✅ SHIPPED
  2026-06-22 (`browse.css`, sw.js v56→v57). *(User-reported 2026-06-22.)* Root cause: `.tagpop`'s base
  `display:flex` overrode the `[hidden]` UA `display:none`, so `close()` (`pop.hidden=true`) left an EMPTY
  sheet pinned at `bottom:0` clipping into the bottom bar. Fix = one rule `.tagpop[hidden]{display:none}`
  (higher specificity). Verified: hidden→`display:none` in every state (incl. `.sheet` still applied — the
  exact tap-away-after-use case), shown→`flex`.
- [x] ~~**P2 — Back on the reader/triage view should return to the inbox, not exit the app.**~~ ✅ **Reader +
  overlays SHIPPED** 2026-06-22 via the shared `core/overlaynav.js` back-button coordinator (one history
  entry + one `popstate` over a stack; OS-back closes only the top overlay — verified live: reader closes +
  stays on app, lightbox-over-reader nesting closes LIFO).
  ✅ **Triage entry guard SHIPPED 2026-06-26:** `installTriageEntryBackGuard()` in `triage.js` — detects
  direct `/triage` entry (no same-origin referrer, navigation type `navigate`) and pushes a sentinel history
  entry so OS-back lands on `/` instead of exiting the app. Coordinates with `overlaynav.js` (open overlays
  close before the page guard fires). State change: `history.replaceState({chTriageInboxGuard})` + `pushState`.
  Playwright-tested: direct entry, browse→triage nav, overlay precedence, reload stacking. *(User-reported
  2026-06-22.)*
- [x] ~~**P2 — Back from the lightbox/gallery should return to the inbox, not exit the app.**~~ ✅ SHIPPED
  2026-06-22 (`core/overlaynav.js` + `core/media.js` createLightbox + triage.js inline lightbox, sw.js
  v55→v56). *(User-reported 2026-06-22.)* Both lightboxes register with the shared coordinator on open;
  OS-back closes the overlay and lands on the feed instead of exiting the PWA. Browse path verified live
  (open pushed history, back closed it, stayed on app); triage wired identically + page boots clean.
- [x] ~~**P1 — Swipe must not trigger horizontal page scroll.**~~ ✅ v3: `body{overflow-x:clip}` (`browse.css:15`) + `swipe.js:27` `touchAction="pan-y"` (transform-only drag + edge-zone guard) — a row swipe can't side-scroll the page. Orig: Lock the layout to the device width
  (fixed viewport, `overflow-x` containment) so swiping a row doesn't side-scroll the page.
- [x] ~~**P2 — NSFW blur in the inbox/triage**~~ ✅ v3: over-18 media blurred in the browse list (`render.js:13/62` veil + `browse.css:318` `filter:blur(16px)`), reveal-on-tap. Orig: adopt the Reddit view's blur for over-18 media.
- [ ] **P2 — DEFERRED: long-press on a thumbnail enters group-select.** ✅ tap-opens-modal SHIPPED on v3 (`main.js:161-180` delegated `[data-media]` → `openMediaFor`). The **long-press → group-select** half is intentionally deferred from the retention/gallery split: `swipe.js` has no long-press, and selection still lives on the avatar `[data-select]` button. Reactivate this when group-select returns to scope. Orig: Today a thumbnail
  tap on mobile doesn't open the modal.
- [ ] **P3 — ICEBOX: Swipe physics feel.** *(Iceboxed 2026-06-22 — user: "right now it's fine.")* The
  current swipe is a little stiff; could add momentum/spring + better thresholds for a smoother feel.
  Reactivate if the swipe starts to feel laggy/stiff in real use.
- [ ] **P3 — Mobile-friendly scrollbar** (Nova-Launcher-style fast-scroll handle).
- [ ] **P3 — Visual rework of the collapsing top bar.** *(User-requested 2026-06-22.)* The shrink-on-scroll
  shipped and works (Relay-style: scroll down → `.console.compact` collapses the search row + TODAY counter;
  expands at the top / on scroll-up — `browse/main.js` scroll handler + `.compact` rules in `browse.css`), but
  it wants a **visual polish pass**. Open ideas: smoother/spring collapse easing; decide what stays vs. hides
  when compact (shrink the brand? a slim always-tappable search affordance instead of fully hiding it? what the
  status pills do); a subtle elevation/shadow once scrolled; tune the down/up thresholds + add hysteresis so it
  doesn't flicker on tiny scrolls. Keep it inside the Fable design language (reuse tokens, don't invent a new
  paradigm — see preserve-fable-design). Pairs well with the Epic 23 design-language / GLM design-bakeoff lanes.
- [x] ~~**P2 — Inbox swipe = mobile/touch only.**~~ ✅ v3: `swipe.js:37` ignores `pointerType==="mouse"` unless `{mouse:true}`; `main.js` `attachSwipe` passes no `mouse` flag → desktop uses buttons, touch swipes. *(User decision 2026-06-08.)* Orig: Disable row-swipe on the
  inbox on desktop (desktop uses the action buttons/hover); keep swipe for touch only.
- [x] ~~**P2 — Snooze on extended left swipe (browse row).**~~ ✅ Shipped 2026-06-27
  (`main.js:264`): `attachSwipe` now passes `onLeftLong: () => snooze(fn)` — long ← = Snooze mirrors the triage
  deck. Underlay color + icon swap at the long-left threshold + haptic pulse. Friction-asymmetry: Snooze priced
  above Done/Archive (long swipe) but below Keep (right side). **Revisit requested 2026-06-29:** rapid flicks
  should probably commit Done rather than crossing into Snooze; see “Revisit inbox swipe controls / inertia”
  in the mobile QA batch above.
- [x] ~~**P2 — Remove Snooze from the long-press / right-click row menu.**~~ ✅ Shipped 2026-06-27:
  no `data-rowmenu="snooze"` in the template; `openRowMenu` only handles Tag + Share. Snooze lives on
  the long-left swipe (B1) + reader dock + relay strip.
- [x] ~~**P2 — Relay-style long-press: pan the item aside + reveal an extended action menu.**~~ ✅ Shipped
  2026-06-27 (`main.js openRowMenu` + `.relay-strip` template + `browse.css`): long-press/right-click a row →
  `.item-fg` translates aside, a horizontal action strip (Source, Author, Tag, Share, Snooze) slides in.
  Design decision B3: Copy Relay — horizontal row with icon-over-label, shows where the item was. Swipe-back
  (`onRelayClose`) collapses the strip; swipe + relay states are mutually exclusive (`relayCloseMode` in
  `core/swipe.js`). A transparent `.relay-scrim` captures outside taps / Escape.
- [x] ~~**P3 — Relay strip visual polish (icon-only, no text labels).**~~ ✅ Shipped 2026-06-27
  (T2 delegation, merged through the mobile-polish integration branch and now on `main`): the `.relay-lbl` spans
  are now visually hidden (sr-only pattern: `position:absolute;width:1px;height:1px;clip:rect(0,0,0,0)`)
  — screen readers still announce each button via its `aria-label`. Buttons enlarged 56×60 → 64×72,
  icons 24 → 32px. `@media (max-width:360px)` shrinks to 56×64 / 28px icons so 5 across never overflows
  on the narrowest phones. `title` attributes added on each `<button relay-btn>` for desktop hover
  tooltips. Template + click handler unchanged — pure CSS + 5 `title` attrs. SW v77 → v83 (combined
  with C2+B4 on staging). *(User-requested 2026-06-27.)* Orig: The current relay strip has icon +
  text label (e.g. "Source", "Author", …) — user wants icon-only per `relay-observations.md`. Also:
  make the buttons larger, ensure 5 evenly-spaced well-sized icons, and fix text overlap on narrow
  screens.
- [x] ~~**P2 — Hold-to-preview media (Relay-style press-and-hold lightbox).**~~ ✅ Shipped 2026-06-27
  (T2 delegation, merged through the mobile-polish integration branch and now on `main`): `pointerdown` on
  `[data-media]` starts a 250ms hold timer (10px slop cancels → swipe/scroll wins); when it fires,
  `openMediaFor(item, {peek:true})` opens the lightbox and `_attachPeekRelease()` in `createLightbox`
  registers a `window`-level `pointerup`/`pointercancel` listener that calls `close()` on release
  (window-level so release fires even if the finger drifts onto the lightbox content). A quick tap
  (<250ms, no movement) cancels the timer and the existing `[data-media]` click handler opens the
  lightbox persistently — a capture-phase click suppressor (`_suppressNextClick`) prevents the trailing
  click from re-opening after a peek. All `openMediaFor` branches thread `{peek}` through
  (`openImage`/`openGallery`/`openVideo`/`openMedia`/`openHtml` all gained an `opts_` arg). `close()`
  cleans up the release listener. `swipe.js`'s `[data-media]` long-press guard (450ms) already prevents
  the relay strip opening on a media hold, so the 250ms peek wins the race cleanly. SW v77 → v83.
  *(User-reported 2026-06-26.)* Orig: Pressing and **holding** a media thumbnail should open the
  lightbox **temporarily** — it stays open while the finger is down and closes on release (a quick peek,
  Relay-style).
- [~] **P3 — Scroll-deceleration physics feel (rapid scroll to top).** *(User-reported 2026-06-26.)* ✅
  Conservative browser-native stabilization shipped 2026-06-29: the floating ↑ button now routes through a
  reduced-motion-aware `scrollToBrowseTop()` helper, and the collapsing top-bar scroll handler uses
  `scrollend`/debounced idle coordination so header expansion doesn't fight active scroll momentum. Pixel-6
  PWA Playwright coverage was added/updated, but **physical Pixel 6 / Chrome Android tactile verification is
  still pending**; keep this half-open until a real-device pass confirms the fling/↑ feel is clean.
- [x] ~~**P2 — Sidebar open should defocus + scroll-lock the browse view.**~~ ✅ Shipped 2026-06-27:
  `lockBrowseScroll()`/`unlockBrowseScroll()` (`main.js:1330`), called from `openPanel()` and `openDrawer()`.
  Ref-counted so nesting works. Saved scroll position restored on unlock. The scrim already dims the list; this
  adds the scroll lock. Same treatment for `#statsheet`, `#dupesheet` via `openPanel`.
- [x] ~~**P3 — Surprise-me view rework.**~~ ✅ Shipped 2026-06-27.
  Design decision E3: surprise-me card is larger (pinboard-view size/shape), treated like an inbox item — opens
  the reader/thread with the same triage controls. The dice button renders in the ambient slot.
  Pairs with the Epic 20 P2 surprise-me media rendering (already shipped). **Follow-up requested 2026-06-29:**
  add a preview/blurb so the card is not just title/media; tracked in the mobile QA batch above.
- [ ] **P3 — Make the Reddit view mobile-friendly** (the `/reddit` table/grid is desktop-first).

### Mobile lightbox / media-viewer *(Epic 16)*

- [x] ~~**P2 — Scroll-lock the browse list while the lightbox is open.**~~ ✅ Shipped 2026-06-27:
  `createLightbox` accepts a `lockScrollEl` option; `openMediaFor` passes `#items` — scroll is saved, the
  element gets `overflow:hidden`, and restored on close (`core/media.js:349-373`).
- [x] ~~**P2 — Pinch-zoom + mouse-wheel zoom in the lightbox.**~~ ✅ Shipped 2026-06-27
  (T2 delegation, merged through the mobile-polish integration branch and now on `main`): `createLightbox` gained
  zoom state (`zoomScale`, `zoomImg`) + `setZoom`/`resetZoom` helpers. `wheel` on the body drives
  `transform:scale` via `Math.exp(-e.deltaY * 0.0015)` (exponential per-notch), clamped 1×–4×;
  `dblclick` resets. Two-finger `touchstart`/`touchmove`/`touchend` drives pinch zoom (ratio of
  finger-distance to the start distance); a `.zooming` class on the image disables the 120ms
  transition during the pinch so it tracks the fingers, removed on release; a settled scale <1.05
  snaps back to 1×. `closeVisual` calls `resetZoom()`; gallery image-swap (tap to upgrade preview →
  full-res) calls `setZoom(im, 1)` before swapping `src`. CSS: `transform-origin:center`,
  `transition:transform 120ms`, `touch-action:pan-y pinch-zoom` on `.media-img`/`.gallery-img`;
  `prefers-reduced-motion:reduce` kills the transition. Video path untouched (the `closest()`
  matches return null on `<video>`). SW v77 → v83. *(User-reported 2026-06-26.)* Orig: Inside the
  lightbox, a pinch gesture (touch) or mouse-wheel should **zoom the image** instead of scrolling
  the page.
- [x] ~~**P2 — Swipe-to-pan + swipe-far-to-close in the lightbox (Relay-style).**~~ ✅ SHIPPED 2026-06-27
  (`delegate/c3-lightbox-pan-close`, SW v85 → v86 merged). Pointer Events one-finger drag on the lightbox
  image: when zoomed (`zoomScale > 1.001`) pans with clamping to viewport bounds; at scale 1, vertical
  drag >120px calls the lightbox's own `close()` (not `history.back()`). `e.stopPropagation()` on drag-up
  prevents double-close via backdrop click. CSS: `.zoomed { touch-action: none; cursor: grab; }` +
  `:active { cursor: grabbing; }`. `pointercancel` handler cleans up state. Builds on C2's zoom state
  (`zoomScale`, `zoomImg`, `setZoom`/`resetZoom`). Two-finger pinch (C2) and one-finger pan (C3) coexist:
  pinch uses touch events, pan uses pointer events; second pointer is gated when zoomed. Same 5 known env
  failures, no new.

### T3 mobile-polish regression batch *(Epic 16)* — 2026-06-27

Real-device pass after the T2 mobile-polish sprint surfaced 8 regressions + 1 missing feature. The
historical batch docs were folded into this section during delegation cleanup; regression coverage lives in
`tests/ui/test_mobile_ux.py`.

- [x] **P1 — Swipe-left reveals blank space after long-press.** T2 regression: `swipe.js pointerdown`
  sets `fg.style.transition = "none"` unconditionally (even in `relayCloseMode`); the `end()`
  relay branch returns without `reset()`, leaving the inline `transition: none` to suppress the
  CSS slide-back when `relay-open` is removed → abrupt snap / visible blank strip. Fix:
  `t3-relay-swipe-close` skips the transition disable in `relayCloseMode` and always calls
  `reset()` at the end of the branch.
- [x] **P1 — Swipe-right from relay-open doesn't close the relay.** T2 regression: `end()` requires
  `horizontal && dx > 40` — the 40px triage-commit threshold is too high for an already-open
  overlay, and the `horizontal` decision can fail on a diagonal swipe. Fix: `t3-relay-swipe-close`
  lowers the close threshold to 10px and bypasses the `horizontal` decision in `relayCloseMode`.
- [x] **P1 — Hold-to-preview flickers (opens/closes repeatedly).** T2 regression (B4): the
  window-level peek release listener can fire twice (`pointerup` + `pointercancel`), and
  `swipe.js`'s 450ms long-press timer arms on `[data-media]` targets, racing the 250ms peek.
  Fix: `t3-peek-flicker` adds an idempotency guard (`_peekOpen`), makes the release listener
  fire-once across both event types, and moves the swipe.js `[data-media]` guard to skip the
  lpTimer arming entirely.
- [x] **P2 — Only 1 tag suggestion shown (D1 should show 3).** T2 regression: `tagedit.js options()`
  slices 2 categories + 1 tag, but `_recentCategories()` is empty unless the item has a
  `metadata.category` → 0 + 1 = 1. Fix: `t3-tag-suggest-three` backfills with recent tags to
  always reach 3 total when the stores have enough candidates.
- [x] **P1 — Lightbox swipe-to-close scrolls the page instead.** T2 regression (C3): the
  `pointermove` handler doesn't `preventDefault` and the image's `touch-action: pan-y` lets the
  browser scroll. Fix: `t3-lightbox-swipe-scroll` adds `preventDefault` on drag + sets
  `touch-action: none` on the image during the drag.
- [x] **P2 — Sidebar open still scrolls the browse view.** T2 regression (E1): `lockBrowseScroll`
  only locks `#items`, not the body; the `.navdrawer` lacks `overscroll-behavior: contain` so
  scroll chains. Fix: `t3-sidebar-scroll-lock` locks the body too (ref-counted) and adds
  `overscroll-behavior: contain` to the panels.
- [x] **P2 — Drop the reader triage dock (`.rd-foot`).** User decision 2026-06-27: the dock looks
  wrong on mobile; scrap it now, redesign later. Reader stays fully usable via swipe + keyboard
  (F/A/D/T/S/Esc). Fix: `t3-drop-reader-dock` deletes the `.rd-foot` element, its handlers, and
  its CSS. Safe-area inset preserved on `.rd-scroll`.
- [x] **P2 — UX verification tooling (Playwright).** T2 gap: the existing `tests/ui/test_smoke.py`
  covered feed load + gallery + topbar, but NOT relay/peek/tag-suggest/lightbox-swipe/sidebar-lock.
  Fix: `t3-playwright-ux-tests` added `tests/ui/test_mobile_ux.py` with one regression test per T3 fix;
  the suite now documents the final shipped mobile behavior on `main`.

### Mobile tagging UX *(Epic 16)*

- [x] ~~**P2 — Tag suggestions: last 2 categories + most-common manual tag.**~~ ✅ Shipped 2026-06-27
  (`tagedit.js options()` + `_recentCategories()` store in `localStorage ch_recent_categories`): when
  the input is empty on mobile, shows 2 recent categories + 1 recent tag as suggestions. Disappears on typing.
  Category store seeded on editor open from `metadata.category`.
- [x] ~~**P2 — Tapping a suggested tag should not open the keyboard.**~~ ✅ Shipped 2026-06-27
  (`tagedit.js:257`): tapping a `.tp-opt` calls `add(tag, {focus:false})` — no re-focus. The input stays blurred;
  the user can tap it to add another.
- [x] ~~**P2 — Keyboard flicker on Enter: closes + reopens the keyboard.**~~ ✅ Shipped 2026-06-27:
  solved by closing the editor on Enter (`isPhone()` → `close()` in `commit()`, `tagedit.js:219-221`).
  No keyboard flicker because the editor itself closes.
- [x] ~~**P2 — Close the tag editor on Enter / suggestion-tap (mobile single-tag flow).**~~ ✅ Shipped 2026-06-27
  (`tagedit.js:219-221`): `commit()` gates on `isPhone()` → `close()` instead of re-rendering. Desktop stays
  multi-tag (editor stays open). Bulk multi-tagging on mobile is a later feature.
- [x] ~~**P1 — Closing the reader must stop playing media (back-gesture keeps the video running).**~~ ✅ Fixed
  2026-06-20 (local, `frontend-staging`). *(User-reported 2026-06-19.)* On mobile, pressing **back** on the online
  embedded reader view left the video playing — audio bled after the feed was back on screen. `closeReader`
  (`browse/reader.js`) only removed the `.show` class + the `reader-lock`; the eager `videoTeardown()` was a
  **no-op** for direct + native-HLS playback (`mountVideo` returns `destroy:null` there, `core/media.js:123,132`)
  and the `<video>` element was never paused. **Fix:** added a `stopInlineVideo()` helper (tracks the mounted
  `videoEl`, runs HLS teardown, then `pause()` + `removeAttribute("src")` + `load()` and removes the `.rd-video-wrap`)
  called from `closeReader`. Since **all** close paths funnel through `closeReader` — close-button, popstate/back,
  Esc, the F/A/D reader keys, and swipe-right — every exit now silences playback. DOM-API sequence verified in the
  preview engine; full inline-video E2E not exercisable (no v.redd.it items in the live DB).
- [x] ~~**P2 — Maintain the feed scroll position after opening + closing the reader.**~~ ✅ Done 2026-06-20 (commit 29cb122): capture `window.scrollY` on openReader BEFORE the reader-lock (overflow:hidden resets it), restore it on closeReader after unlocking — covers every close path (button/Esc/popstate/swipe/F-A-D). *(User-requested
  2026-06-19.)* On mobile, opening the reader and returning loses your place in the list — the feed jumps back
  to the top instead of restoring where you were. Likely the `reader-lock` overflow toggle on `documentElement`
  (reader.js:195/207) resets the underlying scroll. Capture the feed `scrollTop` on `openReader` and restore it
  on `closeReader` (incl. the popstate/back path), or lock the body without discarding its scroll offset
  (position-fixed-with-saved-top pattern). Verify on the Pixel-6/Firefox target.

### Icebox — non-Chromium standalone install (GeckoView wrapper) *(Epic 16)*
- [ ] **P3 — ICEBOX: ship content-hoarder as a Gecko-rendered standalone Android app.** *(Researched +
  decision 2026-06-19.)* Goal: a real standalone app on the Pixel **without a Chromium engine** (user
  prefers Firefox/no-Chrome). **Findings:** Firefox Android can't make a true install (no WebAPK; "Add app
  to Home screen" = shortcut-class with the URL bar). WebAPK minting is Chromium+Google-Play-Services only,
  so every turnkey route (TWA/Bubblewrap, WebView wrappers like Hermit/Native Alpha) is Chromium. The only
  Gecko paths are: **(a)** a **custom GeckoView wrapper** — a ~50-line Java Android app bundling Mozilla's
  official GeckoView that loads the `.ts.net` URL full-screen (smallest trust surface = you + Mozilla; cost =
  *you* own quarterly engine-security rebuilds); **(b)** **Nira** (GeckoView browser w/ one-tap PWA install)
  — vetted **alpha / solo-dev / sideload-only / no community track record**, so NOT trusted for years of
  personal data; **(c)** a full **native Kotlin/Compose** rewrite — rejected (forks the web UI you actively
  maintain → permanent dual upkeep). A scaffold plan for (a) was drafted (Java, "minimal+", reuses
  `static/icon-512.png` + `#0f1115`/`#f2a97e` theme; GeckoView needs **no** assetlinks/Digital-Asset-Links).
  **Reactivation condition:** revisit as an **experimental separate branch or new repo** if the user tires of
  the current project / wants an Android side-project — NOT as in-place work here. **For now:** use the
  Chromium **WebAPK via Chrome "Install app"** (the only mainstream path; auto-updates its engine). See
  [[inline-reddit-reader]] (prior "Firefox is the culprit" note) and [[content-hoarder]].
- [ ] **P3 — Explore Cromite (or similar adblock Chromium fork) as the PWA host browser.** *(User idea
  2026-06-22.)* Chrome-for-Android can't run ad-blocking extensions, so the reader's "Open original ↗"
  + any embedded web/reddit content carries ads. **Cromite** (maintained Bromite successor — de-Googled
  Chromium fork with **built-in adblock** + anti-fingerprinting) can mint a real **WebAPK** (standalone PWA
  install, same as Chrome) AND block ads engine-side — getting BOTH the standalone-install goal and adblock
  WITHOUT a Chromium-engine extension or the GeckoView custom-wrapper maintenance burden. This likely
  **supersedes** the GeckoView icebox above (Cromite = the Chromium-adblock path; GeckoView = the
  no-Chromium path). Evaluate: (a) does Cromite's "Install app"/WebAPK flow work for our `.ts.net` PWA;
  (b) trust + maintenance (FOSS, active releases; sideload APK + auto-update via Obtainium/its own channel);
  (c) adblock efficacy on the reader's embedded reddit content. Alternatives to weigh: Brave (Chromium +
  adblock, Google-adjacent), Mull/Vanadium, or an in-app blocklist if we ever render remote pages ourselves.
- [ ] **P3 — Explore Chrome Custom Tabs (+ Trusted Web Activity).** *(User idea 2026-06-22.)* Chrome Custom
  Tabs (CCT) is Android's native "embed a real Chrome tab inside an app" surface — faster than a cold browser
  launch, themeable (match the app bar), shares the user's Chrome session/cookies, and has a back-arrow that
  returns to the app. Two angles for content-hoarder:
  - **(a) In-app link opening.** Today the reader's "Open original ↗" + external source links bounce out to
    the full browser and lose the app. If content-hoarder ever runs inside a native shell, those links could
    open in a Custom Tab — stay-in-app feel without us rendering remote pages ourselves. *(Pure-PWA caveat: a
    plain installed PWA can't invoke CCT directly — that's a native API; it needs a wrapper. So this is mostly
    relevant once (b) exists.)*
  - **(b) TWA packaging — the bigger reason.** A **Trusted Web Activity** is the official Google path to ship a
    PWA as a real installable/Play-Store Android app, and **a TWA is literally a full-screen, chrome-less Custom
    Tab** around your PWA. Tooling: **Bubblewrap** / **PWABuilder** generate the APK from the manifest. This is
    a **third native-packaging option** alongside the Cromite-WebAPK and GeckoView iceboxes above — TWA = the
    Google-blessed Chromium path (uses the user's installed Chrome/Cromite engine, so adblock only if that
    engine has it).
  - **Open questions:** does a TWA verify against our **Tailscale `.ts.net` origin** (TWA needs Digital Asset
    Links — host `/.well-known/assetlinks.json` on the Flask app + a signed APK; the cert SHA must match) when
    the origin is only reachable on the tailnet; offline behavior (TWA falls back to a Chrome error page, not
    our SW shell, if the origin is unreachable — vs a WebAPK which is friendlier); and whether CCT's lack of
    engine-adblock makes Cromite-WebAPK still preferable for the ad concern. Relates to the Cromite + GeckoView
    items above and `docs/MOBILE_TAILSCALE.md`. Refs: Android Custom Tabs, Bubblewrap, PWABuilder.
- [ ] **P3 — ICEBOX: watch the Web Haptics API (amplitude/intensity haptics for the PWA).** *(Researched
  2026-06-22.)* Our haptics are capped by `navigator.vibrate()` being **duration-only** — no amplitude knob
  (Android's `VibrationEffect` amplitude exists natively but is **not** bridged to the web), so "stronger"
  can only mean "longer," which is why tuning firmness is a tradeoff against crispness. **The fix in flight is
  the Web Haptics API** (WICG incubation + Microsoft-Edge explainer, with Chromium interest — a BlinkOn 21
  talk): semantic effects (`hint`/`edge`/`tick`/`align`) **with optional intensity `0.0–1.0`** = real
  amplitude, declarative (`@haptic` CSS) or imperative. **ICEBOXED because it's not shipped** (incubation, no
  browser support yet) — nothing to build now; **adopt once it lands in Chrome** (our PWA host) and replace the
  raw `vibrate(ms)` calls in `haptics.js`/`core/swipe.js` with intensity-aware effects. **The only way to get
  amplitude *before* it ships is a native shell** (TWA/Capacitor + a native haptics plugin, e.g. Capacitor
  `ImpactStyle.Light/Medium/Heavy`) — see the Chrome Custom Tabs / TWA item above; Web Haptics is the
  no-native-wrapper path to the same payoff. Refs: [WICG/web-haptics](https://github.com/WICG/web-haptics),
  [Edge explainer](https://microsoftedge.github.io/MSEdgeExplainers/Haptics/explainer.html).

### Icebox — remote-wake / always-on hosting *(Epic 16)*
- [ ] **P3 — ICEBOX: remotely "turn on" the server from the phone.** *(Researched 2026-06-20.)* Problem: the
  app is a **single Flask process + a SQLite file** (`content_hoarder serve`, `data/app.db`) on the home PC,
  reached from the Pixel over Tailscale (`docs/MOBILE_TAILSCALE.md`). When the PC is off/asleep the inbox is
  unreachable, so the user asked how to remotely command it on. **Two distinct layers:** **(B) host on, app not
  running** — the easy half: don't remote-start it, run `serve` as an **auto-restarting managed service**
  (Windows: NSSM / Task Scheduler "at startup"; Linux: a `systemd` unit with `Restart=always`); `tailscale serve
  --bg` already persists the HTTPS front across reboots, so the app is up whenever the host is. **(A) host
  powered off/asleep** — the hard half, with the key gotcha that **you can't wake a sleeping PC *through*
  Tailscale** (its tailscaled sleeps too → it drops off the tailnet; Wake-on-LAN is a layer-2 LAN broadcast,
  not routable over the WireGuard mesh). Every option therefore needs an **always-on device on the home LAN**:
  options ranked — (1) **move the app to an always-on low-power host** (Raspberry Pi / NAS / mini-PC) so there's
  nothing to wake — *recommended, collapses both layers*; (2) just keep the PC always-on; (3) **WoL via a LAN
  relay** — an always-on tailnet+LAN box (Pi/NAS/Tailscale-capable router) exposes an authed "wake" endpoint
  (`wakeonlan <MAC>`) the phone hits over Tailscale; needs BIOS WoL + NIC "wake on magic packet" + **Fast Startup
  disabled** on Windows, reliable from sleep/hibernate, flaky from full-off; (4) **local-control smart plug**
  (Tasmota/ESPHome) + BIOS "restore on AC power" — works from full-off but is a hard power-cycle. **Security
  (app holds years of personal data):** keep the wake trigger **tailnet-only + authenticated** (Tailscale ACLs;
  the magic packet itself is unauthenticated, so lock the thing that fires it), **never `tailscale funnel`** / no
  port-forward, and **local-only** (not cloud) smart plugs. **Reactivation condition:** revisit if the user
  wants the app off the big PC (host on a Pi/NAS — the recommended path) or specifically needs WoL because the
  content must live on the Windows box (browser-cookie/Takeout pipeline). For now the PC stays on / started
  manually. See [[content-hoarder]] and `docs/MOBILE_TAILSCALE.md`.
