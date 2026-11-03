import { esc, safeUrl } from "./util.js";
import { pushOverlay, settleTop } from "./overlaynav.js";
import { toast } from "./toast.js";
import { gallerySlides, isVeiled, sharpImage } from "./veil.js";

let _archive = false;

export const setArchivePref = (on) => {
  _archive = !!on;
};

export const localUrl = (item, url) => {
  if (!_archive) return url;
  const am = (item && item.metadata && item.metadata.archived_media) || null;

  if (!am) return url;

  if (am[url]) return "/media/" + am[url];
  const vals = Object.values(am);

  return vals.length === 1 ? "/media/" + vals[0] : url;
};

export const canRecoverArchiveToday = (item) => {
  const m = (item && item.metadata) || {};

  if (!item || item.source !== "reddit" || m.media_status !== "gone") return false;

  if (m.archived_media && Object.keys(m.archived_media).length) return false;
  const urls = [];

  const mediaUrl = m.media_url?.match(/^https?:\/\//i)?.[0];

  if (mediaUrl) urls.push(m.media_url);

  if (Array.isArray(m.gallery)) urls.push(...m.gallery.filter((u) => u?.match(/^https?:\/\//i)));

  return urls.length > 0;
};

export const archiveTodayConfirmText =
  "This contacts archive.today with the original Reddit media URL for this one item.\n\n" +
  "It may be slow or blocked by Cloudflare, and the hit rate is low. " +
  "If bytes are found, content-hoarder will store them locally.\n\n" +
  "Continue?";

const _galleryThumb = (item) => {
  const m = item.metadata || {};

  if (Array.isArray(m.gallery_preview) && m.gallery_preview.length && safeUrl(m.gallery_preview[0]))
    return sharpImage(item, m.gallery_preview[0]);

  if (Array.isArray(m.gallery) && m.gallery.length && safeUrl(m.gallery[0]))
    return sharpImage(item, m.gallery[0]);

  return "";
};

const _thumbSentinel = /^(self|default|nsfw|spoiler)$/i;

const _usableThumb = (item, u) => {
  const t = sharpImage(item, u?.trim?.() || "");

  return t && !_thumbSentinel.test(t) ? safeUrl(t) : "";
};

export const thumb = (item, density) => {
  const m = item.metadata || {};

  if (density === "card" && Array.isArray(m.gallery) && m.gallery.length)
    return localUrl(item, _galleryThumb(item));
  let t = _usableThumb(item, m.thumbnail);

  if (!t && item.source === "hackernews") t = m.og_image || "";

  if (!t) t = _galleryThumb(item);

  if (!t) {
    const url = item.url || "";

    if (/\.(png|jpe?g|gif|webp)$/i.test(url)) return sharpImage(item, url);
    const yt = url.match(/(?:v=|youtu\.be\/|\/shorts\/)([\w-]{6,})/);
    t = yt ? "https://i.ytimg.com/vi/" + yt[1] + "/hqdefault.jpg" : "";
  }

  if (/i\.ytimg\.com/.test(t)) {
    const variant = density === "card" ? "maxresdefault" : "mqdefault";
    t = t.replace(/\/[a-z0-9]+default\.jpg(\?.*)?$/i, "/" + variant + ".jpg");
  }

  return localUrl(item, t);
};

export const ytFallback = (t) =>
  /i\.ytimg\.com\/vi\/[^/]+\/maxresdefault\.jpg/.test(t)
    ? " onerror=\"this.onerror=null;this.src=this.src.replace('maxresdefault','mqdefault')\""
    : "";

export const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp)(\?|#|$)/i;

export const VIDEO_EXT = /\.(mp4|webm|mov)(\?|#|$)/i;

const _directImg = (u) => IMG_EXT.test(u || "") || /i\.redd\.it\//i.test(u || "");

export const imageUrls = (item) => {
  const m = item.metadata || {};

  if (Array.isArray(m.media_urls))
    return m.media_urls.filter(_directImg).map((u) => localUrl(item, sharpImage(item, u)));

  return [];
};

export const videoUrls = (item) => {
  const m = item.metadata || {};

  if (Array.isArray(m.media_urls))
    return m.media_urls.filter((u) => VIDEO_EXT.test(u || "")).map((u) => localUrl(item, u));

  return [];
};

export const imageUrl = (item) => {
  const m = item.metadata || {};

  if (_directImg(item.url)) return localUrl(item, sharpImage(item, item.url));

  if (_directImg(m.media_url)) return localUrl(item, sharpImage(item, m.media_url));
  const imgs = imageUrls(item);

  if (imgs.length) return imgs[0];

  return m.media_type === "image" ? localUrl(item, sharpImage(item, m.media_url || "")) : "";
};

export const mediaTileKind = (item, mt, img) => {
  if (mt && (mt.cls === "image" || mt.cls === "gallery" || mt.cls === "video")) return mt;

  if (!img || !isVeiled(item)) return null;

  return { cls: "image", icon: "🖼️", label: "Image" };
};

export const mediaType = (item) => {
  if (item.kind === "comment") return { cls: "comment", icon: "💬", label: "Comment" };
  const m = item.metadata || {};

  if ((m.media_url || "").includes("v.redd.it"))
    return { cls: "video", icon: "🎬", label: "Video" };

  if (VIDEO_EXT.test(m.media_url || "")) return { cls: "video", icon: "🎬", label: "Video" };

  if (videoUrls(item).length) return { cls: "video", icon: "▶", label: "Video" };

  if ((Array.isArray(m.gallery) && m.gallery.length) || m.media_type === "gallery")
    return { cls: "gallery", icon: "🖼️", label: "Gallery" };

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

  const isSelf = !url || url.includes("reddit.com/r/") || url.includes("/comments/");

  if (isSelf) return { cls: "text", icon: "📝", label: "Text post" };

  return { cls: "link", icon: "🔗", label: "External link" };
};

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
    .replace(/^https?:\/\/([a-z0-9-]+\.)?reddit\.com/i, "https://www.redditmedia.com");

  return base + "?ref_source=embed&ref=share&embed=true&theme=dark";
};

export const hlsManifestUrl = (srcUrl) => {
  const m = (srcUrl || "").match(/https?:\/\/v\.redd\.it\/([A-Za-z0-9]+)/);

  return m ? "https://v.redd.it/" + m[1] + "/HLSPlaylist.m3u8" : "";
};

export const playableVideoSrc = (item) => {
  if (mediaType(item).cls !== "video") return "";
  const m = item.metadata || {};
  const src = m.media_url || videoUrls(item)[0] || item.url || "";
  const local = localUrl(item, src);

  if (local !== src) return local;
  const hls = hlsManifestUrl(src);

  return hls || (VIDEO_EXT.test(src) ? src : "");
};

export const isRedditVideoItem = (item) => {
  if (!item || item.source !== "reddit") return false;
  const m = item.metadata || {};
  const rv = m.reddit_video || {};
  const urls = [m.media_url, rv.fallback_url, rv.hls_url, rv.dash_url, item.url];

  return urls.some((url) => /^https?:\/\/v\.redd\.it\//i.test(String(url || "")));
};

export const videoExportUrl = (item) =>
  item && item.fullname ? "/items/" + encodeURIComponent(item.fullname) + "/video.mp4" : "";

export const videoPrepareUrl = (item) =>
  item && item.fullname ? "/items/" + encodeURIComponent(item.fullname) + "/video/prepare" : "";

export const formatVideoSize = (bytes) => {
  const size = Number(bytes) || 0;

  if (size >= 1024 * 1024 * 1024) return (size / (1024 * 1024 * 1024)).toFixed(1) + " GB";

  if (size >= 1024 * 1024) return Math.round(size / (1024 * 1024)) + " MB";

  if (size >= 1024) return Math.round(size / 1024) + " KB";

  return size + " B";
};

export const VIDEO_SHARE_FILE_LIMIT = 50 * 1024 * 1024;

const responseMessage = async (response) => {
  try {
    const value = await response.json();
    const message = value && (value.message || value.error);

    if (message) return String(message);
  } catch {}

  return "HTTP " + response.status;
};

const probeFile = () => new File([new Uint8Array(0)], "probe.mp4", { type: "video/mp4" });

const filesShareSupported = () => {
  try {
    return Boolean(
      navigator.share && navigator.canShare && navigator.canShare({ files: [probeFile()] }),
    );
  } catch {
    return false;
  }
};

const canShareFile = (file) => {
  try {
    return Boolean(navigator.share && navigator.canShare && navigator.canShare({ files: [file] }));
  } catch {
    return false;
  }
};

const shareFile = (file, title) => {
  let pending;

  try {
    pending = navigator.share({ files: [file], title: title || "Video" });
  } catch {
    return Promise.resolve("blocked");
  }

  return Promise.resolve(pending)
    .then(() => "shared")
    .catch((error) => (error && error.name === "AbortError" ? "cancelled" : "blocked"));
};

const downloadDirect = (url, filename) => {
  if (!url) return;
  const link = document.createElement("a");

  link.href = url;

  if (filename) link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
};

const abortableDelay = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();

      return;
    }

    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };

    const timer = setTimeout(done, ms);

    signal.addEventListener("abort", done, { once: true });
  });

const restoreLabel = (button) => {
  if (!button) return;
  button.disabled = false;
  button.dataset.chVideoReady = "0";
  button.textContent = button.dataset.chVideoLabel || "Share video";
};

export const resetVideoShare = (button) => {
  if (!button) return;
  button._chShareGen = (button._chShareGen || 0) + 1;

  if (button._chShare) {
    button._chShare.controller.abort();
    button._chShare = null;
  }

  button._chVideoFile = null;
  button._chVideoItem = null;
  button._chDownload = null;
  delete button.dataset.chVideoLabel;
  restoreLabel(button);
  button.textContent = "Share video";
};

const prepareVideo = async (item, state) => {
  for (;;) {
    if (state.controller.signal.aborted) return null;

    const response = await fetch(videoPrepareUrl(item), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: state.controller.signal,
    });

    if (!response.ok) throw new Error(await responseMessage(response));
    const data = await response.json();

    if (data && data.ready) return data;

    if (data && data.error) throw new Error(data.message || data.error);
    await abortableDelay(1000, state.controller.signal);
  }
};

