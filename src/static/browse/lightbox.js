import { esc } from "../core/util.js";
import * as api from "../core/api.js";
import { toast } from "../core/toast.js";
import {
  createLightbox,
  imageUrl,
  imageUrls,
  itemCaptionHtml,
  redditUrl,
  playableVideoSrc,
  localUrl,
  canRecoverArchiveToday,
  archiveTodayConfirmText,
  setArchivePref,
  thumb,
} from "../core/media.js";
import { $, state, itemsEl } from "./shared.js";
import { reblur } from "./feed.js";
import { readerUI } from "./instances.js";

setArchivePref(state.archiveMedia);

let mediaPressStart = null;

let mediaHoldTimer = null;

let mediaPeeking = false;

let suppressMediaClick = false;

let suppressMediaClickTimer = null;

const MEDIA_HOLD_DELAY = 250;

const MEDIA_PRESS_SLOP = 10;

function armMediaClickSuppress() {
  suppressMediaClick = true;
  clearTimeout(suppressMediaClickTimer);
  suppressMediaClickTimer = setTimeout(() => {
    suppressMediaClick = false;
    suppressMediaClickTimer = null;
  }, 700);
}

function clearMediaHold() {
  if (mediaHoldTimer !== null) {
    clearTimeout(mediaHoldTimer);
    mediaHoldTimer = null;
  }
}

itemsEl.addEventListener("pointerdown", (e) => {
  const media = e.target.closest("[data-media]");

  if (!media) return;

  if (e.pointerType === "mouse" && e.button !== 0) return;
  const fn = media.closest("[data-fullname]")?.dataset.fullname;

  if (!fn) return;
  mediaPressStart = {
    id: e.pointerId,
    x: e.clientX,
    y: e.clientY,
    t: performance.now(),
    fn,
  };
  clearMediaHold();
  mediaHoldTimer = setTimeout(() => {
    mediaHoldTimer = null;

    if (!mediaPressStart || mediaPressStart.id !== e.pointerId) return;
    const item = state.items.find((it) => it.fullname === fn);

    if (!item) return;
    mediaPeeking = true;
    armMediaClickSuppress();
    openMediaFor(item, { peek: true });
  }, MEDIA_HOLD_DELAY);
});

itemsEl.addEventListener("pointermove", (e) => {
  if (!mediaPressStart || e.pointerId !== mediaPressStart.id) return;

  if (Math.hypot(e.clientX - mediaPressStart.x, e.clientY - mediaPressStart.y) > MEDIA_PRESS_SLOP) {
    clearMediaHold();
    mediaPressStart = null;
  }
});

itemsEl.addEventListener("pointerup", (e) => {
  if (!mediaPressStart || e.pointerId !== mediaPressStart.id) return;
  const wasPeeking = mediaPeeking;
  clearMediaHold();
  mediaPressStart = null;

  if (wasPeeking) {
    mediaPeeking = false;
    armMediaClickSuppress();
  }
});

itemsEl.addEventListener("pointercancel", (e) => {
  if (mediaPressStart && e.pointerId === mediaPressStart.id) {
    if (mediaPeeking) armMediaClickSuppress();
    mediaPeeking = false;
    mediaPressStart = null;
  }

  clearMediaHold();
});

itemsEl.addEventListener(
  "click",
  (e) => {
    if (!suppressMediaClick || !e.target.closest("[data-media]")) return;
    suppressMediaClick = false;
    clearTimeout(suppressMediaClickTimer);
    suppressMediaClickTimer = null;
    e.stopPropagation();
    e.preventDefault();
  },
  true,
);

let lastMediaFn = null;

let mediaOpenSeq = 0;

export const lightbox = createLightbox({
  modal: "#media-modal",
  body: "#media-body",
  lockScrollEl: itemsEl,
  onClose: () => {
    mediaOpenSeq += 1;
    reblur(lastMediaFn);
  },
});

function archiveTodayPlaceholderHtml(item) {
  const m = item.metadata || {};
  const url = redditUrl(m.permalink || item.url);

  let html =
    '<p class="media-fallback">Deleted Reddit media is unavailable locally.</p>' +
    '<button class="media-fallback archive-today-btn" data-archive-today-recover="' +
    esc(item.fullname) +
    '" type="button">Recover deleted media via archive.today</button>' +
    '<p class="media-fallback media-note">Contacts archive.today with the original media URL. One item only.</p>';

  if (url)
    html +=
      '<a class="media-fallback" href="' +
      esc(url) +
      '" target="_blank" rel="noopener">Open on Reddit ↗</a>';

  return html;
}

