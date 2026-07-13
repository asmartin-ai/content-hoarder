# #39 — Text Reddit post misleading play button

**Status: VERIFIED mostly fixed on main; regression guard + text chip 2026-07-12.**

## Finding
`mediaType()` classifies AskReddit-style self posts as `cls: "text"` when the URL is a
reddit comments permalink (not `v.redd.it` / image). Coarse `media_type: reddit_media` in
metadata does not force a play control.

Browse surfaces already gated:
- Log monitor / pin card via `isRedditTextPost`
- Ledger playpill only for `video|image|gallery`

This branch adds a non-button `📝 text` chip + #31 blurb so text posts still read as text.

## Regression test
`tests/test_media_caption_blurb.py::test_askreddit_self_post_is_text_not_video`
