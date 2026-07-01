## Epic 8 — Polish & infra  (`chore`)
- [x] ~~**`.gitattributes`**~~ Shipped (`* text=auto eol=lf` + binary excludes) — stops CRLF warnings.
- [x] ~~**P3 — Frontend-design agent skill.**~~ ✅ SHIPPED 2026-06-26: `.agents/skills/frontend-design/SKILL.md`
  captures design principles + content-hoarder's design system (typography, spacing, color, motion,
  accessibility) so AI agents produce consistent UI that respects the v3 tokens and avoids generic output.
  Distilled from the Codex-Frontend-Design-Toolkit. Referenced automatically by Zed agents when editing
  frontend files.
- [ ] **P3 — Optional Karakeep bridge** (already a stub) if a stock instance is adopted for a
  forward-capture library.

- [ ] **P2 — Redesign the app icon.** New mark: a backwards "E" forming an "H" (hoarder). Replace
  `static/icon.svg` + the 192/512 PNGs + the manifest; keep the teal-on-`#0f1115` tile.
- [ ] **P3 — 60fps UI.** Audit list/scroll/swipe for jank (avoid layout thrash, prefer transforms /
  `will-change`, throttle handlers); target smooth 60fps on the Pixel-6 target.
- [ ] **P3 — CSS platform feature audit.** Review the UI code for places where newer CSS can simplify
  bespoke layout/animation/theme logic, but only adopt features after checking browser support for the
  Pixel-6/PWA target and adding regressions where behavior changes. Candidates:
  - `align-content` for block-axis centering without forcing flex/grid wrappers.
  - `@property` typed custom properties for safer/smoother animated CSS variables.
  - `@starting-style` for first-render transitions on popovers/dialogs currently hidden with `display:none`.
  - CSS math functions (`round()`, `rem()`, `mod()`) where JS or duplicated calc logic can be removed.
  - `light-dark()` for adjacent light/dark token definitions where it does not fight explicit app themes.
  - `:user-valid` / `:user-invalid` for form validation states that should wait until user interaction.
  - `interpolate-size` for intrinsic-size dropdown/tag/filter transitions that currently need max-height hacks.
- [x] ~~**P3 — README mobile quickstart.**~~ Shipped (overnight 2026-06-10): step-by-step
  Tailscale quickstart in README "Mobile access"; CLI table updated with decay / delete /
  export / learn-triage.
- [x] ~~**P2 — Predictive prefetch cache for the top of each sort.**~~ ✅ SHIPPED 2026-06-26 (`prefetch.js` +
  `test_browse_prefetch.py`). ServiceWorker-cached browse-page responses, per-source × per-sort warm, TTL-based
  invalidation. The cache lives in-memory in the SW (not a server warm), prefetches the top ~10 items for
  each source/sort combo on idle, and invalidates on new sync/decay events. *(User-requested 2026-06-17.)*
- [x] ~~**P2 — More aggressive preload of content + comments (smoother UX).**~~ ✅ SHIPPED 2026-06-22 (browser-verified): on reader-open, `preloadNext()` (`browse/main.js`) warms the **next reddit item's comment thread** (background GET `/reddit/items/<fn>/thread` lazily hydrates server-side → next open is instant) + primes its media image. Bounded + rate-safe: ONE thread fetch per open, de-duped (`_preloaded`), abortable (`AbortController`), reddit-only, small look-ahead. **Deferred:** broader feed-scroll warming (held back for reddit rate limits — revisit if the reader still feels laggy). *(User-requested 2026-06-20.)* Orig: Keep
  lazy-loading, but warm a bit ahead: pre-fetch images/media just below the fold and **pre-hydrate the reddit
  thread (post + comments)** for the item(s) most likely to be opened next, so the reader feels instant. Bound it
  (small look-ahead, cancel on fast scroll) to avoid wasted fetches / throttle hits. Extends the "Predictive
  prefetch cache" item above; touches the reader hydrate path (`browse/reader.js` `load()` + `/reddit/items/<fn>/thread`)
  and the feed media lazy-load.
- [ ] **P2 — Data-saving mode + mobile performance pass.** *(Mobile test 2026-06-29.)* Loading media,
  comment threads, and new feed pages still feels slow on mobile. Add a settings toggle for **Data Saver**
  / **Performance mode** that can dial down expensive work: prefer thumbnails/`gallery_preview` over
  full-res until tap/zoom, reduce or disable automatic next-thread prefetch, limit offscreen media warmup,
  shrink browse page size on slow connections, and optionally skip remote embeds until user taps. Pair with
  instrumentation (network count/bytes, time-to-reader, time-to-first-media) so we can compare before/after.
  Keep normal mode unchanged; this is for mobile data / slow tailnet sessions.
- [ ] **P3 — Trial GLM-5.2 as a design bakeoff arm (gated by the frontend-design skill + visual review).**
  *(User idea 2026-06-19.)* GLM already wins several of our *code* bakeoff arms (5.1/5p2); the research says
  **design is GLM-5.2's standout strength** — #1 on **Design Arena** (Elo ~1360, blind human-preference design
  tasks, ahead of Claude Fable 5 / GPT-5.5), #2 on **Code Arena: Frontend** (+29 over Claude Opus 4.7
  Thinking), and **94.8 vs 77.3** (Claude Opus 4.6) on **Design2Code** for the GLM-5V vision variant — and it's
  open-weights + multimodal (screenshot→code). **Trial scope:** hand it (a) a *greenfield/exploratory* design
  task (where it's strongest) and (b) a "build this from a screenshot/Figma" task (Design2Code), **both
  constrained by the `frontend-design` skill** so it respects the v3 tokens/design language, and **run through
  the normal human design-approval gate** (design can't be oracle-tested like code — visual review IS the
  oracle). **Caveats to watch:** benchmark wins are *greenfield aesthetics*, NOT adherence to our locked design
  system — the within-an-existing-system polish tasks (Epic 13 P3 CSS) are the harder taste-consistency test
  before trusting it broadly; and 5.2 launched with thin official benchmark tables, so trust our own bakeoff
  results over the marketing. Good first real targets: the screenshot-driven items (Epic 15 inline-media,
  the mobile-nav redesign). Relates to Epic 23 (design-language) + the `frontend-design` skill.
### 2026-06-30 PWA shell hardening

Service worker cache `ch-shell-v104` includes the `/reddit` navigation shell, legacy triage
`/static/tokens.css`, reddit assets, and `vendor/hls.min.js` for archived/v.redd.it playback paths.
Same-origin page fallback now uses `request.mode === "navigate"` while POST and data/API requests stay
network-only.
