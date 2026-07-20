/* core/media.js — thumbnails, media classification, Reddit URLs, lightbox, NSFW.
   Consolidates app.js:42-126/271-278/396-446 + triage.js:54-58 + reddit.js:627-646.
   The lightbox is a factory over a modal root so any page can host one; Esc +
   backdrop close are built in (Epic 13:381). */

import { esc, safeUrl } from "./util.js";
import { pushOverlay, settleTop } from "./overlaynav.js";

/* ---- local media archive (Epic 4 P1) ----
   When the user enables the archive (settings toggle; off by default for perf/bloat), prefer the
   same-origin /media/<blob> copy for any URL we've archived (metadata.archived_media), so the feed
   + lightbox serve our bytes — survivable, cacheable, fast. setArchivePref() is called by the page
   on load + when the toggle flips; off => localUrl is a pure pass-through (zero cost). */
let _archive = false;
export const setArchivePref = (on) => {
  _archive = !!on;
};
export const localUrl = (item, url) => {
  if (!_archive) return url;
  const am = (item && item.metadata && item.metadata.archived_media) || null;
  if (!am) return url;
  if (am[url]) return "/media/" + am[url]; // exact archived match (galleries map 1:1)
  const vals = Object.values(am); // salvageable: shown URL (dead original)
  return vals.length === 1 ? "/media/" + vals[0] : url; // ≠ the archived key → use the lone blob
};

