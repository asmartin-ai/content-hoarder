# Clear v2 — rich cards, server-rendered rooms, htmx (2026-10-31)

Iteration 2 of `clear-overhaul.md` (read that first; everything there stands unless replaced here).
Branch `feat/overhaul-clear`.

## 1. What v1 got wrong

The user's verdict on v1: "a little too minimal — the Reddit cards don't have enough info." The v1
card showed a source chip, a title, one meta line and a cost pill. A saved Reddit item carries far
more decision signal than that: an image or gallery (26k thumbnails, 16k locally archived copies),
the post body, the saved comment itself, score, comments, subreddit, author, sometimes a cached
thread with its top comment. Hiding it forces the user to Open → read → come back, which is the
slow path the round exists to avoid.

## 2. Principle: information scent, then one tap

Borrowed from apps people can't put down, mapped to this job:

| App | Mechanic | Here |
|---|---|---|
| Reddit / Apollo | The feed card *is* the decision: sub, author, image, title, score, comments | Rich card per source (§4) |
| Tinder / Slidebox (photo-cleanup apps) | Full-bleed media card, swipe to decide, the next card peeks from behind | Media hero + stack peek |
| Instagram Stories | Segmented progress at the top, tap-through | Beads (kept) |
| Netflix | "Up next" preview row pulls you into the next session | Today's **Up next** filmstrip — the actual cards of the next round |
| Google Photos "memories" | Thumbnail mosaics make a pile feel like a thing | Pile tiles with a 3-thumb mosaic |
| Duolingo | Session ends on a reward screen, daily goal fills | CLEARED stamp + today's pebbles (kept) |
| Gmail / Superhuman | Undo snackbar; keys shown on buttons | Kept |

ADHD rules still win: wins-only counts, no streaks, no remaining-inbox totals, knowledge never swept.

## 3. Architecture: server-rendered rooms + htmx + one island

Per life-os ADR 0033 / issue #3: server-rendered HTML + htmx for data surfaces, a script island for
gestures. Today and Clear move to that model now; the Library list keeps its vanilla JS for now.

```
src/web/views/html.ts     html`` tagged template (auto-escapes interpolations), raw(), joinHtml()
src/web/views/icons.ts    inline SVG strings (Tabler style, stroke=currentColor, 1.75)
src/web/views/media.ts    cardMedia(item), thumbFor(item), costLabel(item), compact(n), domainOf(url)
src/web/views/thread.ts   topComment(db, item): TopComment | null   (reddit_threads cache only)
src/web/views/card.ts     renderCard(item, { topComment }): string  — §4
src/web/views/page.ts     renderPage({ title, tab, body, round? }): string — <head>, nav, #toast
src/web/views/today.ts    renderToday(...), renderUpNext(...), renderWins(...), renderPiles(...), renderWhisper(...)
src/web/handlers/today.ts GET / and the /hx/today/* partials, POST /hx/sweeps/*
src/web/handlers/clear.ts GET /clear (page shell) and GET /clear/deal (cards)
src/static/vendor/htmx.min.js   htmx 2.x, vendored (no CDN)
src/static/home/main.js   htmx glue: ch:toast → snackbar with Undo; theme toggle; SW; autosync ping
src/static/home/round.js  the island: deals, gestures, keys, undo, resume, stamp (consumes card HTML)
src/static/home/home.css  styles for both rooms
```
Deleted: `src/templates/home.html`, `src/static/home/today.js`, `src/static/home/card.js`.

The markdown renderer `src/static/core/markdown.js` is DOM-free; the server imports it
(`renderMarkdown`) so card bodies render with the same rules as the reader.

## 4. The rich card (server-rendered, `renderCard`)

