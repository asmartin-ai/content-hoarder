## Epic 2 — YouTube metadata enrich  (`enhancement`, `area:youtube`)
*Motivation: `--flat-playlist` captures duration/channel but NOT category/tags/description, which
the categorizer (Epic 1) wants for accuracy.*

- [x] ~~**Per-video enrich pass.**~~ Shipped: `YouTubeConnector.enrich()` runs
  `yt-dlp --dump-single-json` per video to fill exact `duration`/`view_count`/`yt_categories`/`tags`/
  `description`/`channel`; `enrich --source youtube [--limit N]`, resumable via `hydrated_at`, lazy
  yt-dlp, unavailable videos stamped. (Full ~5k run deferred — slow; chunk with `--limit`.)