export const canRecoverArchiveToday = (item) => {
  const m = (item && item.metadata) || {};
  if (!item || item.source !== "reddit" || m.media_status !== "gone")
    return false;
  if (m.archived_media && Object.keys(m.archived_media).length) return false;
  const urls = [];
  if (typeof m.media_url === "string" && /^https?:\/\//i.test(m.media_url))
    urls.push(m.media_url);
  if (Array.isArray(m.gallery))
    urls.push(
      ...m.gallery.filter(
        (u) => typeof u === "string" && /^https?:\/\//i.test(u),
      ),
    );
  return urls.length > 0;
};

export const archiveTodayConfirmText =
  "This contacts archive.today with the original Reddit media URL for this one item.\n\n" +
  "It may be slow or blocked by Cloudflare, and the hit rate is low. " +
  "If bytes are found, content-hoarder will store them locally.\n\n" +
  "Continue?";

/* ---- thumbnails ---- */
/* density: "card" gets the crisp maxres variant (onerror-falls back to mqdefault
   via ytFallback); everything else gets the light bar-free mqdefault (~10KB). */
const _galleryThumb = (m) => {
  if (
    Array.isArray(m.gallery_preview) &&
    m.gallery_preview.length &&
    safeUrl(m.gallery_preview[0])
  )
    return m.gallery_preview[0];
  if (Array.isArray(m.gallery) && m.gallery.length && safeUrl(m.gallery[0]))
    return m.gallery[0];
  return "";
};
const _thumbSentinel = /^(self|default|nsfw|spoiler)$/i;
const _usableThumb = (u) => {
  const t = typeof u === "string" ? u.trim() : "";
  return t && !_thumbSentinel.test(t) ? safeUrl(t) : "";
};
export const thumb = (item, density) => {
  const m = item.metadata || {};
  // Card density wants a crisp preview: a gallery's first full-size image beats the small
  // (often 140px) reddit thumbnail, which upscales to a blurry placeholder in Pinboard
  // density. List/compact keep the lightweight thumbnail for scroll perf (Epic 13 P2).
  if (density === "card" && Array.isArray(m.gallery) && m.gallery.length)
    // prefer the sized ~1080px variant over the 5000px original for the feed card (Epic 13 P2),
    // and the locally-archived copy over either when present (Epic 4 P1)
    return localUrl(item, _galleryThumb(m));
  let t = _usableThumb(m.thumbnail);
  if (!t && item.source === "hackernews") t = m.og_image || ""; // article preview (Epic 15 P3)
  if (!t) t = _galleryThumb(m);
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
  return localUrl(item, t); // prefer the locally-archived copy when present (Epic 4 P1)
};

/* YouTube maxres thumbs 404 on some videos → onerror-fall-back to mqdefault. */
export const ytFallback = (t) =>
  /i\.ytimg\.com\/vi\/[^/]+\/maxresdefault\.jpg/.test(t)
    ? " onerror=\"this.onerror=null;this.src=this.src.replace('maxresdefault','mqdefault')\""
    : "";

/* Full image URL to open in a lightbox (direct images / i.redd.it), else "". */
export const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp)(\?|#|$)/i;
export const VIDEO_EXT = /\.(mp4|webm|mov)(\?|#|$)/i;
const _directImg = (u) =>
  IMG_EXT.test(u || "") || /i\.redd\.it\//i.test(u || "");
export const imageUrls = (item) => {
  const m = item.metadata || {};
  if (Array.isArray(m.media_urls))
    return m.media_urls.filter(_directImg).map((u) => localUrl(item, u));
  return [];
};
export const videoUrls = (item) => {
  const m = item.metadata || {};
  if (Array.isArray(m.media_urls))
    return m.media_urls
      .filter((u) => VIDEO_EXT.test(u || ""))
      .map((u) => localUrl(item, u));
  return [];
};
export const imageUrl = (item) => {
  const m = item.metadata || {};
  // each return prefers the locally-archived copy when present (Epic 4 P1, localUrl)
  if (_directImg(item.url)) return localUrl(item, item.url);
  // Epic 13:344 (harvested from feat/reddit-media-v13): recognize images by media_url
  // SHAPE, not the media_type label — unlocks ~25.8k i.redd.it posts stuck in the
  // reddit_media catch-all with item.url = permalink.
  if (_directImg(m.media_url)) return localUrl(item, m.media_url);
  const imgs = imageUrls(item);
  if (imgs.length) return imgs[0];
  return m.media_type === "image" ? localUrl(item, m.media_url || "") : "";
};

/* ---- media/content classification (from reddit.js — drives the Epic 13:344
   native-embed pass: galleries/video from archived metadata, no reddit iframe). */
export const mediaType = (item) => {
  if (item.kind === "comment")
    return { cls: "comment", icon: "💬", label: "Comment" };
  const m = item.metadata || {};
  // Reddit-hosted video: item.url is the permalink (→ "text" below), so the v.redd.it
  // evidence lives in metadata.media_url. Trust it directly (the archive signal the
  // url-heuristic can't see) so the row routes to openVideo (HLS) not the iframe.
  if ((m.media_url || "").includes("v.redd.it"))
    return { cls: "video", icon: "🎬", label: "Video" };
  // Direct video file in metadata.media_url (a resolved .mp4/.webm for a
  // permalink-type item whose item.url is the reddit permalink): the
  // url-heuristic below can't see it. Trust the archive signal like v.redd.it.
  if (VIDEO_EXT.test(m.media_url || ""))
    return { cls: "video", icon: "🎬", label: "Video" };
  if (videoUrls(item).length)
    return { cls: "video", icon: "▶", label: "Video" };
  if (
    (Array.isArray(m.gallery) && m.gallery.length) ||
    m.media_type === "gallery"
  )
    return { cls: "gallery", icon: "🖼️", label: "Gallery" };
  // Image evidence in metadata.media_url (harvested from feat/reddit-media-v13): the
  // ~25.8k reddit_media-catch-all posts whose item.url is the permalink, not the image.
  if (_directImg(m.media_url) || imageUrls(item).length)
    return { cls: "image", icon: "🖼️", label: "Image" };
  const url = (item.url || "").toLowerCase();
  if (
    /\.(jpg|jpeg|png|gif|webp|bmp)(\?|$)/.test(url) ||
    url.includes("i.redd.it") ||
    url.includes("i.imgur.com")
  )
    return { cls: "image", icon: "🖼️", label: "Image" };
  if (url.includes("/gallery/") || url.includes("imgur.com/a/"))
    return { cls: "gallery", icon: "🖼️", label: "Gallery" };
  if (
    /\.(mp4|webm|mov)(\?|$)/.test(url) ||
    url.includes("v.redd.it") ||
    url.includes("gfycat.com") ||
    url.includes("redgifs.com")
  )
    return { cls: "video", icon: "🎬", label: "Video" };
  if (url.includes("youtube.com") || url.includes("youtu.be"))
    return { cls: "video", icon: "🎬", label: "YouTube" };
  const isSelf =
    !url || url.includes("reddit.com/r/") || url.includes("/comments/");
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
  const base = redditUrl(permalink)
    .split("#")[0]
    .split("?")[0]
    .replace(
      /^https?:\/\/([a-z0-9-]+\.)?reddit\.com/i,
      "https://www.redditmedia.com",
    );
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
  const src = m.media_url || videoUrls(item)[0] || item.url || "";
  const local = localUrl(item, src);
  if (local !== src) return local;
  const hls = hlsManifestUrl(src);
  return hls || (VIDEO_EXT.test(src) ? src : "");
};

/* ---- #32 caption under media lightbox + #31 text blurbs ----
   Pure helpers (node-testable). Selftext lives on item.body for reddit posts. */

/** Plain caption text from an item, or "". Skips whitespace-only bodies. */
export const itemCaptionText = (item, maxChars) => {
  const max = maxChars == null ? 1200 : maxChars;
  const body = String((item && item.body) || "")
    .trim()
    .replace(/\s+/g, " ");
  if (!body) return "";
  if (body.length <= max) return body;
  return body.slice(0, max).replace(/\s+\S*$/, "") + "…";
};

/**
 * HTML block for under-image caption. Collapses long text behind "Show more".
 * Returns "" when no body. Safe for injection into lightbox (escapes text).
 */
export const itemCaptionHtml = (item, opts) => {
  const o = opts || {};
  const collapseAt = o.collapseAt == null ? 220 : o.collapseAt;
  const text = itemCaptionText(item, o.maxChars);
  if (!text) return "";
  const long = text.length > collapseAt;
  const shown = long ? text.slice(0, collapseAt).replace(/\s+\S*$/, "") + "…" : text;
  return (
    '<div class="media-caption' +
    (long ? " is-collapsible" : "") +
    '" data-full="' +
    esc(text) +
    '">' +
    '<div class="media-caption-text">' +
    esc(shown) +
    "</div>" +
    (long
      ? '<button type="button" class="media-caption-more" data-caption-more="1">Show more</button>'
      : "") +
    "</div>"
  );
};

/** Wire Show more / Show less on a caption root (lightbox body). */
export const wireCaptionToggle = (root) => {
  if (!root) return;
  root.querySelectorAll("[data-caption-more]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const box = btn.closest(".media-caption");
      if (!box) return;
      const full = box.getAttribute("data-full") || "";
      const textEl = box.querySelector(".media-caption-text");
      if (!textEl) return;
      const expanded = box.classList.toggle("is-expanded");
      if (expanded) {
        textEl.textContent = full;
        btn.textContent = "Show less";
      } else {
        const short =
          full.length > 220
            ? full.slice(0, 220).replace(/\s+\S*$/, "") + "…"
            : full;
        textEl.textContent = short;
        btn.textContent = "Show more";
      }
    });
  });
};