const sharePrepared = async (item, button, generation) => {
  const file = button._chVideoFile;

  button.disabled = true;
  const outcome = canShareFile(file) ? await shareFile(file, item.title) : "unsupported";

  if (!button.isConnected || button._chShareGen !== generation) return;

  if (outcome === "shared" || outcome === "cancelled") {
    button._chVideoFile = null;
    button._chVideoItem = null;
    restoreLabel(button);

    return;
  }

  if (outcome === "unsupported") {
    button._chVideoFile = null;
    button._chVideoItem = null;
    downloadDirect(videoExportUrl(item), file.name);
    toast("Video downloaded");
    restoreLabel(button);

    return;
  }

  button.disabled = false;
};

const startDownload = (button, generation) => {
  const pending = button._chDownload;

  button._chDownload = null;

  if (!pending || button._chShareGen !== generation) return;

  downloadDirect(pending.url, pending.filename);
  toast("Downloading video");
  restoreLabel(button);
};

export async function shareVideoFile(item, button) {
  if (!button || !isRedditVideoItem(item)) return;
  const generation = button._chShareGen || 0;

  if (
    button._chVideoFile &&
    button._chVideoItem === item.fullname &&
    button._chVideoGen === generation
  ) {
    await sharePrepared(item, button, generation);

    return;
  }

  if (button._chDownload && button._chDownload.fullname === item.fullname) {
    startDownload(button, generation);

    return;
  }

  if (button._chShare) button._chShare.controller.abort();
  const state = { controller: new AbortController() };

  button._chShare = state;
  button._chVideoFile = null;
  button._chVideoItem = null;
  button._chDownload = null;
  button.disabled = true;
  button.dataset.chVideoReady = "0";
  button.textContent = "Preparing video…";

  const active = () =>
    button.isConnected && button._chShare === state && !state.controller.signal.aborted;

  const restore = () => {
    if (active()) restoreLabel(button);
  };

  try {
    const prepared = await prepareVideo(item, state);

    if (!prepared || !active()) return;

    const size = Number(prepared.size_bytes) || 0;
    const filename = prepared.filename || "reddit-video.mp4";

    button.dataset.chVideoLabel = "Share video (" + formatVideoSize(size) + ")";

    if (!filesShareSupported()) {
      downloadDirect(videoExportUrl(item), filename);
      toast("Downloading video");
      restore();

      return;
    }

    if (size > VIDEO_SHARE_FILE_LIMIT) {
      button._chDownload = {
        url: videoExportUrl(item),
        filename,
        fullname: item.fullname,
      };
      button.disabled = false;
      button.dataset.chVideoReady = "1";
      button.textContent = "Download (" + formatVideoSize(size) + ")";

      return;
    }

    button.textContent = "Preparing video (" + formatVideoSize(size) + ")…";
    const response = await fetch(videoExportUrl(item), { signal: state.controller.signal });

    if (!response.ok) throw new Error(await responseMessage(response));
    const blob = await response.blob();

    if (!active()) return;
    const file = new File([blob], filename, { type: "video/mp4" });
    const outcome = canShareFile(file) ? await shareFile(file, item.title) : "unsupported";

    if (!active()) return;

    if (outcome === "shared" || outcome === "cancelled") {
      restore();

      return;
    }

    if (outcome === "blocked") {
      button._chVideoFile = file;
      button._chVideoItem = item.fullname;
      button._chVideoGen = generation;
      button.disabled = false;
      button.dataset.chVideoReady = "1";
      button.textContent = "Ready — tap to share";

      return;
    }

    downloadDirect(videoExportUrl(item), filename);
    toast("Video downloaded");
    restore();
  } catch (error) {
    if (state.controller.signal.aborted || !active()) return;
    toast(error instanceof Error ? error.message : "Couldn't prepare the video");
    restore();
  }
}