export function openMediaFor(item, opts) {
  lastMediaFn = item.fullname;
  const m = item.metadata || {};

  const withCap = (base) => {
    const o = Object.assign({}, base || opts || {});

    if (!(opts && opts.peek)) {
      const cap = itemCaptionHtml(item);

      if (cap) o.captionHtml = cap;
    }

    return o;
  };

  if (canRecoverArchiveToday(item))
    return lightbox.openHtml(archiveTodayPlaceholderHtml(item), opts);

  if (Array.isArray(m.gallery) && m.gallery.length)
    return lightbox.openGallery(
      m.gallery.map((u) => localUrl(item, u)),
      (m.gallery_preview || []).map((u) => localUrl(item, u)),
      withCap(opts),
    );
  const imgs = imageUrls(item);

  if (imgs.length > 1) return lightbox.openGallery(imgs, imgs, withCap(opts));
  const vsrc = playableVideoSrc(item);

  if (vsrc) return lightbox.openVideo(vsrc, m.thumbnail, opts);
  const img = imageUrl(item);

  if (img && !(item.source === "reddit" && m.permalink))
    return lightbox.openImage(img, withCap(opts));

  if (m.media_type === "gallery" || /\/gallery\//i.test(item.url || "")) {
    const fallbackHtml = (msg) => {
      const url = redditUrl(m.permalink || item.url);
      const preview = thumb(item, "card") || "";

      const previewHtml = preview
        ? '<div class="media-gallery"><img class="gallery-img gallery-preview-fallback" src="' +
          esc(preview) +
          '" alt=""></div>'
        : "";

      return (
        previewHtml +
        (url
          ? '<p class="media-fallback">' +
            esc(msg || "Full gallery images unavailable (not archived).") +
            '</p><a class="media-fallback" href="' +
            esc(url) +
            '" target="_blank" rel="noopener">Open on Reddit ↗</a>'
          : '<p class="media-fallback">' + esc(msg || "Full gallery images unavailable.") + "</p>")
      );
    };

    if (opts && opts.peek) return lightbox.openHtml(fallbackHtml(), opts);
    const openSeq = ++mediaOpenSeq;
    lightbox.openHtml('<p class="media-fallback">Loading gallery from Reddit…</p>', opts);

    const stillActive = () =>
      openSeq === mediaOpenSeq && lightbox.isOpen() && lastMediaFn === item.fullname;

    (async () => {
      try {
        const res = await api.postJSON(
          "/reddit/items/" + encodeURIComponent(item.fullname) + "/hydrate-gallery",
          {},
        );

        if (!stillActive()) return;
        const gallery = (res && res.gallery) || [];

        if ((res.status === "hydrated" || res.status === "cached") && gallery.length) {
          m.gallery = gallery;
          m.gallery_preview = res.gallery_preview || [];

          if (res.thumbnail) m.thumbnail = res.thumbnail;

          if (res.media_url) m.media_url = res.media_url;

          return lightbox.openGallery(
            gallery.map((u) => localUrl(item, u)),
            (m.gallery_preview || []).map((u) => localUrl(item, u)),
            opts,
          );
        }

        lightbox.openHtml(fallbackHtml("Full gallery images unavailable."), opts);
      } catch {
        if (!stillActive()) return;
        lightbox.openHtml(fallbackHtml("Couldn’t load gallery from Reddit."), opts);
      }
    })();

    return;
  }

  if (m.permalink && item.source === "reddit") return readerUI.open(item);

  if (m.permalink) return lightbox.openMedia(m.permalink, opts);
  const url = item.url;

  if (url) window.open(url, "_blank", "noopener");
}

async function recoverArchiveTodayFromLightbox(fn, btn) {
  if (!fn || !window.confirm(archiveTodayConfirmText)) return;
  btn.disabled = true;
  btn.textContent = "checking…";

  try {
    const res = await api.recoverArchiveToday(fn, "apply");
    const media = res && res.archive_today;

    if (media && media.bytes_archived) {
      toast(
        "Recovered " +
          media.bytes_archived +
          " image" +
          (media.bytes_archived === 1 ? "" : "s") +
          ".",
      );
      const updated = await api.fetchItem(fn);
      const item = state.items.find((it) => it.fullname === fn);

      if (item && updated) Object.assign(item, updated);

      if (item && lastMediaFn === fn) openMediaFor(item);
    } else {
      btn.disabled = false;
      btn.textContent =
        media && media.result === "miss" ? "no archive.today hit" : "try archive.today later";
      toast(
        media && media.result === "miss"
          ? "No archive.today snapshot found."
          : "Archive.today did not recover media.",
      );
    }
  } catch {
    btn.disabled = false;
    btn.textContent = "Recover deleted media via archive.today";
    toast("Archive.today recovery failed.");
  }
}

const mediaBody = $("#media-body");

if (mediaBody)
  mediaBody.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-archive-today-recover]");

    if (!btn) return;
    recoverArchiveTodayFromLightbox(btn.dataset.archiveTodayRecover, btn);
  });