/**
 * #31 non-AI preview blurb for list/card rows (plain text, not HTML).
 * Comments → body; text/self posts → body or a short label; else "".
 */
export const itemPreviewBlurb = (item, maxChars) => {
  const max = maxChars == null ? 140 : maxChars;
  if (!item) return "";
  if (item.kind === "comment") {
    const b = String(item.body || "")
      .trim()
      .replace(/\s+/g, " ");
    if (!b) return "";
    return b.length <= max ? b : b.slice(0, max).replace(/\s+\S*$/, "") + "…";
  }
  const mt = mediaType(item);
  if (mt.cls === "text" || mt.cls === "link") {
    const b = String(item.body || "")
      .trim()
      .replace(/\s+/g, " ");
    if (b)
      return b.length <= max ? b : b.slice(0, max).replace(/\s+\S*$/, "") + "…";
    if (mt.cls === "text") return "Text post — open for discussion";
  }
  // Image/gallery/video with selftext: short caption teaser in the row
  if (mt.cls === "image" || mt.cls === "gallery") {
    const b = String(item.body || "")
      .trim()
      .replace(/\s+/g, " ");
    if (b)
      return b.length <= max ? b : b.slice(0, max).replace(/\s+\S*$/, "") + "…";
  }
  return "";
};

/* mountVideo(container, srcUrl, posterUrl, opts) — mount a <video> player into container.
   Handles v.redd.it HLS (hls.js preferred; native HLS as the iOS-Safari fallback) and
   plain direct video files. opts.autoplay: start playback as soon as THIS path's source is
   attached — for the hls.js path that's inside the async loader, so a synchronous play()
   by the caller would no-op (the source isn't attached yet). Returns { video, destroy }
   where video is the <video> element and destroy is a teardown function to call when done
   (clears the watchdog + stops HLS buffering). The destroy closure reads the hls instance
   at call time, not at mount time, avoiding the async leak. */
