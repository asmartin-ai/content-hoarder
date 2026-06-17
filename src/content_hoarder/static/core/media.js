/* core/media.js — thumbnails, media classification, Reddit URLs, lightbox, NSFW.
   Consolidates app.js:42-126/271-278/396-446 + triage.js:54-58 + reddit.js:627-646.
   The lightbox is a factory over a modal root so any page can host one; Esc +
   backdrop close are built in (Epic 13:381). */

import { esc, safeUrl } from "./util.js";

/* ---- thumbnails ---- */
/* density: "card" gets the crisp maxres variant (onerror-falls back to mqdefault
   via ytFallback); everything else gets the light bar-free mqdefault (~10KB). */
export const thumb = (item, density) => {
  const m = item.metadata || {};
  let t = m.thumbnail || "";
  if (!t && item.source === "hackernews") t = m.og_image || "";  // article preview (Epic 15 P3)
  if (!t) {
    const url = item.url || "";
    if (/\.(png|jpe?g|gif|webp)$/i.test(url)) return url;
    const yt = url.match(/(?:v=|youtu\.be\/|\/shorts\/)([\w-]{6,})/);
    t = yt ? "https://i.ytimg.com/vi/" + yt[1] + "/hqdefault.jpg" : "";
  }
  if (/i\.ytimg\.com/.test(t)) {
    const variant = density === "card" ? "maxresdefault" : "mqdefault";
    t = t.replace(/\/[a-z0-9]+default\.jpg(\?.*)?$/i, "/" + variant + ".jpg");
  }
  return t;
};

/* YouTube maxres thumbs 404 on some videos → onerror-fall-back to mqdefault. */
export const ytFallback = (t) => /i\.ytimg\.com\/vi\/[^/]+\/maxresdefault\.jpg/.test(t)
  ? " onerror=\"this.onerror=null;this.src=this.src.replace('maxresdefault','mqdefault')\""
  : "";

