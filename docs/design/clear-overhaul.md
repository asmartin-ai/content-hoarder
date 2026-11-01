# The "Clear" overhaul — plan and contract (2026-10-31)

Status: in progress on branch `feat/overhaul-clear`. This file is the single source of
truth for every agent working on the overhaul. Read all of it before editing.

## 1. Why

The app opened onto a wall: "930 fresh today", six status/nav systems (status tabs, rail,
dock with Inbox/Focus/Deck/Triage/Search/More, console with goal bar + dice + sync + version
badge + Triage button), a swipe legend, a sort pill. A tired ADHD user has to parse a cockpit
before the first decision (critique P1, `.impeccable/critique/…index-html.md`). 97.5% of the
real hoard (84k items) has never left the inbox — per-item review of the whole backlog will
never happen (research `PKMS/vault/resources/research/17-hoarder-mining.md` CH1, CH11).

What actually reduces the pile, and what feels good doing it:

1. **Short finite rounds** of one-card-at-a-time decisions, with momentum feedback and a
   loud "cleared" moment at the end, and "one more round" as the easiest next tap.
2. **Sweeps**: one tap lets a whole low-value pile rest (e.g. 3,951 r/NonCredibleDefense
   memes). Reversible, wave-stamped, honest about what it did. This is the biggest backlog
   reducer and the biggest dopamine hit.
3. **Wins-only counting**: today's clears and an all-time cleared total. Never show the
   remaining inbox size on the front door.
4. **Re-entry**: the front door says what happened last time and offers one next action.

Rules this follows (`adhd-design-language/DESIGN-LANGUAGE.md`): friction asymmetry (reduce
verbs cheapest, Keep deliberate, snooze in between), one next action, recognition over
recall, finite batches, cleared stamp as the one loud moment, honest ambient disclosure of
machine actions, every swipe has a tap twin, no guilt copy, no raw backlog counts on the
front door. Visual law: `adhd-design-language/VISUAL-LANGUAGE.md` (Today = lamp mode, the
round = focus mode, Library = bench mode). The user's explicit request overrides gate G-E
("look unchanged").

## 2. Information architecture: three rooms

| Room | Route | Page | Mode | Job |
|---|---|---|---|---|
| **Today** | `/` | `home.html` | lamp | One lit object: "Clear 10". Wins. Sweeps. Resurface whisper. Re-entry line. |
| **Clear** (a round) | `/clear` | `home.html` | focus | One card at a time, 5/10/25 per round, ends with the stamp. |
| **Library** | `/library` (alias `/browse`) | `index.html` | bench | Search, filters, list, reader. Retrieval only — no batch/deck/focus machinery. |

Redirects: `/triage` → `/clear`; `/?deck=1` → `/clear` (client side in home JS);
`/reddit` → `/library?source=reddit`.