export function mountVideo(container, srcUrl, posterUrl, opts) {
  if (!safeUrl(srcUrl)) return { video: null, destroy: null };
  const autoplay = !!(opts && opts.autoplay);
  const hlsUrl = hlsManifestUrl(srcUrl);
  const poster = posterUrl && safeUrl(posterUrl) ? posterUrl : "";
  const fallbackUrl = esc(srcUrl);
  const fallbackHtml =
    '<a class="media-fallback" href="' +
    fallbackUrl +
    '" target="_blank" rel="noopener">Open original ↗</a>';

  const video = document.createElement("video");
  video.className = "media-video";
  video.controls = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("preload", "metadata");
  if (poster) video.setAttribute("poster", poster);
  const tryPlay = () => {
    if (autoplay) video.play().catch(() => {});
  }; // guard rejection (no gesture)

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

  // Replace a dead <video> (eternal spinner) with a clear escape + a short diagnostic
  // when the stream never plays — hls.js failed fatally, the host is unreachable, or native
  // HLS errored. Covers BOTH the native-HLS and hls.js paths so neither can leave the user
  // stuck on a spinner (restored from 7aa27b6/abe3b75).
  let lastErr = "";
  let watchdog = 0;
  const showFailed = (why) => {
    if (!document.body.contains(video)) return;
    clearTimeout(watchdog);
    container.innerHTML =
      '<p class="media-fallback">Couldn’t load this video' +
      (why ? " (" + esc(String(why)) + ")" : "") +
      ". " +
      '<a href="' +
      fallbackUrl +
      '" target="_blank" rel="noopener">Open on Reddit ↗</a></p>';
  };
  // Watchdog: if no frame has decoded after 14s, the spinner is dead — surface the
  // fallback with whatever the last error was (so a silent stall becomes reportable).
  watchdog = setTimeout(() => {
    if (document.body.contains(video) && video.readyState < 2)
      showFailed(lastErr || "stalled — no video data");
  }, 14000);
  const clearWatch = () => clearTimeout(watchdog);
  video.addEventListener("playing", clearWatch, { once: true });
  video.addEventListener("loadeddata", clearWatch, { once: true });
  video.addEventListener("error", () =>
    showFailed("media error " + (video.error ? video.error.code : "?")),
  );

  // Decide the HLS path. PREFER hls.js when Hls.isSupported(): Android/desktop Chrome and
  // Firefox have NO native HLS, yet video.canPlayType('application/vnd.apple.mpegurl') can
  // return "maybe" there — a false positive. Routing those to video.src = manifest produced
  // media error 4 (MEDIA_ERR_SRC_NOT_SUPPORTED) on the Pixel-6 even though the .m3u8 plays
  // fine when opened directly. Native HLS is kept ONLY as the fallback for genuine support
  // (iOS Safari, where hls.js lacks MSE). We NEVER set video.src to the bare v.redd.it
  // redirect (srcUrl) — it 302s, it isn't a playable file.
  let activeHls = null;
  const attachHls = (Hls) => {
    if (!document.body.contains(video)) return; // closed/replaced before the loader resolved
    if (!Hls) {
      showFailed("player unavailable");
      return;
    } // hls.js script failed to load
    if (Hls.isSupported()) {
      const h = new Hls();
      activeHls = h;
      h.on(Hls.Events.ERROR, (_e, data) => {
        // record every error; bail out on a fatal one
        if (!data) return;
        lastErr = data.details || data.type || "hls error";
        if (data.fatal) {
          try {
            h.destroy();
          } catch (_err) {}
          activeHls = null;
          showFailed(lastErr);
        }
      });
      h.loadSource(hlsUrl);
      h.attachMedia(video);
      tryPlay(); // play AFTER the source is attached (fixes the Chrome/Android tap-autoplay race)
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = hlsUrl; // genuine native HLS (iOS Safari)
      tryPlay();
    } else {
      showFailed("HLS not supported by this browser");
    }
  };
  if (window.Hls) attachHls(window.Hls);
  else loadHls().then(attachHls);

  const destroy = () => {
    clearWatch();
    if (activeHls) {
      activeHls.destroy();
      activeHls = null;
    }
  };
  return { video, destroy };
}

