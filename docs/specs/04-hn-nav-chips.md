# Spec 04 — Hacker News nav chips (author link + article chip)

BACKLOG: Epic 15 #471 (author→profile) + #473 (article chip). Branch: `feat/hn-nav-chips`.
Touches: `static/browse/render.js` (+ import from `core/render.js`), `static/browse/browse.css` (maybe).

## Goal

For HN items in the v3 browse view:
- **(A) #471** — render the author as a link to `https://news.ycombinator.com/user?id=<author>`,
  mirroring the existing Reddit user link.
- **(B) #473** — add a separate chip that opens the external article URL (`item.url`), since the title
  already opens the discussion thread.

## Data facts (confirmed)
- `core/render.js:22-28`: `itemUrl(hn)` returns the **thread** (`hnThreadUrl` = `item?id=<source_id>`),
  falling back to `item.url`. So the title already opens the discussion.
- For an enriched HN story with an external link, `item.url` = the **article URL**, `metadata.hn_url`
  (and `hnThreadUrl(item)`) = the **discussion**; they diverge exactly when there's an external link.
  Ask-HN/self posts have `item.url === thread` → show NO chip.
- `item.author` = HN username (enrich sets `author = data.get("by")`). Bare/pre-enrich items have no author.

## Acceptance criteria
- HN row/card shows `by <author>` linking to `news.ycombinator.com/user?id=<author>` (URL-encoded);
  no author → no link. Clicking it does not toggle row select (uses `metaAnchor`'s `stopPropagation`).
- HN row/card shows an article chip opening `item.url` in a new tab **only when** `item.url` differs
  from `hnThreadUrl(item)`; absent/redundant → no chip.
- Reddit/YouTube items are visually unchanged.
- No console errors; preview-verified.

## Implementation (`static/browse/render.js`)
- **(A)** In `metaHtml()` (`:43-54`), add an HN branch near the `<b>HN</b>` line (`:49`):
  `if (item.author) bits.push("by " + metaAnchor("https://news.ycombinator.com/user?id=" +
  encodeURIComponent(item.author), item.author));`
  (`metaAnchor` already imported `:6-10`; pattern mirrors `core/render.js:60` Reddit user link.)
- **(B)** Import `hnThreadUrl` from `core/render.js` (`:23`). Add a helper
  `hnArticleUrl(item) = (item.source==="hackernews" && item.url && item.url !== hnThreadUrl(item)) ? item.url : ""`.
  Emit a chip in the row/card trail mirroring the existing `playpill` (`ledgerRow` `:108-121`):
  an **anchor** `<a class="playpill" href=esc(url) target="_blank" rel="noopener"
  onclick="event.stopPropagation()">↗ article</a>` — NOT `data-media` (that would route through
  `openMediaFor`). Add to `logRow` trail (`:102`), `ledgerRow` trail (`:121`), and `pinCard` `.tagrow` (`:150`).

## CSS
- `.meta-link` already styled (`browse.css:262-264`) — reuse for (A).
- `.playpill` already styled (`browse.css:278-279`) — reuse for (B), or add a `.ext-chip` variant if a
  distinct look is wanted. Do NOT use `.comp-link`/`.companions` (those live only in `app.css`, the v2 page).
- Keep (B) chip in `.trail` (not inside `.meta`, which is `nowrap;overflow:hidden` and would clip it).

## Tests / verification
- No JS unit tests exist. `tests/test_static_core.py` + `tests/test_browse_view.py` only check serving/wiring
  — run them after edits (they break if you rename core files / change index.html script tags).
- Preview-verify (seed via `models.new_item(source="hackernews", author="pg",
  url="https://example.com/article", metadata={"hn_url":"https://news.ycombinator.com/item?id=123"},
  source_id="123", ...)`): confirm author link, article chip on external-link stories, NO chip on
  Ask-HN (where url===thread), no console errors, links don't select the row.

## Out of scope
HN OG-image thumbnails (#475, optional). YouTube channel-link parity (see parity-ideas.md).
