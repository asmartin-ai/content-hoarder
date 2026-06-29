# Epic 16 scroll deceleration

## Goal

Make rapid upward scrolling in the v3 browse list feel native and predictable on the mobile PWA target, especially on Pixel 6 / Chrome Android, without adding dependencies or replacing browser-native scrolling.

**Done when:** a fast scroll/fling toward the top of the browse feed and the floating ↑ affordance both settle cleanly at the top, with no visible overshoot, abrupt stop, top-bar flicker, background scroll leak, or reduced-motion violation.

**Size estimate:** medium. The code change is probably small, but the hard part is isolating the cause on a real mobile/PWA scroll path and adding non-flaky regression coverage.

## Implementation status (2026-06-29)

- Branch `epic-16-scroll-deceleration` implemented the conservative browser-native scroll stabilization slice and added/updated Pixel-6/PWA Playwright regression coverage.
- Validation covered the local headless UI suite, not a physical Pixel 6 / Chrome Android device. Treat real-device tactile feel as the remaining acceptance check.

## Confirmed current state

- **The open backlog item is specifically browse-list mobile physics.** `BACKLOG.md:1053-1057` says: rapid fling-scrolling to the top of the browse list has weird deceleration physics, possibly from `scrollTo({behavior:"smooth"})`, native fling + infinite-scroll interaction, the `.console.compact` scroll handler, or CSS `scroll-behavior` / `overscroll-behavior`.
- **The v3 browse page scrolls the document/window, not a dedicated `#items` scroller.** `templates/index.html:183-243` wraps `#items` inside the normal page flow; the infinite-scroll sentinel follows the list at `templates/index.html:242-243`. `browse.css:18-24` sets body background and `overflow-x: clip`, but there is no dedicated vertical overflow on `.desk`, `.sheet`, or `.items`.
- **The list is re-rendered wholesale on load/append.** `browse/main.js:186-231` fetches pages of 50 items outside Focus mode, appends to `state.items`, then `render()` replaces `itemsEl.innerHTML` at `browse/main.js:234-246`. Infinite scroll is an `IntersectionObserver` on `#sentinel` with `rootMargin: "600px"` at `browse/main.js:915-927`.
- **The floating scroll-to-top button is mobile-only CSS, but the JS handler is global.** CSS: `.gotop` is hidden by default and displayed under `@media (max-width: 700px)` at `browse.css:2237-2278`. JS: it appears after `window.scrollY > 700` via a passive scroll listener at `browse/main.js:929-947`, and on click calls `window.scrollTo({ top: 0, behavior: "smooth" })` at `browse/main.js:948-950`.
- **Reduced-motion currently disables transitions/animations, not JS smooth scrolling.** `core/tokens.css:135-138` globally disables CSS transitions and animations under `prefers-reduced-motion: reduce`; it does not affect `window.scrollTo({ behavior: "smooth" })`.
- **The collapsing top bar mutates layout during scroll.** `browse/main.js:1875-1909` toggles `.console.compact` from a `window` scroll listener. The code comment confirms the sticky header height change causes scroll anchoring nudges; it uses a wide dead zone (`>110` collapse, `<28` expand) and a 320ms lock to prevent flicker. Mobile CSS then collapses parts of `.console.compact` at `browse.css:3048-3065`.
- **Existing tests cover adjacent failures, not this exact one.** `tests/ui/test_smoke.py:91-119` verifies top-bar collapse/expand and no class-mutation flicker near top. `tests/ui/test_mobile_ux.py:615-639` verifies lightbox swipe-close does not move feed scroll; `tests/ui/test_mobile_ux.py:656-724` verifies navdrawer scroll lock and restoration. No test currently targets the ↑ button’s smooth-scroll path or a fast upward scroll/deceleration sequence.
- **Mobile/PWA UI tests are available and deterministic.** `tests/ui/conftest.py:29-54` defines Pixel 6 + standalone-PWA emulation, and `tests/ui/conftest.py:65-207` seeds a synthetic DB with 30 `ui_scroll_*` rows, so scroll tests can run without touching live data.
- **Existing scroll containment is partial.** Browse panels/sheets use `overscroll-behavior: contain` (`browse.css:2325-2355`), and the reader internal scroller uses `overscroll-behavior: contain` plus `-webkit-overflow-scrolling: touch` (`browse.css:3376-3383`). The v3 browse root itself does not currently set root `overscroll-behavior-y`; legacy `app.css:20-28` does set `body { overscroll-behavior: contain; }` for legacy pages.
- **Side-gutter wheel forwarding exists.** `browse/main.js:2667-2676` forwards `wheel` events targeted at `body`/`documentElement` to `window.scrollBy({ top: e.deltaY })`. This is desktop/gutter-oriented and should not affect touch flings directly, but it is another document-scroll hook.
- **Platform facts checked from MDN:**
  - `scroll-behavior: smooth` and JS smooth scroll use a user-agent-defined easing/duration; user agents may ignore it, and it does not affect direct user scroll gestures.
  - `overscroll-behavior` controls boundary behavior / scroll chaining; `contain` prevents chaining and pull-to-refresh-style behaviors for the relevant scroll container, but MDN marks the shorthand as not Baseline across all major browsers.
  - `scrollend` is newly Baseline as of late 2025, but older browsers may lack it; any use should be feature-detected with a timeout fallback.
  - `scroll` events can fire at high rate; expensive DOM work in scroll handlers should be throttled or avoided.

