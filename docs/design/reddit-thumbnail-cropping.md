# Reddit thumbnail cropping research

> Snapshot as of 2026-06-29.

Source: curated from the deleted `content-hoarder-flash` delegation note, 2026-06-28.

## Goal

Decide whether content-hoarder should more closely mimic Reddit app thumbnail framing before changing browse CSS.

The current implementation is CSS-only: `thumb()` selects a thumbnail/media URL, while `browse.css` decides the visible crop. No server-side resize pipeline is involved.

## Survey summary

| App / surface | Compact/list treatment | Card treatment | Takeaway |
|---|---|---|---|
| Official Reddit app | Square-ish fixed thumbnail, center crop | 16:9-ish crop, often top-biased for tall media | Avoids letterbox; tall content may be cropped. |
| Apollo | 1:1 compact crop | 16:9 card crop, top anchored | Prioritizes stable cells and no empty gutters. |
| RES / old.reddit | Small fixed thumbnails, usually square | Inline expandos can show native aspect | Classic Reddit separates thumbnail density from full media expansion. |
| Relay | 1:1 list crop | 16:9 card crop, center/top | Similar fixed-aspect pattern to official clients. |
| old.reddit | API-provided 70x70 thumbnail/default/self placeholders | N/A | Very dense; not a strong model for content-hoarder's media-first UI. |

Common pattern: Reddit clients generally prefer fixed boxes with `object-fit: cover` over letterbox/pillarbox. For tall screenshots, top anchoring preserves header/title text better than center anchoring.

## Recommendation

### Ledger / compact density

Keep the existing fixed thumbnail footprint (`.monitor`: 128x76 desktop, 96x64 mobile), but if adopting the Reddit-app behavior, prefer cover-crop inside that box.

Current canonical CSS note: `.monitor img` defaults to `object-fit: contain`, while comfortable density overrides it to `cover`. That means compact/ledger can currently show empty gutters. If the goal is strict Reddit-like density, change compact to `cover` and keep `object-position: center top`.

### Log / comfortable density

No major change recommended. Canonical CSS already sets `.items.density-comfortable .monitor img { object-fit: cover; }`, matching the no-letterbox app pattern.

### Card / pinboard density

Keep the existing container strategy:

- `.pin .screen { max-height: 430px; overflow: hidden; }`
- `.pin .screen img { width: 100%; object-fit: cover; object-position: center top; }`

This is intentionally better for tall screenshots than a fixed 16:9 card, because portrait content can use more vertical space before cropping.

Optional future tweak: add an explicit `contain` escape hatch only for extreme aspect ratios where a cover crop destroys too much information. Do not make this the default; the v3 design intentionally avoids pillarbox for normal media.

## Small implementation follow-ups to verify

- Feed thumbnails currently have `loading="lazy"`.
- Feed thumbnails do **not** currently show `decoding="async"` or `referrerpolicy="no-referrer"` in `browse/render.js`; consider adding both if browser behavior and source hosts allow it.
- If changing compact crop behavior, test NSFW blur/veil sizing because the blur scale is tied to the fixed thumbnail box.

## Verification checklist

Run in desktop and mobile widths with 1:1, 4:3, 16:9, 2:1, and tall screenshot media:

- Ledger/compact: no accidental layout shift; chosen crop/contain behavior is intentional.
- Log/comfortable: thumbnails fill the fixed box; no NSFW overflow regression.
- Card/pinboard: portrait screenshots remain readable enough; normal images avoid empty gutters.
- Gallery thumbnails: first image still renders and opens the full gallery.
- Console: no image loading/CSS errors.

## Relevant files

- `src/content_hoarder/static/browse/browse.css`
- `src/content_hoarder/static/browse/render.js`
- `src/content_hoarder/static/core/media.js`
