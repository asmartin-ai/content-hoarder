# #30 — Video not fetching properly

**Status: INVESTIGATED 2026-07-12 (no code fix — needs repro item).**

## Play path
`playableVideoSrc` → local archive blob **or** `v.redd.it/.../HLSPlaylist.m3u8` **or** direct mp4.
Lightbox: `mountVideo` + hls.js + failure watchdog.

## Live DB
~522 `reddit_video` items. Limit-1 video archive smoke already passed on a DB copy.

## Failure modes to check once a fullname is known
| Mode | Symptom |
|---|---|
| CDN/auth block | HLS 403/404, watchdog message |
| Deleted video | same |
| Misclassified | no video control |
| External host (YouTube) | expected non-inline |

## Blocked on
One failing `fullname` / permalink from the user.
