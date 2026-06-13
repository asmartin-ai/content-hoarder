/* Pure-logic unit tests for resolveMedia() + imageUrl() — Epic 13:344 detection layer.
   Run: node media.resolve.test.mjs   (no browser; the doc's §6.2 regression net.)
   Fixtures are copied from docs/reddit-media-rendering.md §2.3 REAL corpus samples. */

import { resolveMedia, imageUrl } from "./media.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`); };
};
const item = (metadata, url = "") => ({ metadata, url });

/* ---- reddit_video, modern enrich (CMAF, stored playable fallback) — t3_1tx02l2 ---- */
{
  const r = resolveMedia(item({
    media_type: "reddit_video",
    media_url: "https://v.redd.it/mp69us2tvb5h1/CMAF_1080.mp4?source=fallback",
    thumbnail: "https://external-preview.redd.it/x.png",
    permalink: "https://www.reddit.com/r/StandUpComedy/comments/1tx02l2/x/",
  }));
  eq("video.kind", r.kind, "video");
  eq("video.id", r.id, "mp69us2tvb5h1");
  eq("video.fallback", r.fallback, "https://v.redd.it/mp69us2tvb5h1/CMAF_1080.mp4?source=fallback");
  eq("video.hls", r.hls, "https://v.redd.it/mp69us2tvb5h1/HLSPlaylist.m3u8");
}

/* ---- reddit_video, bare id (no path → no playable fallback) — t3_1plfjv1 ---- */
{
  const r = resolveMedia(item({ media_url: "https://v.redd.it/4ai2l2vdax6g1", media_type: "reddit_video" }));
  eq("bare.kind", r.kind, "video");
  eq("bare.id", r.id, "4ai2l2vdax6g1");
  eq("bare.fallback-empty", r.fallback, "");
  eq("bare.hls", r.hls, "https://v.redd.it/4ai2l2vdax6g1/HLSPlaylist.m3u8");
}

/* ---- untyped video in the reddit_media catch-all (DASH fallback present) ---- */
{
  const r = resolveMedia(item({
    media_type: "reddit_media",
    media_url: "https://v.redd.it/y7etx8k3xd9a1/DASH_720.mp4?source=fallback",
  }));
  eq("untyped-video.kind", r.kind, "video");
  eq("untyped-video.fallback", r.fallback, "https://v.redd.it/y7etx8k3xd9a1/DASH_720.mp4?source=fallback");
}

/* ---- gallery, typed (array of preview.redd.it URLs) — t3_1txs0r6 ---- */
{
  const urls = ["https://preview.redd.it/a.png?width=573", "https://preview.redd.it/b.png", "https://preview.redd.it/c.png"];
  const r = resolveMedia(item({ media_type: "gallery", media_url: "https://www.reddit.com/gallery/1txs0r6", gallery: urls }));
  eq("gallery.kind", r.kind, "gallery");
  eq("gallery.len", r.urls.length, 3);
}

/* ---- gallery, UNTYPED holder (array present but media_type=reddit_media) — t3_100c6ir ---- */
{
  const r = resolveMedia(item({
    media_type: "reddit_media",
    media_url: "https://www.reddit.com/gallery/100c6ir",
    gallery: ["https://preview.redd.it/x.png", "https://preview.redd.it/y.png"],
  }));
  eq("untyped-gallery.kind (array beats label)", r.kind, "gallery");
  eq("untyped-gallery.len", r.urls.length, 2);
}

/* ---- image, typed — t3_146we0g ---- */
{
  const r = resolveMedia(item({ media_type: "image", media_url: "https://i.redd.it/fk2qfxtdne5b1.png" }));
  eq("image.kind", r.kind, "image");
  eq("image.url", r.url, "https://i.redd.it/fk2qfxtdne5b1.png");
}

/* ---- image hidden in the catch-all (the 23.5k unlock): type=reddit_media, url=permalink ---- */
{
  const it = item(
    { media_type: "reddit_media", media_url: "https://i.redd.it/abc123.jpg" },
    "https://www.reddit.com/r/pics/comments/x/y/",
  );
  eq("catchall-image.kind", resolveMedia(it).kind, "image");
  eq("catchall-image.imageUrl", imageUrl(it), "https://i.redd.it/abc123.jpg");
}

/* ---- imgur .gifv → mp4 (muted loop) ---- */
{
  const r = resolveMedia(item({ media_url: "https://i.imgur.com/abcd.gifv" }));
  eq("gifv.kind", r.kind, "video");
  eq("gifv.fallback", r.fallback, "https://i.imgur.com/abcd.mp4");
  eq("gifv.loop", r.loop, true);
}

/* ---- gfycat (dead host) → kind:dead, never play ---- */
{
  const r = resolveMedia(item({ media_type: "reddit_media", media_url: "https://gfycat.com/SomeSlug", thumbnail: "https://t.png" }));
  eq("gfycat.kind", r.kind, "dead");
  eq("gfycat.poster", r.poster, "https://t.png");
}

/* ---- self/text post (no media_url) → link ---- */
{
  const it = item({ media_type: "reddit_media", permalink: "/r/AskReddit/comments/x/y/" }, "https://www.reddit.com/r/AskReddit/comments/x/y/");
  eq("text.kind", resolveMedia(it).kind, "link");
  eq("text.imageUrl-empty", imageUrl(it), "");
}

/* ---- imageUrl back-compat: direct item.url still wins ---- */
{
  eq("imageUrl.direct-url", imageUrl(item({}, "https://i.redd.it/z.png")), "https://i.redd.it/z.png");
  eq("imageUrl.ext-url", imageUrl(item({}, "https://example.com/p.jpg")), "https://example.com/p.jpg");
}

console.log(`\nresolveMedia/imageUrl fixtures: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