## Problem framing / assumptions

**Confirmed problem statement:** A user reported that rapidly scrolling/flinging to the top of the browse list feels wrong: it can overshoot or stop abruptly. The reported surface is the v3 browse list, not the reader, lightbox, triage deck, or `/reddit` view.

**Inferred likely causes to test, not assume:**

1. **Top-bar layout mutation during native momentum.** The `.console.compact` handler intentionally changes sticky-header height near the top. During a high-velocity upward fling, expanding the header can change layout while browser momentum/scroll anchoring is still resolving.
2. **Programmatic smooth-scroll competing with user momentum.** The ↑ button calls `scrollTo({ behavior: "smooth" })`. If tapped while a native fling is active, the browser may blend/cancel momentum in a platform-specific way. Smooth scroll also ignores the app’s reduced-motion token policy.
3. **Root overscroll / pull-to-refresh boundary behavior.** Browse root lacks `overscroll-behavior-y`; on Chrome Android, hitting the top boundary can trigger browser/PWA boundary physics. In a local PWA this is probably undesirable, but it must be verified because browser support and behavior differ.
4. **Scroll handler work during fast movement.** Current handlers are mostly light, but `syncGotop()` still runs through `requestAnimationFrame`, while the top-bar handler mutates classes and uses timeouts. MDN notes rAF is not true scroll throttling because scroll events and animation frames fire at similar rates.
5. **Infinite-scroll append is less likely for the “to top” symptom.** The sentinel is at the bottom, so a top-boundary issue should not normally trigger `loadItems(false)`. Still verify because a fling that starts near the bottom could append just before reversing, and `render()` replaces all rows.

**Scope assumption:** Start with the v3 browse route (`/`) because that is where the backlog item points and where the affected handlers live. Do not change legacy `/triage` or `/reddit` scroll behavior unless a reproduction proves the same problem exists there.

## Proposed UX and interaction model

- Preserve native browser touch scrolling for the feed. Do **not** implement custom inertial physics, intercept ordinary touchmove/wheel events, or add a scroll library.
- Treat the ↑ button as an affordance to “return to top,” not a simulated fling. It should be:
  - predictable: ends at `scrollY === 0` / top expanded state;
  - interruptible by user input where the browser supports interruption;
  - reduced-motion aware: no smooth programmatic animation when `prefers-reduced-motion: reduce` matches;
  - not allowed to fight a currently active native fling.
- Let the top bar feel like part of the chrome, not part of the scroll physics. During active high-velocity scrolling, avoid changing page height in the critical top-boundary region; expand/collapse after scroll settles or use a fixed-height/transform-only treatment if needed.
- Keep existing mobile gesture constraints:
  - row swipes remain `touch-action: pan-y` and edge-deadzone safe;
  - overlays/sheets continue to lock background scroll;
  - lightbox pan/zoom and reader internal scroll remain independent.
- Avoid `scroll-snap` for the feed. It would impose snap points on a heterogeneous, long list and is likely to make “overshoot/abrupt stop” worse. Reserve snap only for small horizontal controls if ever needed.
- Root overscroll containment is acceptable if verified on Chrome Android PWA because the app should not pull-to-refresh or browser-navigate at the top of a personal local feed.

## Technical approach

Use a **native-first, measure-first** approach:

1. **Instrument before changing behavior.** Temporarily measure scroll sequences in a local/dev branch or browser console:
   - `scrollY` samples over time while fast-scrolling upward;
   - `.console` class mutations and timestamp;
   - `loadItems(false)` calls during the sequence;
   - ↑ click timing vs active scrolling;
   - `visualViewport` / viewport dimensions if available.
   This instrumentation should not ship unless behind a clearly disabled debug flag.

