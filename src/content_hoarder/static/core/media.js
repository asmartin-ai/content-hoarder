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
  return hlsManifestUrl(src) || VIDEO_EXT.test(src) ? localUrl(item, src) : "";
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

  let videoTeardown = null; // teardown function for the open video's hls.js instance

  /* ---- pinch/mouse-wheel zoom (C2) ---- */
  let zoomScale = 1;
  let zoomImg = null; // the <img> currently being zoomed (or null)
  let pinchStartDist = 0;
  let pinchStartScale = 1;

  const setZoom = (img, s) => {
    zoomScale = Math.max(1, Math.min(4, s));
    img.style.transform = `scale(${zoomScale})`;
    img.classList.toggle("zoomed", zoomScale > 1.001);
  };
  const resetZoom = () => {
    if (zoomImg) {
      setZoom(zoomImg, 1);
      zoomImg = null;
    }
  };

  // wheel — desktop. Attach on body; match .media-img or .gallery-img.
  body.addEventListener(
    "wheel",
    (e) => {
      const img = e.target.closest(".media-img, .gallery-img");
      if (!img) return;
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

  // Visual teardown only — touches NO history. The overlay coordinator calls this on an OS-back.
  const closeVisual = () => {
    if (modal.hidden) return;
    resetZoom();
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
    if (typeof opts.onClose === "function") opts.onClose(); // e.g. re-blur the source thumbnail (Epic 13 P2)
  };
  // Manual close (backdrop / Esc / close-button / public API): tear down AND unwind our history entry.
  const close = () => {
    if (modal.hidden) return;
    closeVisual();
    settleTop();
  };
  modal.addEventListener("click", (e) => {
    if (e.target === modal || e.target.closest("[data-media-close]")) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) close();
  });

  // Open over the page + register with the coordinator so the OS back-button closes the lightbox
  // (returns to the feed/inbox) instead of navigating away / exiting the PWA.
  const open = (html) => {
    body.innerHTML = html;
    modal.hidden = false;
    pushOverlay(closeVisual);
    // lock the scroll container so the browse list doesn't scroll behind the lightbox
    if (lockEl) {
      lockSaved = lockEl.scrollTop;
      lockEl.style.overflow = "hidden";
    }
  };

  return {
    close,
    /* Open arbitrary HTML in the lightbox (for caller-constructed content like a gallery
       placeholder). Registers with the overlay coordinator so OS-back closes it. */
    openHtml(html) {
      open(html);
    },
    /* Reddit permalink → redditmedia iframe (online-only; permalink is the fallback). */
    openMedia(permalink) {
      const url = redditUrl(permalink);
      if (!safeUrl(url)) return;
      open(
        '<iframe class="reddit-embed-frame" src="' +
          esc(redditEmbedUrl(permalink)) +
          '" loading="lazy"></iframe>' +
          '<a class="media-fallback" href="' +
          esc(url) +
          '" target="_blank" rel="noopener">Open on Reddit ↗</a>',
      );
    },
    /* Direct image → simple lightbox (reliable; no Reddit dependency). */
    openImage(url) {
      if (!safeUrl(url)) return;
      open(
        '<img class="media-img" src="' +
          esc(url) +
          '" alt="">' +
          '<a class="media-fallback" href="' +
          esc(url) +
          '" target="_blank" rel="noopener">Open original ↗</a>',
      );
    },
    /* Gallery → plain STACKED lightbox (restored 2026-06-22 per user pref — reverts the
       IntersectionObserver + min-height:50vh placeholder version, which felt jumpy/popped-in).
       To keep the "album extremely slow" fix (Epic 13 P2) we still stack the SIZED previews
       (~1080px), NOT the multi-MB 5000px originals, with native loading=lazy; tapping an image
       swaps it up to the full original. */
    openGallery(urls, previews) {
      const full = (urls || []).filter(safeUrl);
      if (!full.length) return;
      const sized = (previews || []).filter(safeUrl);
      const srcs = sized.length === full.length ? sized : full; // prefer the smaller sized variants
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
          " images</p>",
      );
      // tap an image → swap the sized preview up to the full original
      [...body.querySelectorAll(".gallery-img")].forEach((im) => {
        im.addEventListener("click", () => {
          if (im.dataset.full && im.src !== im.dataset.full) {
            setZoom(im, 1); // reset zoom before swapping src
            im.src = im.dataset.full;
          }
        });
      });
    },
    /* Reddit/archived video → native <video> (Epic 13:344). For v.redd.it the stored url
       has no audio, so we play the HLS manifest (audio+video) via hls.js (preferred) or
       native HLS (iOS-Safari fallback); a non-v.redd.it direct file keeps the plain
       <video src>. See mountVideo for why hls.js wins over a canPlayType check. */
    openVideo(srcUrl, posterUrl) {
      if (!safeUrl(srcUrl)) return;
      open(""); // clear first and show (open() sets modal.hidden = false)
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