export const itemCaptionText = (item, maxChars) => {
  const max = maxChars == null ? 1200 : maxChars;

  const body = String((item && item.body) || "")
    .trim()
    .replace(/\s+/g, " ");

  if (!body) return "";

  if (body.length <= max) return body;

  return body.slice(0, max).replace(/\s+\S*$/, "") + "…";
};

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
        const short = full.length > 220 ? full.slice(0, 220).replace(/\s+\S*$/, "") + "…" : full;

        textEl.textContent = short;
        btn.textContent = "Show more";
      }
    });
  });
};

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

    if (b) return b.length <= max ? b : b.slice(0, max).replace(/\s+\S*$/, "") + "…";

    if (mt.cls === "text") return "Text post — open for discussion";
  }

  if (mt.cls === "image" || mt.cls === "gallery") {
    const b = String(item.body || "")
      .trim()
      .replace(/\s+/g, " ");

    if (b) return b.length <= max ? b : b.slice(0, max).replace(/\s+\S*$/, "") + "…";
  }

  return "";
};

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
  };

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

  let activeHls = null;

  const attachHls = (Hls) => {
    if (!document.body.contains(video)) return;

    if (!Hls) {
      showFailed("player unavailable");

      return;
    }

    if (Hls.isSupported()) {
      const h = new Hls();
      activeHls = h;
      h.on(Hls.Events.ERROR, (_e, data) => {
        if (!data) return;
        lastErr = data.details || data.type || "hls error";

        if (data.fatal) {
          try {
            h.destroy();
          } catch {}

          activeHls = null;
          showFailed(lastErr);
        }
      });
      h.loadSource(hlsUrl);
      h.attachMedia(video);
      tryPlay();
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = hlsUrl;
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

let _hlsPromise = null;

const loadHls = () => {
  if (typeof window !== "undefined" && window.Hls) return Promise.resolve(window.Hls);

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

export function createLightbox(opts) {
  const modal = opts.modal?.nodeType === 1 ? opts.modal : document.querySelector(opts.modal);

  const body = opts.body?.nodeType === 1 ? opts.body : document.querySelector(opts.body);

  const onClose = opts.onClose?.bind?.(opts);
  let lockSaved = 0;
  let windowSaved = 0;
  let windowSavedDoc = 0;
  let windowSavedBody = 0;
  let bodyLock = null;

  let videoTeardown = null;
  let videoShareButton = null;
  let peekMode = false;

  let zoomScale = 1;
  let zoomImg = null;
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

  body.addEventListener("dblclick", (e) => {
    const img = e.target.closest(".media-img, .gallery-img");

    if (!img) return;
    setZoom(img, 1);
  });

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
      img.classList.add("zooming");
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

  let panX = 0,
    panY = 0;

  let dragStart = null;
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

    if (peekMode && zoomScale <= 1.001) return;

    if (img.classList.contains("gallery-img") && zoomScale <= 1.001) return;

    if (zoomScale > 1.001 && dragStart) return;
    dragStart = {
      x: e.clientX,
      y: e.clientY,
      origPanX: panX,
      origPanY: panY,
      moved: false,
      img,
      pointerId: e.pointerId,
    };
    img.classList.add("zooming");
    img.setPointerCapture(e.pointerId);
    img.style.touchAction = "none";
  });

  body.addEventListener("pointermove", (e) => {
    if (!dragStart) return;

    if (e.pointerId !== dragStart.pointerId) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;

    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragStart.moved = true;

    if (!dragStart.moved) return;

    if (e.cancelable) e.preventDefault();
    const img = dragStart.img;

    if (zoomScale > 1.001) {
      const viewport = body.getBoundingClientRect();

      const maxX = Math.max(0, (img.clientWidth * zoomScale - viewport.width) / 2);

      const maxY = Math.max(0, (img.clientHeight * zoomScale - viewport.height) / 2);

      panX = Math.max(-maxX, Math.min(maxX, dragStart.origPanX + dx));
      panY = Math.max(-maxY, Math.min(maxY, dragStart.origPanY + dy));
      applyTransform(img);
    } else {
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
      img.classList.remove("zooming");
      img.style.touchAction = "";
    }

    if (wasDrag) e.stopPropagation();

    if (zoomScale > 1.001) {
    } else if (Math.abs(panY) > DRAG_CLOSE_THRESHOLD) {
      close();
    } else {
      panX = 0;
      panY = 0;

      if (img) applyTransform(img);
    }
  });

  body.addEventListener("pointercancel", () => {
    if (!dragStart) return;
    const img = dragStart.img;
    dragStart = null;

    if (img) {
      img.classList.remove("zooming");
      img.style.touchAction = "";
    }

    panX = 0;
    panY = 0;

    if (zoomScale <= 1.001 && img) applyTransform(img);
  });

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

  const savedWindowScroll = () => windowSaved || windowSavedDoc || windowSavedBody || 0;

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

  const closeVisual = () => {
    if (modal.hidden) return;
    resetTransformState();
    peekMode = false;
    body.classList.remove("is-gallery");

    if (videoTeardown) {
      videoTeardown();
      videoTeardown = null;
    }

    resetVideoShare(videoShareButton);
    videoShareButton = null;
    body.innerHTML = "";
    modal.hidden = true;

    if (lockEl) {
      lockEl.style.overflow = "";

      if (lockSaved) lockEl.scrollTop = lockSaved;
      lockSaved = 0;
    }

    unlockPageScroll();

    if (onClose) onClose();
  };

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

  const open = (html, opts_) => {
    const alreadyOpen = !modal.hidden;
    resetTransformState();
    peekMode = !!(opts_ && opts_.peek);
    resetVideoShare(videoShareButton);
    videoShareButton = null;
    body.classList.remove("is-gallery");
    body.innerHTML = html;
    modal.hidden = false;

    if (alreadyOpen) return;
    lockPageScroll();
    pushOverlay(closeVisual);

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
    openHtml(html, opts_) {
      open(html, opts_);

      if (opts_ && opts_.peek) _attachPeekRelease();
    },
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
    openGallery(urls, previews, opts_) {
      const full = (urls || []).filter(safeUrl);

      if (!full.length) return;
      const sized = (previews || []).filter(safeUrl);
      const srcs = gallerySlides(full, sized);
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
      [...body.querySelectorAll(".gallery-img")].forEach((im) => {
        im.addEventListener("click", () => {
          if (im.dataset.full && im.src !== im.dataset.full) {
            setZoom(im, 1);
            im.src = im.dataset.full;
          }
        });
      });

      if (cap) wireCaptionToggle(body);

      if (opts_ && opts_.peek) _attachPeekRelease();
    },
    openVideo(srcUrl, posterUrl, opts_) {
      if (!safeUrl(srcUrl)) return;
      open("", opts_);
      const { video, destroy } = mountVideo(body, srcUrl, posterUrl);

      if (!video) return;
      videoTeardown = destroy;

      const shareTarget = opts_ && opts_.videoShareItem;

      if (shareTarget && isRedditVideoItem(shareTarget)) {
        const share = document.createElement("button");

        share.type = "button";
        share.className = "media-fallback media-share-video";
        share.textContent = "Share video";
        share.addEventListener("click", () => shareVideoFile(shareTarget, share));
        body.appendChild(share);
        videoShareButton = share;
      }

      if (opts_ && opts_.peek) _attachPeekRelease();
    },
  };
}

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
      row.querySelectorAll(".item-media.nsfw").forEach((el) => el.classList.remove("nsfw"));
    },
  };
}