2. **Fix the least invasive confirmed cause first.** Candidate fixes, in preferred order:
   - **Reduced-motion-aware top action:** route the ↑ click through a helper that uses `behavior: "auto"` when `prefers-reduced-motion: reduce` matches. If the weirdness is only the smooth-scroll path, consider replacing mobile ↑ with instant jump or a very short native smooth scroll only when not already scrolling.
   - **Scroll-settle gate for top-bar expansion:** keep the existing top-bar thresholds, but do not expand the header while a high-velocity upward scroll is still active unless `scrollY` is effectively zero. Use `scrollend` when available, with a short debounce fallback, to run the final `onScroll()` check. This directly targets the known layout/scroll-anchoring interaction documented in `main.js`.
   - **Root overscroll containment:** add `overscroll-behavior-y: contain` or `none` to the browse root (`html`/`body`) if real-device repro shows top-boundary/pull-to-refresh behavior. Prefer axis-specific `overscroll-behavior-y` to avoid accidental horizontal navigation changes. Confirm Chrome Android behavior; do not rely on it as the only fix because MDN marks the shorthand as not universally Baseline.
   - **Defer append renders during active momentum only if proven necessary.** If instrumentation shows infinite-scroll append/re-render is happening during the problematic sequence, add a small “append after scroll idle” gate around `loadItems(false)` render. This is a bigger behavioral change and should not be first.

3. **Avoid these approaches unless evidence forces them:**
   - custom touch physics for the main feed;
   - non-passive global touch listeners;
   - global `scroll-behavior: smooth` on `html`;
   - `scroll-snap` on rows;
   - replacing the document scroller with a nested `#items` scroller in this epic. That would touch overlay positioning, sticky chrome, scroll restoration, accessibility, and many tests.

4. **CSS/design-system constraints:**
   - use existing motion tokens (`--dur-*`, `--ease`) for any visible chrome transition;
   - add reduced-motion guards for any new transitions not covered by `core/tokens.css`;
   - avoid new hardcoded colors or dimensions unless they are platform thresholds and documented;
   - keep hit targets ≥44px and focus rings intact for `#gotop`.

## Implementation plan

1. **Reproduce and classify the symptom.**
   - On a Pixel 6 / Chrome Android PWA if available, test three separate paths:
     1. manual fast upward fling to top;
     2. tap ↑ while idle and scrolled deep;
     3. tap ↑ during/just after native momentum.
   - Record which path fails and whether `.console.compact` changes at the same moment.
   - Done when the bug is classified as one or more of: top-bar layout mutation, ↑ smooth-scroll path, root overscroll boundary, infinite-scroll append/render, or other.

2. **Add a focused scroll diagnostics helper for local testing only.**
   - Use browser console or a temporary dev-only snippet, not committed production logging unless explicitly requested.
   - Capture `scrollY`, timestamps, `console.className`, and optional load-more counters.
   - Done when a single run shows whether scroll position changes are monotonic and whether class mutations align with the “bad” deceleration.

3. **Patch the scroll-to-top helper if implicated.**
   - Replace the direct `window.scrollTo({ top: 0, behavior: "smooth" })` call with a named helper.
   - Respect `prefers-reduced-motion: reduce` by using `behavior: "auto"`.
   - Consider using instant jump for mobile if native smooth scroll is the confirmed bad path; otherwise keep native smooth for non-reduced-motion users.
   - Ensure the helper finishes in an expanded top-bar state.
   - Done when ↑ settles at the top consistently and reduced-motion users do not get smooth programmatic scrolling.

4. **Patch top-bar scroll coordination if implicated.**
   - Keep the existing dead zone and 320ms transition lock unless evidence says they are wrong.
   - Add an “active scroll” / “settle” concept around expansion near the top:
     - collapse may still happen once sufficiently down;
     - expansion should run only when `scrollY < 28` and scrolling is idle, or immediately when `scrollY <= 1`;
     - feature-detect `scrollend`; fallback to a short timeout/debounce after the last scroll event.
   - If this still changes page height at a bad time, consider a larger follow-up: make compact/expanded top-bar occupy a stable reserved height and animate internals via opacity/transform only. That overlaps the separate “visual rework of the collapsing top bar” backlog item, so keep it as a follow-up unless required.
   - Done when fast upward scrolling does not cause bounded/unbounded `.console` flicker and does not visibly “brake” near the top.

5. **Add root overscroll containment only if verified useful.**
   - Candidate CSS: axis-specific containment on browse root (`html`, `body`) rather than every nested scroller.
   - Verify it does not break Android back gesture, row swipe edge deadzone, overlay scroll chaining, or desktop wheel behavior.
   - Done when top-boundary pull/overscroll behavior is controlled in Chrome Android PWA and existing overlay scroll-lock tests still pass.

6. **Validate no infinite-scroll regression.**
   - Confirm upward scroll to top does not trigger `loadItems(false)`.
   - Confirm downward infinite scroll still loads more rows and does not get starved by any new scroll-idle gating.
   - Done when existing infinite scroll behavior is unchanged outside the problematic top-boundary case.

## Tests and validation

Add or adjust Playwright tests under `tests/ui/` after reproducing the cause. Suggested coverage:

1. **Scroll-to-top button behavior on Pixel 6.**
   - Use `pixel6_page`, scroll deep enough for `#gotop.show`, click `#gotop`, wait for `scrollY` to settle, assert:
     - `Math.round(window.scrollY) === 0`;
     - `.console` is not `.compact` after settle;
     - `.gotop` hides;
     - class mutation count is bounded.

2. **Reduced-motion behavior.**
   - In a Pixel 6 context with `prefers-reduced-motion: reduce`, click `#gotop` and assert the jump completes without a long smooth animation. Exact timing can be flaky, so prefer asserting immediate/near-immediate top after one frame rather than sampling a full animation curve.

3. **Fast upward scroll/top-bar stability.**
   - Start scrolled down, attach a `MutationObserver` to `.console`, perform a large upward wheel sequence or `window.scrollTo(0, 0)` equivalent, wait for scroll settle, assert bounded mutations and expanded final state. This extends the existing no-flicker test in `tests/ui/test_smoke.py:104-119`.
   - Note: Playwright cannot faithfully emulate Android inertial touch flings; this test guards the app’s deterministic class/scroll side effects, not the physical fling itself.

4. **Infinite scroll still works.**
   - Existing coverage may be enough, but if scroll handler changes are broad, add a test that scrolls near the bottom until `#sentinel` intersects and verifies the row count increases outside Focus mode.

5. **Overlay scroll locks remain intact.**
   - Re-run `tests/ui/test_mobile_ux.py` because it already covers lightbox feed-scroll preservation and sidebar scroll containment.

6. **Manual real-device validation is required.**
   - Headless Chromium cannot fully reproduce touch inertia or Chrome Android PWA boundary physics.
   - Manual checklist on Pixel 6 / Chrome installed PWA:
     - fast upward fling from mid-list;
     - fast upward fling from near bottom after infinite-scroll append;
     - tap ↑ while idle;
     - tap ↑ during active motion;
     - open/close navdrawer and lightbox after scrolling;
     - reduced-motion enabled at OS/browser level if available.

Recommended command set once implemented:

```sh
python -m pytest tests/ui/test_smoke.py tests/ui/test_mobile_ux.py -m ui
```

If Playwright’s bundled Chromium is unavailable locally, project docs allow:

```sh
python -m pytest tests/ui/test_smoke.py tests/ui/test_mobile_ux.py -m ui --browser-channel chrome
```

## Risks / open questions

- **Main unknown:** whether the bad feel is from manual fling physics or the ↑ smooth-scroll button. The backlog mentions both rapid fling and `scrollTo({behavior:"smooth"})`; reproduce before choosing the fix.
- **Headless test fidelity is limited.** Pixel 6 Playwright emulation is valuable for geometry and handlers, but not a complete model of Android touch inertia, PWA pull-to-refresh, or compositor behavior.
- **`overscroll-behavior` support differs by browser.** Chrome Android should be the target, but the property is not universally Baseline. Use progressive enhancement and do not depend on it for core correctness.
- **Top-bar fixes may overlap with a separate visual-polish backlog item.** Keep this epic focused on physics/stability. If stable-height top chrome is required, split visual redesign into a follow-up.
- **Scroll restoration code is nearby and sensitive.** Reader/lightbox/panel code uses `window.scrollTo()` and saved positions. Do not normalize all scroll calls globally without checking those paths.
- **Changing document vs nested scrolling would be high risk.** It would affect sticky header, bottom dock, overlays, scroll restoration, side-gutter wheel forwarding, and tests. Avoid for this epic.
- **User preference question:** should the ↑ button animate at all on mobile? If real-device testing shows native smooth scroll always feels worse than an instant “jump home,” ask before changing the interaction permanently.

## Suggested delegation slices

1. **Slice A — Repro + evidence capture (small).**
   - Produce a short note or test log classifying the symptom path.
   - Confirm whether `.console.compact`, `#gotop`, root overscroll, or infinite append is involved.
   - No production code change.

2. **Slice B — Scroll-to-top helper + reduced motion (small).**
   - Replace the direct ↑ `scrollTo` call with a reduced-motion-aware helper.
   - Add focused Playwright coverage for `#gotop` final state.

3. **Slice C — Top-bar settle coordination (medium).**
   - Gate top-bar expansion during active scroll using `scrollend` with debounce fallback.
   - Preserve existing thresholds and tests unless evidence says otherwise.
   - Extend no-flicker/top-settle tests.

4. **Slice D — Root overscroll containment validation (small/medium).**
   - Test `overscroll-behavior-y` on browse root in Chrome Android PWA.
   - If useful, add minimal CSS and regression assertions; if not useful, document why it was rejected.

5. **Slice E — Infinite-scroll/render audit (small, conditional).**
   - Only if instrumentation shows append/re-render during the failing sequence.
   - Add a regression that downward infinite scroll still appends while upward top scroll remains stable.