/* Lazy-load the vendored hls.js once (only when a v.redd.it video is opened on a
   browser without native HLS). Resolves to window.Hls, or null if it fails to load. */
let _hlsPromise = null;
const loadHls = () => {
  if (typeof window !== "undefined" && window.Hls)
    return Promise.resolve(window.Hls);
  if (_hlsPromise) return _hlsPromise;
  _hlsPromise = new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "/static/vendor/hls.min.js";
    s.onload = () => resolve(window.Hls || null);
    s.onerror = () => {
      _hlsPromise = null;
      resolve(null);
    };
    document.head.appendChild(s);
  });
  return _hlsPromise;
};

/* ---- lightbox ----
   createLightbox({modal, body}) — modal: the overlay element (with `hidden`),
   body: the content container inside it. Esc + backdrop-click close built in. */
export function createLightbox(opts) {
  const modal =
    typeof opts.modal === "string"
      ? document.querySelector(opts.modal)
      : opts.modal;
  const body =
    typeof opts.body === "string"
      ? document.querySelector(opts.body)
      : opts.body;
  const lockEl = opts.lockScrollEl || null; // scroll-lock target (e.g. #items); save/restore scrollY
  let lockSaved = 0;
  let windowSaved = 0;
  let windowSavedDoc = 0;
  let windowSavedBody = 0;
  let bodyLock = null;

  let videoTeardown = null; // teardown function for the open video's hls.js instance
  let peekMode = false; // hold-to-preview: stable peek, not a draggable persistent viewer

  /* ---- pinch/mouse-wheel zoom (C2) ---- */
  let zoomScale = 1;
  let zoomImg = null; // the <img> currently being zoomed (or null)
  let pinchStartDist = 0;
  let pinchStartScale = 1;

  const setZoom = (img, s) => {
    zoomScale = Math.max(1, Math.min(4, s));
    const isZoomed = zoomScale > 1.001;
    if (!isZoomed) {
      panX = 0;
      panY = 0;
    }
    modal.classList.toggle("is-zoomed", isZoomed);
    body.classList.toggle("is-zoomed", isZoomed);
    applyTransform(img);
    img.classList.toggle("zoomed", isZoomed);
  };
  const resetZoom = () => {
    if (zoomImg) {
      setZoom(zoomImg, 1);
      zoomImg = null;
    }
  };

  // wheel — desktop. Single images zoom; stacked galleries keep normal vertical scroll
  // unless the image is already zoomed (then wheel adjusts zoom like the single-image view).
  body.addEventListener(
    "wheel",
    (e) => {
      const img = e.target.closest(".media-img, .gallery-img");
      if (!img) return;
      if (img.classList.contains("gallery-img") && zoomScale <= 1.001) return;
      e.preventDefault();
      zoomImg = img;
      const cur = zoomImg.style.transform ? zoomScale : 1;
      setZoom(img, cur * Math.exp(-e.deltaY * 0.0015));
    },
    { passive: false },
  );

  // dblclick resets to 1×
  body.addEventListener("dblclick", (e) => {
    const img = e.target.closest(".media-img, .gallery-img");
    if (!img) return;
    setZoom(img, 1);
  });

  // pinch — touch. Two-finger only.
  body.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 2) return;
      const img = e.target.closest(".media-img, .gallery-img");
      if (!img) return;
      zoomImg = img;
      pinchStartDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY,
      );
      pinchStartScale = zoomScale;
      img.classList.add("zooming"); // disable transition during pinch
    },
    { passive: true },
  );
  body.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length !== 2 || !zoomImg) return;
      e.preventDefault();
      const d = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY,
      );
      setZoom(zoomImg, pinchStartScale * (d / (pinchStartDist || 1)));
    },
    { passive: false },
  );
  body.addEventListener(
    "touchend",
    (e) => {
      if (e.touches.length >= 2 || !zoomImg) return;
      zoomImg.classList.remove("zooming");
      if (zoomScale < 1.05) setZoom(zoomImg, 1);
    },
    { passive: true },
  );

  /* ---- C3: swipe-to-pan (zoomed) + swipe-far-to-close (1×) ---- */
  let panX = 0,
    panY = 0;
  let dragStart = null; // {x, y, origPanX, origPanY, moved, img, pointerId} or null
  const DRAG_CLOSE_THRESHOLD = 120;
  function applyTransform(img) {
    if (!img) return;
    img.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomScale})`;
  }
  function resetTransformState() {
    if (zoomImg) {
      zoomImg.classList.remove("zoomed", "zooming");
      zoomImg.style.transform = "";
      zoomImg.style.touchAction = "";
    }
    zoomScale = 1;
    zoomImg = null;
    panX = 0;
    panY = 0;
    dragStart = null;
    modal.classList.remove("is-zoomed");
    body.classList.remove("is-zoomed");
  }

  body.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const img = e.target.closest(".media-img, .gallery-img");
    if (!img) return;
    // A hold-to-preview peek should stay visually anchored under the finger. Persistent
    // lightboxes keep the 1× swipe-to-close gesture; peek only allows pan after zoom.
    if (peekMode && zoomScale <= 1.001) return;
    // Stacked gallery images are inside a real scroller. At 1×, a vertical swipe should
    // scroll down the album, not drag-close the lightbox as if it were a single image.
    if (img.classList.contains("gallery-img") && zoomScale <= 1.001) return;
    if (zoomScale > 1.001 && dragStart) return; // pinch owns multi-touch
    dragStart = {
      x: e.clientX,
      y: e.clientY,
      origPanX: panX,
      origPanY: panY,
      moved: false,
      img,
      pointerId: e.pointerId,
    };
    img.classList.add("zooming"); // disable transition during drag
    img.setPointerCapture(e.pointerId);
    img.style.touchAction = "none"; // claim the gesture exclusively
  });

  body.addEventListener("pointermove", (e) => {
    if (!dragStart) return;
    if (e.pointerId !== dragStart.pointerId) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragStart.moved = true;
    if (!dragStart.moved) return;
    if (e.cancelable) e.preventDefault(); // stop the browser from scrolling
    const img = dragStart.img;
    if (zoomScale > 1.001) {
      // PAN mode — clamp to the visible lightbox viewport so zoomed content never
      // slides into empty space when the rendered image is smaller than the shell.
      const viewport = body.getBoundingClientRect();
      const maxX = Math.max(
        0,
        (img.clientWidth * zoomScale - viewport.width) / 2,
      );
      const maxY = Math.max(
        0,
        (img.clientHeight * zoomScale - viewport.height) / 2,
      );
      panX = Math.max(-maxX, Math.min(maxX, dragStart.origPanX + dx));
      panY = Math.max(-maxY, Math.min(maxY, dragStart.origPanY + dy));
      applyTransform(img);
    } else {
      // 1× — vertical drag only (tracks finger for close gesture)
      panX = 0;
      panY = dy;
      applyTransform(img);
    }
  });

  body.addEventListener("pointerup", (e) => {
    if (!dragStart) return;
    if (e.pointerId !== dragStart.pointerId) return;
    const wasDrag = dragStart.moved;
    const img = dragStart.img;
    dragStart = null;
    if (img) {
      img.classList.remove("zooming"); // re-enable transition for spring-back
      img.style.touchAction = ""; // restore (falls back to CSS)
    }
    if (wasDrag) e.stopPropagation(); // suppress backdrop click
    if (zoomScale > 1.001) {
      // keep pan where clamped — no spring-back
    } else if (Math.abs(panY) > DRAG_CLOSE_THRESHOLD) {
      close(); // swipe-far-to-close
    } else {
      panX = 0;
      panY = 0;
      if (img) applyTransform(img); // spring back
    }
  });

  body.addEventListener("pointercancel", () => {
    if (!dragStart) return;
    const img = dragStart.img;
    dragStart = null;
    if (img) {
      img.classList.remove("zooming");
      img.style.touchAction = ""; // restore (falls back to CSS)
    }
    panX = 0;
    panY = 0;
    if (zoomScale <= 1.001 && img) applyTransform(img);
  });

  // Window-level release listener for peek mode. Close on pointerup only: some
  // mobile browsers emit pointercancel when the overlay appears, which made the
  // peek close immediately and the trailing click reopen it persistently.
  let _peekRelease = null;
  const _attachPeekRelease = () => {
    let fired = false;
    const release = () => {
      if (fired) return;
      fired = true;
      window.removeEventListener("pointerup", release);
      _peekRelease = null;
      close();
    };
    _peekRelease = release;
    window.addEventListener("pointerup", release);
  };
  const savedWindowScroll = () =>
    windowSaved || windowSavedDoc || windowSavedBody || 0;
  const restoreWindowScroll = (saved) => {
    if (saved == null) return;
    window.scrollTo(0, saved);
    document.documentElement.scrollTop = saved;
    document.body.scrollTop = saved;
  };
  const restoreWindowScrollSoon = (saved) => {
    restoreWindowScroll(saved);
    requestAnimationFrame(() => {
      restoreWindowScroll(saved);
      requestAnimationFrame(() => restoreWindowScroll(saved));
    });
    setTimeout(() => restoreWindowScroll(saved), 50);
    setTimeout(() => restoreWindowScroll(saved), 150);
  };
  function lockPageScroll() {
    windowSaved =
      window.scrollY ||
      window.pageYOffset ||
      document.documentElement.scrollTop ||
      document.body.scrollTop ||
      0;
    windowSavedDoc = document.documentElement.scrollTop || 0;
    windowSavedBody = document.body.scrollTop || 0;
    bodyLock = {
      position: document.body.style.position,
      top: document.body.style.top,
      left: document.body.style.left,
      right: document.body.style.right,
      width: document.body.style.width,
      overflow: document.body.style.overflow,
    };
    document.body.style.position = "fixed";
    document.body.style.top = "-" + savedWindowScroll() + "px";
    document.body.style.left = "0";
    document.body.style.right = "0";
    document.body.style.width = "100%";
    document.body.style.overflow = "hidden";
  }
  function unlockPageScroll() {
    if (!bodyLock) return;
    document.body.style.position = bodyLock.position;
    document.body.style.top = bodyLock.top;
    document.body.style.left = bodyLock.left;
    document.body.style.right = bodyLock.right;
    document.body.style.width = bodyLock.width;
    document.body.style.overflow = bodyLock.overflow;
    bodyLock = null;
    const saved = savedWindowScroll();
    windowSaved = 0;
    windowSavedDoc = 0;
    windowSavedBody = 0;
    restoreWindowScrollSoon(saved);
  }

  // Visual teardown only — touches NO history. The overlay coordinator calls this on an OS-back.
  const closeVisual = () => {
    if (modal.hidden) return;
    resetTransformState();
    peekMode = false;
    body.classList.remove("is-gallery");
    if (videoTeardown) {
      videoTeardown();
      videoTeardown = null;
    } // stop HLS buffering
    body.innerHTML = ""; // stop playback
    modal.hidden = true;
    // restore scroll on the locked element (Epic 16: lightbox scroll-lock)
    if (lockEl) {
      lockEl.style.overflow = "";
      if (lockSaved) lockEl.scrollTop = lockSaved;
      lockSaved = 0;
    }
    unlockPageScroll();
    if (typeof opts.onClose === "function") opts.onClose(); // e.g. re-blur the source thumbnail (Epic 13 P2)
  };
  // Manual close (backdrop / Esc / close-button / public API): tear down AND unwind our history entry.
  const close = () => {
    if (_peekRelease) {
      window.removeEventListener("pointerup", _peekRelease);
      _peekRelease = null;
    }
    if (modal.hidden) return;
    const savedWindow = savedWindowScroll();
    closeVisual();
    settleTop();
    restoreWindowScrollSoon(savedWindow);
  };
  modal.addEventListener("click", (e) => {
    if (e.target === modal || e.target.closest("[data-media-close]")) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) close();
  });

  // Open over the page + register with the coordinator so the OS back-button closes the lightbox
  // (returns to the feed/inbox) instead of navigating away / exiting the PWA.
  const open = (html, opts_) => {
    const alreadyOpen = !modal.hidden;
    resetTransformState();
    peekMode = !!(opts_ && opts_.peek);
    body.classList.remove("is-gallery");
    body.innerHTML = html;
    modal.hidden = false;
    if (alreadyOpen) return; // content replacement: don't push another history overlay
    lockPageScroll();
    pushOverlay(closeVisual);
    // lock the scroll container so the browse list doesn't scroll behind the lightbox
    if (lockEl) {
      lockSaved = lockEl.scrollTop;
      lockEl.style.overflow = "hidden";
    }
  };

  return {
    close,
    isOpen() {
      return !modal.hidden;
    },
    /* Open arbitrary HTML in the lightbox (for caller-constructed content like a gallery
       placeholder). Registers with the overlay coordinator so OS-back closes it. */
    openHtml(html, opts_) {
      open(html, opts_);
      if (opts_ && opts_.peek) _attachPeekRelease();
    },
    /* Reddit permalink → redditmedia iframe (online-only; permalink is the fallback). */
    openMedia(permalink, opts_) {
      const url = redditUrl(permalink);
      if (!safeUrl(url)) return;
      open(
        '<iframe class="reddit-embed-frame" src="' +
          esc(redditEmbedUrl(permalink)) +
          '" loading="lazy"></iframe>' +
          '<a class="media-fallback" href="' +
          esc(url) +
          '" target="_blank" rel="noopener">Open on Reddit ↗</a>',
        opts_,
      );
      if (opts_ && opts_.peek) _attachPeekRelease();
    },
    /* Direct image → simple lightbox (reliable; no Reddit dependency).
       opts_.captionHtml: optional caption block under the image (#32 selftext). */
    openImage(url, opts_) {
      if (!safeUrl(url)) return;
      const cap = (opts_ && opts_.captionHtml) || "";
      open(
        '<img class="media-img" src="' +
          esc(url) +
          '" alt="">' +
          '<a class="media-fallback" href="' +
          esc(url) +
          '" target="_blank" rel="noopener">Open original ↗</a>' +
          cap,
        opts_,
      );
      if (cap) wireCaptionToggle(body);
      if (opts_ && opts_.peek) _attachPeekRelease();
    },
    /* Gallery → plain STACKED lightbox (restored 2026-06-22 per user pref — reverts the
       IntersectionObserver + min-height:50vh placeholder version, which felt jumpy/popped-in).
       To keep the "album extremely slow" fix (Epic 13 P2) we still stack the SIZED previews
       (~1080px), NOT the multi-MB 5000px originals, with native loading=lazy; tapping an image
       swaps it up to the full original. */
    openGallery(urls, previews, opts_) {
      const full = (urls || []).filter(safeUrl);
      if (!full.length) return;
      const sized = (previews || []).filter(safeUrl);
      const srcs = sized.length === full.length ? sized : full; // prefer the smaller sized variants
      const cap = (opts_ && opts_.captionHtml) || "";
      open(
        '<div class="media-gallery">' +
          srcs
            .map(
              (u, i) =>
                '<img class="media-img gallery-img" loading="lazy" decoding="async" ' +
                'src="' +
                esc(u) +
                '" data-full="' +
                esc(full[i]) +
                '" alt="">',
            )
            .join("") +
          '</div><p class="media-fallback">' +
          full.length +
          " images</p>" +
          cap,
        opts_,
      );
      body.classList.add("is-gallery");
      // tap an image → swap the sized preview up to the full original
      [...body.querySelectorAll(".gallery-img")].forEach((im) => {
        im.addEventListener("click", () => {
          if (im.dataset.full && im.src !== im.dataset.full) {
            setZoom(im, 1); // reset zoom before swapping src
            im.src = im.dataset.full;
          }
        });
      });
      if (cap) wireCaptionToggle(body);
      if (opts_ && opts_.peek) _attachPeekRelease();
    },
    /* Reddit/archived video → native <video> (Epic 13:344). For v.redd.it the stored url
       has no audio, so we play the HLS manifest (audio+video) via hls.js (preferred) or
       native HLS (iOS-Safari fallback); a non-v.redd.it direct file keeps the plain
       <video src>. See mountVideo for why hls.js wins over a canPlayType check. */
    openVideo(srcUrl, posterUrl, opts_) {
      if (!safeUrl(srcUrl)) return;
      open("", opts_); // clear first and show (open() sets modal.hidden = false)
      const { video, destroy } = mountVideo(body, srcUrl, posterUrl);
      if (!video) return;
      videoTeardown = destroy;
      if (opts_ && opts_.peek) _attachPeekRelease();
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
      return (
        '<div class="item-media nsfw" data-nsfw-media="1">' +
        inner +
        '<span class="nsfw-tag">NSFW</span></div>'
      );
    },
    reveal(fullname, row) {
      revealed.add(fullname);
      if (!row) return;
      row.dataset.revealed = "1";
      row
        .querySelectorAll(".item-media.nsfw")
        .forEach((el) => el.classList.remove("nsfw"));
    },
  };
}