Navigation is identical everywhere: **Today · Clear · Library**.
- Desktop (> 700px, the Library's existing phone breakpoint): a slim top bar (`.ch-nav`), brand mark left, three text tabs center/left,
  settings gear right (Library only keeps its own settings sheet).
- Mobile (≤ 700px): a bottom tab bar, three tabs, 56px tall + safe-area inset, labels under
  icons. In a running round the nav is hidden (focus mode); the round has its own top bar.

## 3. Backend contract (server, `src/web/`)

`templateResponse(name: "home" | "library")` serves `src/templates/home.html` or
`src/templates/index.html` with the same anti-framing headers.

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/` , `/clear` | — | `home.html` |
| GET | `/library`, `/browse` | — | `index.html` |
| GET | `/triage` | — | 302 → `/clear` |
| GET | `/pulse` | — | `{ new_today, cleared_today, swept_recent, swept_today, cleared_total }` |
| GET | `/sweeps` | `?limit=6` (1–12) | `{ sweeps: Sweep[] }` |
| POST | `/sweeps/apply` | `{ kind, source, subreddit?, before_utc? }` | `{ total, wave }` |
| POST | `/sweeps/undo` | `{ wave }` | `{ restored }` |

```ts
type Sweep = {
  id: string;            // stable, e.g. "subreddit:noncredibledefense" or "age:reddit:4y"
  kind: "subreddit" | "age";
  source: string;        // "reddit" for subreddit sweeps; any source for age sweeps
  subreddit?: string;    // kind=subreddit, as stored (case preserved from the most common row)
  before_utc?: number;   // kind=age: items whose content is older than this
  label: string;         // human, e.g. "r/NonCredibleDefense" or "Reddit saves from before 2022"
  count: number;         // inbox items that the sweep would rest (exact, same WHERE as apply)
  sample: string[];      // up to 3 sample titles
};
```

- Subreddit sweeps: inbox Reddit items grouped by subreddit, count ≥ 10, largest first,
  **excluding** knowledge subreddits listed in `RESURFACE_SUBREDDITS` (`src/categorize.ts`) —
  one machine fate per content class: those resurface, they are never offered as sweeps.
- Age sweeps: per source, inbox items with content older than 4 years (count ≥ 10).
- Mixed list ordered by count desc, cut to `limit`.
- Apply runs `db.decay({ source, subreddits?, beforeUtc?, label: "sweep", apply: true })`
  (wave-stamped, reversible, never enqueues Reddit unsaves). Undo runs
  `db.undecay({ decayedAfter: wave, decayedBefore: wave, apply: true })`.
- `pulse.swept_today` = items with `metadata.decayed_at >= local midnight`;
  `pulse.cleared_total` = items with `status != 'inbox'`.

Existing endpoints the client uses: `GET /random?mode=smart&n=N` (`{items}`),
`GET /items?q=…&status=inbox&limit=N` (`{items, has_more}`), `GET /items/:fullname`,
`POST /items/:fullname/status {status}`, `POST /items/:fullname/undo`,
`POST /items/:fullname/snooze {window_days:7}` (response may carry `snoozed_wave`, or
`decayed_at` when a repeat snooze escalated to rest), `POST /snooze/undo`,
`GET /resurface` (204 or card `{cluster,label,count,...}`), `POST /resurface/dismiss {cluster}`,
`POST /resurface/letgo {cluster}` → `{ wave… }`, `POST /resurface/letgo/undo {cluster, wave}`.
Client wrappers live in `src/static/core/api.js` — add new wrappers there.

## 4. Front-end files (new)

```
src/templates/home.html     shell for Today + Clear (one page, two views)
src/static/home/home.css    all styles for both views + nav; consumes core/tokens.css only
src/static/home/main.js     boot: route by location.pathname ("/" → today, "/clear" → round),
                            nav wiring, popstate, ?deck=1 → /clear, SW registration
src/static/home/today.js    Today view: export function mountToday(root, ctx)
src/static/home/round.js    Clear view:  export function mountRound(root, ctx)
src/static/home/card.js     pure helpers: costLabel(item), whyLine(item), cardHtml(item)
```

Reused modules (do not fork them): `core/api.js`, `core/util.js` (`esc`, `ago`,
`safeUrl`, `isTypingTarget`), `core/render.js` (`CH_SOURCES`, `srcAccent`, `itemUrl`),
`core/icons.js` (`chIcon`), `core/media.js` (`thumb`, `mediaType`), `core/swipe.js`
(`attachSwipe`), `core/toast.js` (`toast`, `snackbar`), `/static/haptics.js`
(`window.chHaptic(kind)`), `/static/theme.js`.

`ctx` passed to mount functions: `{ go(path, opts?) }` — client-side navigation between
`/` and `/clear?…` using `history.pushState` + re-mount (main.js owns it).

### 4.1 home.html DOM contract

```html
<body data-page="home">
  <nav class="ch-nav" aria-label="Main">
    <a class="ch-brand" href="/"><span class="ch-led"></span><span>content-hoarder</span></a>
    <div class="ch-tabs">
      <a class="ch-tab" data-tab="today" href="/">[icon]<span>Today</span></a>
      <a class="ch-tab" data-tab="clear" href="/clear">[icon]<span>Clear</span></a>
      <a class="ch-tab" data-tab="library" href="/library">[icon]<span>Library</span></a>
    </div>
    <button class="ch-iconbtn" id="theme-toggle" aria-label="Switch light/dark">…</button>
  </nav>
  <main id="view" class="view"></main>
  <div id="toast" hidden aria-live="polite"></div>
</body>
```
The current tab gets `aria-current="page"`. `body.is-round` hides `.ch-nav` (focus mode).
Icons are inline SVG (Tabler style, 1.75 stroke, `currentColor`).

### 4.2 Today view markup (rendered by today.js into `#view`)

```html
<section class="today">
  <header class="today-head">
    <p class="today-date">SAT 31 OCT</p>                <!-- mono, dim -->
    <p class="today-reentry">Last round 2h ago — 10 cleared.</p> <!-- optional -->
  </header>

  <div class="hero">                                    <!-- the lit object (lamp) -->
    <button class="hero-go" id="go">
      <span class="hero-verb">Clear 10</span>
      <span class="hero-sub">about 2 minutes · smart picks</span>
    </button>
    <div class="hero-sizes" role="radiogroup" aria-label="Round size">
      <button role="radio" aria-checked="false" data-n="5">5</button>
      <button role="radio" aria-checked="true"  data-n="10">10</button>
      <button role="radio" aria-checked="false" data-n="25">25</button>
    </div>
  </div>

  <section class="wins" aria-label="Wins">
    <div class="pebbles" aria-hidden="true"><i class="on"></i>…<i></i></div>
    <p class="wins-line"><b>12</b> cleared today · <b>2,107</b> all-time</p>
  </section>

  <section class="sweeps" aria-labelledby="sweeps-h">
    <h2 id="sweeps-h" class="sec-h">Let a pile go</h2>
    <p class="sec-sub">One tap rests the whole pile. Nothing is deleted; undo any time.</p>
    <ul class="sweep-list">
      <li class="sweep" data-id="…">
        <div class="sweep-main">
          <p class="sweep-label">r/NonCredibleDefense</p>
          <p class="sweep-sample">"The F-35 is actually a very large crayon" · …</p>
        </div>
        <span class="sweep-count">160</span>
        <button class="sweep-peek">Peek</button>          <!-- opens a round over that pile -->
        <button class="sweep-go">Let go</button>
      </li>
    </ul>
  </section>

  <aside class="whisper" hidden>                        <!-- resurface, moss -->
    <p class="whisper-q">Still curious about <b>r/ADHD</b>? 70 saved.</p>
    <div class="whisper-acts">
      <button class="whisper-peek">Peek 5</button>
      <button class="whisper-later">Not now</button>
      <button class="whisper-letgo">Let it go</button>
    </div>
  </aside>

  <footer class="today-foot">
    <a href="/library">Search the library</a>
  </footer>
</section>
```
States: sweep row while applying → `.sweep.is-going`; after → removed from the list with a
snackbar `"160 r/NonCredibleDefense saves rested."` + Undo. Empty sweep list → the section
is hidden. Pebbles: goal from `localStorage.chGoal` (default 8, 0 = no goal → pebbles hidden).

### 4.3 Clear (round) view markup (rendered by round.js into `#view`)

```html
<section class="round" data-state="playing|loading|empty|done">
  <header class="round-bar">
    <button class="round-x" aria-label="End round">×</button>
    <ol class="beads" aria-label="3 of 10 decided">
      <li class="bead is-done"></li>       <!-- classes: is-done | is-archived | is-keep |
                                                is-snoozed | is-skip ; current: is-current -->
      …
    </ol>
    <span class="round-clock">1:42</span>  <!-- mono -->
  </header>

  <div class="stage">
    <article class="card" data-fullname="…" style="--src: var(--source-reddit)">
      <div class="card-fg">
        <p class="card-src"><span class="card-glyph">r/</span> r/ADHD · 3y ago</p>
        <h1 class="card-title">Why starting is harder than finishing</h1>
        <p class="card-why">4.2k points · 312 comments</p>
        <span class="cost">3 min read</span>
        <img class="card-thumb" src="…" alt="" loading="eager">   <!-- optional -->
        <p class="card-excerpt">first ~280 chars of body…</p>       <!-- optional -->
      </div>
    </article>
    <p class="combo" aria-live="polite">on a roll · 6</p>          <!-- optional -->
  </div>

  <div class="pad" role="group" aria-label="Decide">
    <div class="pad-minor">
      <button class="act act-keep"   data-act="keep">Keep <kbd>K</kbd></button>
      <button class="act act-snooze" data-act="snooze">Not now <kbd>N</kbd></button>
      <button class="act act-skip"   data-act="skip">Skip <kbd>S</kbd></button>
      <button class="act act-open"   data-act="open">Open <kbd>↵</kbd></button>
    </div>
    <div class="pad-major">
      <button class="act act-done"    data-act="done"><span>Done</span> <kbd>D</kbd></button>
      <button class="act act-archive" data-act="archived"><span>Archive</span> <kbd>A</kbd></button>
    </div>
    <button class="undo" data-act="undo" disabled>Undo <kbd>Z</kbd></button>
  </div>

  <!-- data-state=done -->
  <div class="cleared">
    <p class="stamp">CLEARED</p>
    <p class="cleared-line">10 in 1:42 — 6 done · 3 archived · 1 kept</p>
    <div class="cleared-acts">
      <button class="primary" data-next="again">One more round</button>
      <button data-next="sweep">Let a pile go</button>        <!-- → Today, scrolled to sweeps -->
      <button data-next="enough">That's enough for today</button>
    </div>
  </div>
</section>
```
Leaving animation: the card gets `.leave-done | .leave-archived | .leave-keep |
.leave-snooze | .leave-skip` for ~200ms (fly left / right / up / down, tint with the status
colour), then the next card mounts with `.enter`. Reduced motion: no transforms, just swap.

Keyboard (ignored while typing): D/← done, A/→ archive, K/F keep, N not now, S/↓ skip,
Enter/O/↑ open, Z/U undo, Esc end round. Touch: swipe right = archive, left = done,
up = open, down = skip (`attachSwipe(card, {onRight,onLeft,onUp,onDown, mouse:false})`).
Keep and Not now are buttons only (deliberate friction).

Mobile layout: the pad is fixed to the bottom inside the thumb zone: `.pad-major` = two
equal 64px buttons side by side (Done left, Archive right — matching swipe directions);
`.pad-minor` = one row of 4 compact buttons above; `kbd` hidden on `(hover: none)`.
Desktop: card max-width 640px centred; pad under the card, same order.

## 5. Round engine behaviour (round.js)

- Query: `/clear?n=10` (default 10; allowed 5, 10, 25) → `GET /random?mode=smart&n=N`.
  `/clear?q=<search>&n=N` → `GET /items?q=<q>&status=inbox&limit=N+1` (peek a pile).
- State persists in `sessionStorage["ch.round"]`: `{ q, n, items, idx, results:[{fullname,
  act}], startedAt }`. Reload/return from the reader resumes the round; a resumed item whose
  status is no longer `inbox` (decided inside the reader) is recorded as that decision.
- Decisions call the API **optimistically**: animate + advance immediately, POST in the
  background; on failure, toast "That didn't stick — the card is back." and re-insert it.
- Undo: reverts the last decision (status → `POST /items/:fn/undo`; snooze →
  `POST /snooze/undo` with the wave from the snooze response) and steps back one card.
  Multiple undos walk back through the round.
- Skip does not call the API; it records `skip` and moves on (counts as decided for the
  round's progress but not as a win).
- Open: saves state, then `location.href = "/library?open=" + encodeURIComponent(fn) +
  "&from=clear&enter=up"`. The reader returns to `/clear` on close (Library contract below).
- Haptics: `chHaptic(status)` on every decision, `chHaptic("milestone")` on round clear.
- Combo: consecutive decisions under 6s each → show `.combo` "on a roll · N" from N ≥ 3.
  Purely in-round; resets silently; never persisted.
- End: when every card is decided → `data-state="done"`, stamp + summary. Write
  `localStorage["ch.lastRound"] = {at, cleared, ms}`. "One more round" starts a fresh
  round with the same n/q. "That's enough for today" → `/`.
- Empty fetch → `data-state="empty"`: "Nothing waiting here. That's a clear deck." + "Back
  to Today".

### Card helpers (card.js)
- `costLabel(item)`: YouTube `metadata.duration` (s) → "12 min video" / "45 s clip";
  text with body → words/230 → "N min read" (min 1); `mediaType` image/gallery → "a glance";
  video → "clip"; comment → "comment"; otherwise "link".
- `whyLine(item)`: provenance, max 3 parts, joined by " · ": subreddit (r/x) or channel or
  HN points; age `ago(created_utc)` + " ago"; reddit score/num_comments compact (4.2k).
- `cardHtml(item)`: the `<article class="card">` above, every string through `esc()`;
  `chIcon()` glyph output is trusted (never escape it).

## 6. Library cutover (index.html + browse/*)

The Library keeps search, operators, filters, rail, list/density, reader, lightbox, tag
editor, bulk select, settings sheet, import. It **loses** everything that was a second
triage system or diagnostic chrome:
- Deck mode (`browse/deck.js`, `#deck-host`, `?deck=1`, deck CSS, settings "Enter deck mode").
- Focus batches (`#batchstrip`, `#dock-focus`, settings "Infinite scroll / Focus batches",
  the PAGE CLEARED stamp `#stamp` and its CSS) — rounds own batches now.
- The console's Triage button, wins/goal bar, dice, version badge (move the version text into
  the settings sheet footer), the mobile swipe legend.
- The mobile dock collapses to the shared bottom tab bar (Today · Clear · Library) plus the
  Library's own search/settings entry points in its header.
The reader's `from=triage` return path becomes `from=clear` → `location.replace("/clear")`.

## 7. Phases

| Phase | Units (parallel) | Gate |
|---|---|---|
| 1 | Backend sweeps+routes+pulse+tests · home.html+home.css · round.js+card.js · today.js+main.js+api wrappers · Library cutover+SW | `bun run check`; browser smoke desktop 1440×900 + mobile 412×915, dark + light |
| 2 | Fix-ups from review/smoke | same |
| 3 | Docs: DESIGN.md, AGENTS.md triage section, CHANGELOG, NEXT.md, README routes | `bun run check` |
