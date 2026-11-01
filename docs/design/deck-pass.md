# Deck pass — a visual identity for Today and Clear (2026-11-01)

Iteration 3 on top of `clear-v2.md` (read that first; its routes, partials, island contract and
copy rules all stand). This pass changes how the two rooms look and feel, not what they do. Branch
`feat/overhaul-clear`.

## 1. Critique of v2 (the brief: "beautiful and less generic")

Compared against apps people return to every day (Tinder, Duolingo, photo-cleanup swipers like
Slidebox, Superhuman's inbox zero, Apple Fitness rings, Google Photos memories, Spotify/Apple Music):

| v2 | What engaged apps do | Fix in this pass |
|---|---|---|
| Card is a hairline panel floating in a dark void; on desktop ~85% of the screen is empty, on phones a short text card sits mid-screen | The content *is* the screen (Tinder, TikTok); every card is the same physical object | The card fills the stage at a fixed size; media cards give the picture all the space the words don't need |
| Images capped at a third of the screen, cropped from the top | Photos whole and big; letterbox filled with a blur of the photo (Instagram stories, Apple Music) | Picture `contain`ed over a blurred, darkened copy of itself |
| Text posts (most saves) are grey boxes with a title | Text gets its own poster treatment (Threads/Instagram quote cards) | Typeset poster: Bricolage title sized by length, the community's paper with a soft glow |
| Every card is the same charcoal panel; nothing tells cards apart | Colour per album/artist (Spotify, Apple Music) | Community paper: a stable low-chroma hue per subreddit/channel |
| Lexend everywhere + mono uppercase eyebrows ("UP NEXT") — the default 2024 dev-tool look | A face with personality at display sizes | Bricolage Grotesque (Hearth gate G-B) for the day title, card titles, numbers, stamp; sentence-case section heads |
| Decisions are labelled rectangles and a row of text links with kbd chips | Round orbs, the big ones are the main verbs (Tinder) | Five orbs: Skip · **Done** · Keep · **Archive** · Not now |
| Dragging slides a flat card over a pill underlay | Card tilts with the thumb; LIKE/NOPE stamp fades in with distance; the matching button lights | Tilt (`swipe.js` `tilt`), stamp + tint driven by `--pull`, matching orb lights; button decisions fly the card off with the same stamp |
| A ticking clock in the top bar | Calm progress; speed shown afterwards | Clock removed; time spent appears on the cleared screen |
| CLEARED stamp in mono over a one-line summary | End-of-lesson payoff with counted-up numbers (Duolingo); a picture of what you did (Wordle grid); tangible "space freed" (photo cleaners) | Receipt grid of the round's cards ringed by decision colour; counted-up cleared · minutes freed · time spent |
| Today's hero is a flat apricot slab; Up next is a thumbnail strip under it | The thing you are about to play, shown as an object (a hand of cards) | The next round as a fanned hand of its actual cards, over the ember button; tap the hand to play |
| Pebbles are eight tiny dots | Rings you close (Apple Fitness) — glanceable | Pebble ring: one arc per pebble, today's count in the middle |
| Piles are settings-style rows | Memory tiles: pictures first, name over them (Google Photos) | Memory tiles, sideways scroll on phones, three across on desktop |
| Dead gallery posts render as a title-only card; Reddit's `&#x200B;` prints as text | — | "A gallery — tap to open it" placeholder; the entity is stripped |

Kept on purpose: wins-only counting, finite rounds, no streaks, the fixed triad colours, one ember
per surface, reduced motion honoured (tokens.css zeroes durations).

## 2. Contract changes

### Card (`web/views/card.ts`)

```html
<article class="card" data-fullname data-source data-kind
         data-layout="media|text" data-len="s|m|l" data-cost="2.40" data-thumb="…"
         style="--src: var(--source-reddit); --hue: 212">
  <div class="card-fg item-fg">
    <figure class="card-media" data-media="image|gallery|video|youtube|link" [data-open]>
      <img class="media-bg" aria-hidden="true"><img class="media-img" [data-fallback]>
      <span class="media-badge">…</span>
    </figure>                      <!-- or figure.card-media.is-missing (icon + caption, data-open) -->
    <div class="card-info">
      <header class="card-head">glyph · where · age · <button class="card-open" data-act="open"></header>
      context · title · note · body · Show more · reply · stats
    </div>
  </div>
</article>
```

- `data-len`: title length (≤50 s, ≤110 m) — for comments, body length (≤160 s, ≤420 m).
- `--hue`: `hueOf(communityOf(item))` (FNV-1a of the lower-cased subreddit/channel/source).
- `data-cost`: `costMinutes(item)` — the receipt's "freed" sums it over Done + Archive.
- `data-thumb`: `thumbFor(item)` for the receipt (omitted for NSFW).

### Round frame (`web/handlers/clear.ts`)

Top bar: `.round-x` · `.beads` · `.undo`. Pad: five `.act` buttons (`.act-orb` + `.act-label`,
`.is-major` on Done/Archive). Cleared: `.stamp`, `.receipt`, `.cleared-stats` (`.cs-n`,
`.cs-freed` in `.cs-freed-box`, `.cs-time`), `.cleared-line`, `.cleared-today`, `.cleared-acts`.

### Today (`web/views/today.ts`)

`.today-head` gains `h1.today-title` (`dayTitle`). `#upnext` holds `a.deck > ol.deck-fan >
li.deck-card` (`--slot`, `--far`, `--hue`; title always present so a dead thumbnail falls back to
it) and `.upnext-mix`; the hero button follows. `#wins` renders `.wins-dial` (ring from
`static/core/ring.js`, shared with the cleared screen) + `.wins-text`. Piles are `li.pile` memory
tiles (`.pile-mosaic`, `.pile-main` over it, `.pile-acts`).

### Styles

`home/home.css` (base, toast, community paper) + one room sheet: `home/today.css` or
`home/clear.css` (`renderPage` links the right one). Bricolage is vendored at
`static/fonts/BricolageGrotesque-var.woff2`; `--font-display` in `core/tokens.css`. SW cache
`ch-shell-v143`.

## 3. Open

- Clips still open in the Library reader rather than playing inline.
- Some old saves carry slug-derived titles cut mid-sentence; that is data, not layout.
- Real-device pass on the OnePlus 15 PWA (drag feel, haptics, safe areas).
