# Mobile nav redesign — design reference

Reference + spec for replacing the mobile **`# tags` pill → `#tagsheet`** nav with a searchable, grouped
**"Jump" drawer**. Built from a study of the user's preferred Reddit clients (Relay, Sync).

## Documents

| Doc | What it is |
|---|---|
| [relay-observations.md](relay-observations.md) | Relay for Reddit — nav/UX feature catalog (R1–R30) from the demo recording, with embedded reference frames. |
| [sync-observations.md](sync-observations.md) | Sync for Reddit — feature catalog (S1–S24), same shape. |
| [content-hoarder-recommendations.md](content-hoarder-recommendations.md) | Cross-app synthesis → 26 tiered, content-hoarder-mapped features (C1–C26) + an MVP slice. |
| [tier1-jump-drawer-spec.md](tier1-jump-drawer-spec.md) | Approved Tier 1 drawer spec (anatomy, interactions, port plan). |

## Asset strategy

This folder is the **version-controlled, curated** deliverable: the docs plus the **small subset of frames they
embed** (`frames/`, `sync-frames/` — ~26 MB total, renders on GitHub).

The **bulky raw source is intentionally NOT committed** — the two screen-recordings (`relay-demo.mp4`,
`sync-demo.mp4`, ~334 MB) and the full 2 fps extractions (~353 frames) live locally in
`design-ref/reddit-app-study/`, which is git-ignored. They're regenerable from the clips:

```
ffmpeg -i relay-demo.mp4 -vf fps=2 frames/frame_%03d.png
```

Keeping half a gig of video out of git history is deliberate (git handles large binaries poorly). If the raw
assets ever need to be shared/versioned, use git-LFS or external asset storage rather than committing them here.