```html
<article class="card" data-fullname="reddit:t3_x" data-source="reddit" data-kind="post"
         style="--src: var(--source-reddit)">
  <div class="card-fg item-fg">
    <header class="card-head">
      <span class="card-glyph" aria-hidden="true">r/</span>
      <span class="card-where"><b>r/todayilearned</b><span class="card-by">u/someone</span></span>
      <time class="card-age" datetime="2019-04-02">6y</time>
    </header>

    <figure class="card-media" data-media="image|gallery|video|youtube|link">   <!-- optional -->
      <img src="…" data-fallback="/media/<blob>" alt="" decoding="async">
      <span class="media-badge">1 / 12</span>          <!-- gallery count | ▶ 4:32 | ▶ clip | domain -->
    </figure>

    <p class="card-context">Comment on <b>Post title</b></p>   <!-- comments only -->
    <h2 class="card-title">Post title</h2>                      <!-- posts, videos, stories, notes -->
    <div class="card-body md">rendered markdown…</div>          <!-- self text / the saved comment / note body -->
    <button class="card-more" type="button" hidden>Show more</button>

    <aside class="card-reply">                                  <!-- optional: cached top comment -->
      <p class="reply-who">Top comment · u/x · ▲ 2.3k</p>
      <div class="reply-body md">…</div>
    </aside>

    <footer class="card-stats">
      <span class="stat stat-score">[up-icon] 4.2k</span>
      <span class="stat stat-comments">[comment-icon] 312</span>
      <span class="cost">3 min read</span>
      <span class="stat stat-domain">example.com</span>
      <span class="tag tag-nsfw">NSFW</span>                    <!-- when over_18 -->
    </footer>
  </div>
</article>
```

Per source:
- **Reddit post**: head `r/sub` + `u/author`; media hero from image / gallery (count badge) /
  v.redd.it video (poster = thumbnail, badge "▶ clip") / link thumbnail (badge = domain); title;
  self-text body (markdown) when non-empty and not a removed placeholder; top comment from the
  thread cache when hydrated; stats score, comments (`num_comments`), domain for external links.
- **Reddit comment** (the saved thing *is* the comment): `card-context` "Comment on <post title>",
  no `card-title`, the comment body is the hero (larger body type), author in the head; media from
  the parent post only if present in metadata.
- **YouTube**: 16:9 thumbnail hero with "▶ 12:04" badge; head = channel; title; stats = views, cost.
- **Hacker News**: head = "Hacker News · u/author"; `og_image` hero when present; title; stats =
  points, comments (`descendants`), domain.
- **Keep / Obsidian / Firefox / Twitter**: head = source label; title; body markdown (notes) or URL
  domain; no stats except cost.

Media URLs: original URL in `src`; `data-fallback` = `/media/<blob>` from `metadata.archived_media`
when present (the island swaps on `error`, then removes the figure if that fails too). YouTube
`maxresdefault` falls back to `hqdefault` the same way. NSFW items render media with class
`is-nsfw` (blurred until tapped). Every interpolated string is escaped by `html```.

Body length: the server sends the full body (cap 6,000 chars); the CSS clamps `.card-body` to
~9 lines on phones / 12 on desktop with a fade; the island un-hides `.card-more` when the body
overflows and toggles `.card.is-expanded` (the card then scrolls internally). Space also toggles.

## 5. Clear (island)

- `GET /clear` → server page: nav hidden (`body.is-round`), the round frame from v1 §4.3 (bar,
  stage, pad, cleared), `<script type="module">` mounting `round.js`.
- `GET /clear/deal?n=10[&q=…][&ids=a,b,c][&safe=1]` → JSON
  `{ items: [{ fullname, status, html }] }`. `ids` (from Today's Up next) wins; else `q` (pile
  peek, inbox only); else the smart random batch. NSFW filtered server-side when `safe=1`.
- The island stores `html` with each item in `sessionStorage["ch.round"]`, shows the current card
  and renders the **next** card behind it as `.card.is-next` (aria-hidden, inert, scaled 0.95 and
  nudged down) — the stack peek. Everything else from v1 §5 stays: optimistic decisions, undo walk,
  resume + reader reconcile, combo, stamp, ch.lastRound.

## 6. Today (server-rendered + htmx)