/* Full image URL to open in a lightbox (direct images / i.redd.it), else "". */
export const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp)(\?|#|$)/i;
export const imageUrl = (item) => {
  const m = item.metadata || {};
  const u = item.url || "";
  if (IMG_EXT.test(u) || /i\.redd\.it\//i.test(u)) return u;
  return m.media_type === "image" ? (m.media_url || "") : "";
};

/* ---- media/content classification (from reddit.js — drives the Epic 13:344
   native-embed pass: galleries/video from archived metadata, no reddit iframe). */
export const mediaType = (item) => {
  if (item.kind === "comment") return { cls: "comment", icon: "💬", label: "Comment" };
  // Reddit-hosted video: item.url is the permalink (→ "text" below), so the v.redd.it
  // evidence lives in metadata.media_url. Trust it directly (the archive signal the
  // url-heuristic can't see) so the row routes to openVideo (HLS) not the iframe.
  if (((item.metadata || {}).media_url || "").includes("v.redd.it"))
    return { cls: "video", icon: "🎬", label: "Video" };
  const url = (item.url || "").toLowerCase();
  if (/\.(jpg|jpeg|png|gif|webp|bmp)(\?|$)/.test(url) || url.includes("i.redd.it") || url.includes("i.imgur.com"))
    return { cls: "image", icon: "🖼️", label: "Image" };
  if (url.includes("/gallery/") || url.includes("imgur.com/a/"))
    return { cls: "gallery", icon: "🖼️", label: "Gallery" };
  if (/\.(mp4|webm|mov)(\?|$)/.test(url) || url.includes("v.redd.it") || url.includes("gfycat.com") || url.includes("redgifs.com"))
    return { cls: "video", icon: "🎬", label: "Video" };
  if (url.includes("youtube.com") || url.includes("youtu.be"))
    return { cls: "video", icon: "🎬", label: "YouTube" };
  const isSelf = !url || url.includes("reddit.com/r/") || url.includes("/comments/");
  if (isSelf) return { cls: "text", icon: "📝", label: "Text post" };
  return { cls: "link", icon: "🔗", label: "External link" };
};

/* ---- Reddit URLs ----
   Permalinks are stored relative ("/r/sub/comments/…"); make them absolute so
   links/embeds don't resolve against our own origin (triage.js lacked this). */
export const redditUrl = (permalink) => {
  const p = (permalink || "").trim();
  if (!p) return "";
  if (/^https?:\/\//i.test(p)) return p;
  return "https://www.reddit.com" + (p.charAt(0) === "/" ? p : "/" + p);
};
export const redditEmbedUrl = (permalink) => {
  const base = redditUrl(permalink).split("#")[0].split("?")[0]
    .replace(/^https?:\/\/([a-z0-9-]+\.)?reddit\.com/i, "https://www.redditmedia.com");
  return base + "?ref_source=embed&ref=share&embed=true&theme=dark";
};

/* ---- v.redd.it audio (Epic 13 P2) ----
   Stored reddit-video media_url is the bare https://v.redd.it/<id> (or a video-only
   .../DASH_NNN.mp4 fallback) — neither carries audio, which reddit splits into a
   separate HLS/DASH track. The combined stream is the HLS manifest below; play that
   instead. "" for non-v.redd.it sources (keep the plain <video src>). */
export const hlsManifestUrl = (srcUrl) => {
  const m = (srcUrl || "").match(/https?:\/\/v\.redd\.it\/([A-Za-z0-9]+)/);
  return m ? "https://v.redd.it/" + m[1] + "/HLSPlaylist.m3u8" : "";
};

/* Lazy-load the vendored hls.js once (only when a v.redd.it video is opened on a
   browser without native HLS). Resolves to window.Hls, or null if it fails to load. */
let _hlsPromise = null;
const loadHls = () => {
  if (typeof window !== "undefined" && window.Hls) return Promise.resolve(window.Hls);
  if (_hlsPromise) return _hlsPromise;
  _hlsPromise = new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "/static/vendor/hls.min.js";
    s.onload = () => resolve(window.Hls || null);
    s.onerror = () => { _hlsPromise = null; resolve(null); };
    document.head.appendChild(s);
  });
  return _hlsPromise;
};

/* ---- lightbox ----
   createLightbox({modal, body}) — modal: the overlay element (with `hidden`),
   body: the content container inside it. Esc + backdrop-click close built in. */
export function createLightbox(opts) {
  const modal = typeof opts.modal === "string" ? document.querySelector(opts.modal) : opts.modal;
  const body = typeof opts.body === "string" ? document.querySelector(opts.body) : opts.body;

  let activeHls = null;  // the hls.js instance for an open v.redd.it video, if any
  const close = () => {
    modal.hidden = true;
    if (activeHls) { activeHls.destroy(); activeHls = null; }  // stop hls buffering
    body.innerHTML = "";  // stop playback
  };
  modal.addEventListener("click", (e) => {
    if (e.target === modal || e.target.closest("[data-media-close]")) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) close();
  });

  const open = (html) => { body.innerHTML = html; modal.hidden = false; };

  return {
    close,
    /* Reddit permalink → redditmedia iframe (online-only; permalink is the fallback). */
    openMedia(permalink) {
      const url = redditUrl(permalink);
      if (!safeUrl(url)) return;
      open('<iframe class="reddit-embed-frame" src="' + esc(redditEmbedUrl(permalink)) + '" loading="lazy"></iframe>' +
        '<a class="media-fallback" href="' + esc(url) + '" target="_blank" rel="noopener">Open on Reddit ↗</a>');
    },
    /* Direct image → simple lightbox (reliable; no Reddit dependency). */
    openImage(url) {
      if (!safeUrl(url)) return;
      open('<img class="media-img" src="' + esc(url) + '" alt="">' +
        '<a class="media-fallback" href="' + esc(url) + '" target="_blank" rel="noopener">Open original ↗</a>');
    },
    /* Gallery (metadata.gallery from the archive's media_metadata) → stacked lightbox. */
    openGallery(urls) {
      const imgs = (urls || []).filter(safeUrl);
      if (!imgs.length) return;
      open('<div class="media-gallery">' +
        imgs.map((u) => '<img class="media-img gallery-img" loading="lazy" src="' + esc(u) + '" alt="">').join("") +
        '</div><p class="media-fallback">' + imgs.length + " images</p>");
    },
    /* Reddit/archived video → native <video> (Epic 13:344). For v.redd.it the stored
       url has no audio, so we play the HLS manifest (audio+video): native HLS where
       supported (Safari/iOS), else lazy-loaded hls.js; a non-v.redd.it direct file
       keeps the plain <video src>. */
    openVideo(srcUrl, posterUrl) {
      if (!safeUrl(srcUrl)) return;
      const poster = posterUrl && safeUrl(posterUrl) ? ' poster="' + esc(posterUrl) + '"' : "";
      const hls = hlsManifestUrl(srcUrl);
      const fallback = '<a class="media-fallback" href="' + esc(srcUrl) +
        '" target="_blank" rel="noopener">Open original ↗</a>';
      if (!hls) {
        open('<video class="media-video" controls playsinline preload="metadata"' + poster +
          ' src="' + esc(srcUrl) + '"></video>' + fallback);
        return;
      }
      open('<video class="media-video" controls playsinline preload="metadata"' + poster +
        '></video>' + fallback);
      const video = body.querySelector("video.media-video");
      if (!video) return;
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = hls;  // native HLS (Safari/iOS) — plays the muxed audio+video
        return;
      }
      loadHls().then((Hls) => {
        // a later close() may have torn the element down before the script arrived
        if (!Hls || !document.body.contains(video)) return;
        if (Hls.isSupported()) {
          const h = new Hls();
          activeHls = h;
          h.loadSource(hls);
          h.attachMedia(video);
        } else {
          video.src = srcUrl;  // last-ditch: video-only, but at least shows the clip
        }
      });
    },
  };
}

/* ---- NSFW ----
   createNsfw(isNsfw) returns {wrap, reveal, revealed} sharing one per-page
   revealed-set; blur styling is the page CSS's job (reddit-style, Epic 16:438). */
export function createNsfw(isNsfw) {
  const revealed = new Set();
  return {
    revealed,
    isRevealed: (fullname) => revealed.has(fullname),
    wrap(item, inner) {
      if (!inner) return "";
      if (!isNsfw(item) || revealed.has(item.fullname)) return inner;
      return '<div class="item-media nsfw" data-nsfw-media="1">' + inner +
        '<span class="nsfw-tag">NSFW</span></div>';
    },
    reveal(fullname, row) {
      revealed.add(fullname);
      if (!row) return;
      row.dataset.revealed = "1";
      row.querySelectorAll(".item-media.nsfw").forEach((el) => el.classList.remove("nsfw"));
    },
  };
}
