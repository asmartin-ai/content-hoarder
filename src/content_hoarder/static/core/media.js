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
  // Card density wants a crisp preview: a gallery's first full-size image beats the small
  // (often 140px) reddit thumbnail, which upscales to a blurry placeholder in Pinboard
  // density. List/compact keep the lightweight thumbnail for scroll perf (Epic 13 P2).
  if (density === "card" && Array.isArray(m.gallery) && m.gallery.length) return m.gallery[0];
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
const _directImg = (u) => IMG_EXT.test(u || "") || /i\.redd\.it\//i.test(u || "");
export const imageUrl = (item) => {
  const m = item.metadata || {};
  if (_directImg(item.url)) return item.url;
  // Epic 13:344 (harvested from feat/reddit-media-v13): recognize images by media_url
  // SHAPE, not the media_type label — unlocks ~25.8k i.redd.it posts stuck in the
  // reddit_media catch-all with item.url = permalink.
  if (_directImg(m.media_url)) return m.media_url;
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
  // Image evidence in metadata.media_url (harvested from feat/reddit-media-v13): the
  // ~25.8k reddit_media-catch-all posts whose item.url is the permalink, not the image.
  if (_directImg((item.metadata || {}).media_url))
    return { cls: "image", icon: "🖼️", label: "Image" };
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

/* The directly-playable video URL for an item — a v.redd.it/HLS source or a
   .mp4/.webm/.mov file — or "" when the item's "video" is an external page
   (YouTube, gfycat/redgifs, …) that must open via its source link, not an inline
   <video>. Single source of truth for the reader's inline player AND the lightbox
   (browse/reader.js + browse/main.js) so the two can't disagree about playability. */
export const playableVideoSrc = (item) => {
  if (mediaType(item).cls !== "video") return "";
  const m = item.metadata || {};
  const src = m.media_url || item.url || "";
  return (hlsManifestUrl(src) || /\.(mp4|webm|mov)(\?|#|$)/i.test(src)) ? src : "";
};

/* mountVideo(container, srcUrl, posterUrl, opts) — mount a <video> player into container.
   Handles v.redd.it HLS (native or hls.js) and plain direct video files.
   opts.autoplay: start playback as soon as THIS path's source is actually attached —
   for the hls.js path that's inside the async .then(), so a synchronous play() by the
   caller would no-op (the source isn't attached yet). Returns { video, destroy } where
   video is the <video> element and destroy is a teardown function to call when done
   (stops HLS buffering). The destroy closure reads the hls instance at call time, not at
   mount time, avoiding the async leak. */
export function mountVideo(container, srcUrl, posterUrl, opts) {
  if (!safeUrl(srcUrl)) return { video: null, destroy: null };
  const autoplay = !!(opts && opts.autoplay);
  const hlsUrl = hlsManifestUrl(srcUrl);
  const poster = posterUrl && safeUrl(posterUrl) ? posterUrl : "";
  const fallbackUrl = esc(srcUrl);
  const fallbackHtml = '<a class="media-fallback" href="' + fallbackUrl +
    '" target="_blank" rel="noopener">Open original ↗</a>';

  const video = document.createElement("video");
  video.className = "media-video";
  video.controls = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("preload", "metadata");
  if (poster) video.setAttribute("poster", poster);
  const tryPlay = () => { if (autoplay) video.play().catch(() => {}); };  // guard rejection (no gesture)

  if (!hlsUrl) {
    video.src = srcUrl;
    container.innerHTML = "";
    container.appendChild(video);
    container.insertAdjacentHTML("beforeend", fallbackHtml);
    tryPlay();
    return { video, destroy: null };
  }

  container.innerHTML = "";
  container.appendChild(video);
  container.insertAdjacentHTML("beforeend", fallbackHtml);

  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = hlsUrl;
    tryPlay();
    return { video, destroy: null };
  }

  let activeHls = null;
  loadHls().then((Hls) => {
    if (!Hls || !document.body.contains(video)) return;
    if (Hls.isSupported()) {
      const h = new Hls();
      activeHls = h;
      h.loadSource(hlsUrl);
      h.attachMedia(video);
    } else {
      video.src = srcUrl;
    }
    tryPlay();  // play AFTER the source is attached (fixes the Chrome/Android tap-autoplay race)
  });
  const destroy = () => { if (activeHls) { activeHls.destroy(); activeHls = null; } };
  return { video, destroy };
}

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

  let videoTeardown = null;  // teardown function for the open video's hls.js instance
  const close = () => {
    if (videoTeardown) { videoTeardown(); videoTeardown = null; }  // stop HLS buffering
    body.innerHTML = "";  // stop playback
    modal.hidden = true;
    if (typeof opts.onClose === "function") opts.onClose();  // e.g. re-blur the source thumbnail (Epic 13 P2)
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
      open("");  // clear first and show (open() sets modal.hidden = false)
      const { video, destroy } = mountVideo(body, srcUrl, posterUrl);
      if (!video) return;
      videoTeardown = destroy;
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