```html
<section class="today">
  <header class="today-head"> <p class="today-date">…</p> <p class="today-reentry">…</p> </header>

  <div class="hero">
    <a class="hero-go" id="hero-go" href="/clear?n=10&ids=…"> <span class="hero-verb">Clear 10</span>
       <span class="hero-sub">about 2 minutes</span></a>
    <nav class="hero-sizes" aria-label="Round size">
      <a href="/?n=5" hx-get="/hx/today/upnext?n=5" hx-target="#upnext" hx-swap="outerHTML"
         hx-push-url="/?n=5" aria-current="false">5</a> … 10 … 25
    </nav>
  </div>

  <section class="upnext" id="upnext" hx-get="/hx/today/upnext?n=10" hx-trigger="load" hx-swap="outerHTML">
    <!-- response: -->
    <h2 class="sec-h">Up next</h2>
    <ol class="strip">
      <li class="strip-card" style="--src:…"><img src="…" alt=""><span class="strip-cap">r/aviation</span></li>
      <li class="strip-card is-text" style="--src:…"><span class="strip-title">Why starting is harder…</span><span class="strip-cap">r/ADHD</span></li>
      … first 6 …
      <li class="strip-more">+4</li>
    </ol>
    <p class="upnext-mix">4 images · 2 videos · 1 long read · about 3 min</p>
    <!-- plus an hx-swap-oob replacement of #hero-go with the dealt ids and size -->
  </section>

  <section class="wins" id="wins" hx-get="/hx/today/wins" hx-trigger="load, ch:wins from:body">…</section>

  <section class="piles" id="piles" hx-get="/hx/today/piles" hx-trigger="load">
    <h2 class="sec-h">Let a pile go</h2> <p class="sec-sub">…</p>
    <ul class="pile-list">
      <li class="pile">
        <div class="pile-mosaic"><img …><img …><img …></div>      <!-- or glyph tiles -->
        <div class="pile-main"><p class="pile-label">r/NonCredibleDefense</p>
          <p class="pile-meta">148 saves · 2019 – 2024</p></div>
        <a class="pile-peek" href="/clear?n=10&q=subreddit%3Anoncredibledefense">Peek</a>
        <button class="pile-go" hx-post="/hx/sweeps/apply" hx-vals='{"kind":…}'
                hx-target="#piles" hx-swap="outerHTML">Let go</button>
      </li>
    </ul>
  </section>

  <aside class="whisper" id="whisper" hx-get="/hx/today/whisper" hx-trigger="load" hx-swap="outerHTML"></aside>
  <footer class="today-foot">…Search the library · theme…</footer>
</section>
```
- `/` reads `?n=` (5/10/25, default from cookie `ch_round_size`, else 10) and sets the cookie.
- `POST /hx/sweeps/apply` → re-rendered `#piles` + header
  `HX-Trigger: {"ch:wins":null,"ch:toast":{"msg":"148 r/NonCredibleDefense saves rested.","undo":{"post":"/hx/sweeps/undo","vals":{"wave":123},"target":"#piles"}}}`.
  `POST /hx/sweeps/undo` → `#piles` + `HX-Trigger: {"ch:wins":null,"ch:toast":{"msg":"Back in the pile."}}`.
- Whisper buttons: Peek = link to `/clear?n=5&q=<cluster>`; Not now / Let it go = `hx-post`
  `/hx/whisper/dismiss|letgo` returning an empty whisper + toast (letgo carries undo to
  `/hx/whisper/undo` with `{cluster, decayed_at}`).
- Re-entry line needs `ch.lastRound` (client storage): the round also writes cookie
  `ch_last_round=<at_ms>.<cleared>` so the server can render it.
- `main.js` handles `ch:toast` (snackbar; Undo calls `htmx.ajax("POST", undo.post, {values, target, swap:"outerHTML"})`).

## 7. Library

Unchanged structure. Shared nav markup comes from `views/page.ts`'s `navHtml()` too: the Library
template keeps its own copy until its list migrates; the icons must match.
