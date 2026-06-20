/* browse/reader.js — in-app Reddit reader ("inline viewing").

   Tap a saved Reddit item → a full-screen sheet with the post + a collapsible
   comment thread, instead of bouncing out to a Firefox custom tab / Relay. The
   post always renders from the already-loaded list item (zero-network, never
   blank); the comment thread loads from the cached /thread endpoint and hydrates
   on a cache miss (POST /hydrate). "Open original ↗" stays in the header for the
   cases inline can't handle (polls, crossposts, deleted threads, no reddit auth).
   Swipe-right or the system back-gesture returns to the feed.

   Spec: docs/design/inline-reddit-reader/spec.md.

   The pure collapsible-thread renderer (subtreeLen + renderThread) was generated
   by the local gemma-4-12b-coder model and held-out tested (19 cases: deeper
   nesting, nested collapse, leaf collapse, escaping, OP badge, empty) before
   inlining. Only addition over the generated form: the `c.author &&` OP guard. */

import { esc, ago, isTypingTarget } from "../core/util.js";
import { renderMarkdown } from "../core/markdown.js";
import { chIcon } from "../core/icons.js";
import * as api from "../core/api.js";
import { imageUrl, mediaType, mountVideo, playableVideoSrc } from "../core/media.js";
import { isNsfw } from "./render.js";

/* ---- collapsible comment thread (pure; local-LLM generated, verified) ---- */
export function subtreeLen(comments, i) {
  let count = 0;
  const baseDepth = comments[i].depth;
  for (let j = i + 1; j < comments.length; j++) {
    if (comments[j].depth > baseDepth) count++;
    else break;
  }
  return count;
}
export function renderThread(comments, collapsed, helpers) {
  let html = "";
  for (let i = 0; i < comments.length; i++) {
    let hidden = false;
    for (const cIdx of collapsed) {
      if (i > cIdx && i <= cIdx + subtreeLen(comments, cIdx)) { hidden = true; break; }
    }
    if (hidden) continue;
    const c = comments[i];
    const cap = Math.min(c.depth, 6);
    const isC = collapsed.has(i);
    html += '<div class="rd-cmt d' + cap + (isC ? " collapsed" : "") + '" data-ci="' + i + '">';
    html += '<button type="button" class="rd-ctoggle" data-ci="' + i + '" aria-label="' +
      (isC ? "Expand" : "Collapse") + ' thread">' + (isC ? "+" : "−") + "</button>";
    html += '<div class="rd-cmain"><div class="rd-cby">';
    html += '<span class="rd-au">u/' + helpers.esc(c.author) + "</span>";
    if (c.author && c.author === helpers.opAuthor) html += '<span class="rd-op">OP</span>';
    html += '<span class="rd-cscore">' + (+c.score || 0) + "</span>";
    html += '<span class="rd-cage">' + helpers.ago(c.created_utc) + "</span>";
    if (isC) html += '<span class="rd-hidden">' + subtreeLen(comments, i) + " replies</span>";
    html += "</div>";
    if (!isC) html += '<div class="rd-ctext">' + helpers.md(c.body) + "</div>";
    html += "</div></div>";
  }
  return html;
}

const fmtScore = (n) => {
  n = +n || 0;
  if (n < 1000) return String(n);
  const v = n / 1000;
  return (v < 10 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.round(v))) + "k";
};
// Reddit permalinks are often stored RELATIVE ("/r/sub/comments/…"); an <a href> to a
// relative path resolves against our own origin → a local 404. Absolutize before use.
const absReddit = (p) => {
  p = (p || "").trim();
  if (!p) return "";
  if (/^https?:\/\//i.test(p)) return p;
  return p.startsWith("/") ? "https://www.reddit.com" + p : p;
};

export function initReader({ onTriage, onMedia, closeSheets, onClose } = {}) {
  const $ = (s) => document.querySelector(s);
  const reader = $("#reader");
  if (!reader) return { open() {} };
  const subEl = $("#reader-sub");
  const postEl = $("#reader-post");
  const cmtsEl = $("#reader-comments");
  const ooEl = $("#reader-open-original");
  const scrollEl = reader.querySelector(".rd-scroll");

  let item = null, fullname = null, ooHref = "";
  let comments = [], collapsed = new Set(), opAuthor = "";
  let revealed = false, isOpen = false;
  let threadSort = localStorage.getItem("ch_reader_sort") || "best";
  if (!["best", "top", "new"].includes(threadSort)) threadSort = "best";
  let videoTeardown = null;    // teardown function for inline video (stops HLS buffering)
  let videoEl = null;          // the mounted <video> (also the "video is playing" flag); close pauses+resets it
  let feedScrollY = 0;         // feed scroll position captured on open; restored on close (reader-lock resets it)

  /* Stop and discard any inline video: tear down HLS, pause the element, drop its
     src so audio stops and the network fetch aborts. videoTeardown alone is a no-op
     for direct/native-HLS playback (mountVideo returns destroy:null there), so the
     pause+reset below is what actually silences those. */
  function stopInlineVideo() {
    if (videoTeardown) { videoTeardown(); videoTeardown = null; }  // stop HLS buffering
    if (videoEl) {
      try {
        videoEl.pause(); videoEl.removeAttribute("src"); videoEl.load();  // silence + abort fetch
        const wrap = videoEl.closest(".rd-video-wrap") || videoEl;
        wrap.remove();                                                    // blank the embed
      } catch (e) { /* no-op */ }
      videoEl = null;
    }
  }

  /* ---- render ---- */
  function mediaTileHtml() {
    const mt = mediaType(item);
    if (!(mt.cls === "image" || mt.cls === "gallery" || mt.cls === "video")) return "";
    const m = item.metadata || {};
    // a gallery's first full image is a crisper poster than the small reddit thumbnail (Epic 13 P2)
    const gal = (Array.isArray(m.gallery) && m.gallery.length) ? m.gallery[0] : "";
    const img = imageUrl(item) || gal || m.thumbnail;
    // video/gallery with no poster (thumbnail-less v.redd.it) still gets a glyph-only play
    // tile so it's tappable; an image with no URL has nothing to show.
    if (!img) {
      if (mt.cls === "image") return "";
      return '<button type="button" class="rd-media noimg" data-media="1" aria-label="' +
        esc(mt.label || "media") + '"><span class="rd-mglyph" aria-hidden="true">' + mt.icon +
        "</span></button>";
    }
    const blur = isNsfw(item) && !revealed;
    return '<button type="button" class="rd-media' + (blur ? " nsfw" : "") +
      '" data-media="1" aria-label="' + esc(mt.label || "media") + '">' +
      '<img src="' + esc(img) + '" alt="" loading="lazy">' +
      (mt.cls !== "image" ? '<span class="rd-mglyph" aria-hidden="true">' + mt.icon + "</span>" : "") +
      (blur ? '<span class="rd-veil">NSFW · tap to reveal</span>' : "") + "</button>";
  }
  function renderPost(post) {
    const m = item.metadata || {};
    subEl.textContent = m.subreddit ? "r/" + m.subreddit : (item.source || "reddit");
    const author = (post && post.author) || m.author || item.author || "";
    const scoreRaw = (post && Number.isFinite(post.score)) ? post.score
      : (Number.isFinite(m.score) ? m.score : null);
    const created = (post && post.created_utc) || item.created_utc || 0;
    const body = (post && post.selftext) || item.body || "";
    let h = '<h1 class="rd-ttl">' + esc(item.title || "(untitled)") + "</h1>";
    h += '<div class="rd-by">';
    if (author) h += '<span class="rd-au">u/' + esc(author) + "</span>";
    if (scoreRaw != null) h += '<span class="rd-pscore">▲ ' + fmtScore(scoreRaw) + "</span>";
    if (created) h += "<span>" + ago(created) + "</span>";
    h += "</div>";
    h += mediaTileHtml();
    if (String(body).trim()) h += '<div class="rd-body">' + renderMarkdown(body) + "</div>";
    h += '<span class="rd-chip" id="reader-chip" hidden></span>';
    postEl.innerHTML = h;
  }
  function setChip(kind) {
    const chip = postEl.querySelector("#reader-chip");
    if (!chip) return;
    const map = {
      cached: ["ok", "loaded instantly"],
      hydrated: ["ok", "fetched just now"],
      archived: ["arch", "archived copy"],
    };
    const v = map[kind]; if (!v) { chip.hidden = true; return; }
    chip.className = "rd-chip " + v[0];
    chip.textContent = v[1];
    chip.hidden = false;
  }
  const commentsHead = (n) =>
    '<div class="rd-chead"><span class="rd-cn">' + n + "</span> " +
    (n === 1 ? "comment" : "comments") +
    '<select class="rd-csort" aria-label="Sort comments">' +
    ["best", "top", "new"].map((s) =>
      '<option value="' + s + '"' + (s === threadSort ? " selected" : "") + ">" + s + "</option>").join("") +
    "</select></div>";
  function renderComments() {
    cmtsEl.innerHTML = commentsHead(comments.length) +
      (comments.length
        ? renderThread(comments, collapsed, { esc, md: renderMarkdown, ago, opAuthor })
        : '<div class="rd-cmtstate">No comments on this post.</div>');
  }
  function applyThread(res, justHydrated) {
    comments = Array.isArray(res.comments) ? res.comments : [];
    opAuthor = (res.post && res.post.author) || (item.metadata || {}).author || item.author || "";
    if (!videoEl) renderPost(res.post || null);  // don't clobber a playing inline video
    setChip(res.archived ? "archived" : (justHydrated ? "hydrated" : "cached"));
    renderComments();
  }
  function failState() {
    cmtsEl.innerHTML = '<div class="rd-cmtstate err">Couldn’t load the live thread.' +
      '<a class="rd-oolink" href="' + esc(ooHref || "#") + '" target="_blank" rel="noopener">' +
      "Open original ↗</a></div>";
  }
  async function load() {
    const fn = fullname;
    cmtsEl.innerHTML = '<div class="rd-cmtstate">loading thread…</div>';
    let res;
    try { res = await api.getJSON("/reddit/items/" + encodeURIComponent(fn) + "/thread?sort=" + threadSort); }
    catch (e) { if (fullname === fn) failState(); return; }
    if (fullname !== fn) return;                       // closed / switched mid-fetch
    if (res && res.cached) { applyThread(res, false); return; }
    cmtsEl.innerHTML = '<div class="rd-cmtstate">fetching the live thread…</div>';
    try { await api.postJSON("/reddit/items/" + encodeURIComponent(fn) + "/hydrate", {}); }
    catch (e) { if (fullname === fn) failState(); return; }   // 401 no-auth, 502 network, …
    if (fullname !== fn) return;
    try { res = await api.getJSON("/reddit/items/" + encodeURIComponent(fn) + "/thread?sort=" + threadSort); }
    catch (e) { if (fullname === fn) failState(); return; }
    if (fullname !== fn) return;
    if (res && res.cached) applyThread(res, true); else failState();
  }

  /* ---- open / close (+ history so the system back-gesture returns to feed) ---- */
  function openReader(it) {
    if (typeof closeSheets === "function") closeSheets();
    stopInlineVideo();                 // defensive: clear any leftover inline video if reopened without a clean close
    item = it; fullname = it.fullname;
    comments = []; collapsed = new Set(); opAuthor = ""; revealed = false;
    ooHref = absReddit(it.metadata && it.metadata.permalink) || it.url || "";
    if (ooEl) ooEl.href = ooHref || "#";
    renderPost(null);                                 // instant, from the list item
    reader.style.transition = ""; reader.style.transform = "";
    reader.classList.add("show");
    reader.setAttribute("aria-hidden", "false");
    // capture the feed scroll BEFORE the overflow:hidden lock (which resets it) so we can
    // restore the user's place on close (Epic 16 P2)
    feedScrollY = window.scrollY || document.documentElement.scrollTop || 0;
    document.documentElement.classList.add("reader-lock");
    if (scrollEl) scrollEl.scrollTop = 0;
    isOpen = true;
    try { history.pushState({ chReader: 1 }, ""); } catch (e) { /* no-op */ }
    load();
  }
  function closeReader(fromPop) {
    if (!isOpen) return;
    isOpen = false;
    stopInlineVideo();           // pause+reset+remove the <video> so audio doesn't bleed after close
    reader.classList.remove("show");
    reader.setAttribute("aria-hidden", "true");
    reader.style.transition = ""; reader.style.transform = "";
    document.documentElement.classList.remove("reader-lock");
    // restore the feed scroll the lock discarded (all close paths funnel here: button, Esc,
    // popstate/back, swipe-right, the F/A/D reader keys) — Epic 16 P2
    if (feedScrollY) window.scrollTo(0, feedScrollY);
    if (typeof onClose === "function") onClose(fullname);  // re-blur the feed thumbnail (Epic 13 P2)
    if (!fromPop) {
      try { if (history.state && history.state.chReader) history.back(); } catch (e) { /* no-op */ }
    }
  }
  window.addEventListener("popstate", () => { if (isOpen) closeReader(true); });
  document.addEventListener("keydown", (e) => {
    if (!isOpen) return;
    if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); closeReader(false); return; }
    if (isTypingTarget(e.target)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;  // let browser shortcuts (Ctrl/⌘+F/A/D, …) through
    // Mirror the foot buttons so the reader's OWN item is triaged (not the list
    // item behind it). This is a capture-phase listener, so it runs before
    // main.js's bubble keydown; stopPropagation keeps that one from double-firing.
    const k = e.key.toLowerCase();
    const status = k === "f" ? "keep" : k === "a" ? "archived" : k === "d" ? "done" : null;
    if (status) {
      e.stopPropagation(); e.preventDefault();
      const fn = fullname;
      closeReader(false);
      if (typeof onTriage === "function") onTriage(fn, status);
    }
  }, true);

  /* comment-sort selector → reload the thread in the chosen order (server sorts via ?sort) */
  cmtsEl.addEventListener("change", (e) => {
    const sel = e.target.closest(".rd-csort");
    if (!sel) return;
    threadSort = sel.value;
    localStorage.setItem("ch_reader_sort", threadSort);
    load();
  });

  /* ---- clicks: close, collapse toggle, media reveal/open ---- */
  reader.addEventListener("click", (e) => {
    if (e.target.closest("#reader-close")) { closeReader(false); return; }
    const tog = e.target.closest(".rd-ctoggle");
    if (tog) {
      const ci = +tog.dataset.ci;
      collapsed.has(ci) ? collapsed.delete(ci) : collapsed.add(ci);
      renderComments();
      return;
    }
    const med = e.target.closest(".rd-media");
    if (med) {
      if (isNsfw(item) && !revealed) {                // first tap reveals, second opens
        revealed = true; med.classList.remove("nsfw");
        const v = med.querySelector(".rd-veil"); if (v) v.remove();
        return;
      }
      /* Directly-playable video (v.redd.it/HLS or a .mp4/.webm/.mov file) plays inline.
         External "video" (YouTube, gfycat/redgifs pages, …) has no playable src, so
         playableVideoSrc() returns "" and it falls through to onMedia (lightbox /
         open-original) like images/galleries — avoids mounting a dead <video>. */
      const vsrc = playableVideoSrc(item);
      if (vsrc) {
        const m = item.metadata || {};
        const posterUrl = imageUrl(item) || m.thumbnail;
        const wrap = document.createElement("div");   // replace the tile with a video container
        wrap.className = "rd-video-wrap";
        med.replaceWith(wrap);
        const { video, destroy } = mountVideo(wrap, vsrc, posterUrl, { autoplay: true });
        videoTeardown = destroy;
        videoEl = video;
        return;
      }
      if (typeof onMedia === "function") onMedia(item);
    }
  });
  const foot = reader.querySelector(".rd-foot");
  if (foot) {
    foot.querySelectorAll(".rd-act").forEach((b) => {        // the app's own icons.js glyphs
      const a = b.dataset.act;
      b.insertAdjacentHTML("afterbegin", chIcon(a === "archived" ? "archive" : a));
    });
    foot.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]"); if (!b) return;
      const fn = fullname, status = b.dataset.act;
      closeReader(false);
      if (typeof onTriage === "function") onTriage(fn, status);
    });
  }

  /* ---- swipe-right → return to feed (Relay-style). Left-edge is left to the
         OS back-gesture, which also closes the reader via popstate. ---- */
  let sx = 0, sy = 0, dragging = false, decided = false, horizontal = false;
  reader.addEventListener("touchstart", (e) => {
    if (!isOpen || e.touches.length !== 1) { dragging = false; return; }
    const x = e.touches[0].clientX;
    if (x < 24) { dragging = false; return; }         // OS back-gesture zone
    sx = x; sy = e.touches[0].clientY;
    dragging = true; decided = false; horizontal = false;
    reader.style.transition = "none";
  }, { passive: true });
  reader.addEventListener("touchmove", (e) => {
    if (!dragging) return;
    const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
    if (!decided) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      decided = true; horizontal = Math.abs(dx) > Math.abs(dy) * 1.3;
    }
    if (!horizontal) { dragging = false; return; }     // vertical → let it scroll
    if (dx > 0) { e.preventDefault(); reader.style.transform = "translateX(" + dx + "px)"; }
  }, { passive: false });
  function endSwipe(e) {
    if (!dragging) return;
    dragging = false;
    reader.style.transition = "";
    const t = (e.changedTouches && e.changedTouches[0]) || null;
    const dx = t ? t.clientX - sx : 0;
    if (horizontal && dx > 90) closeReader(false);
    else reader.style.transform = "";
  }
  reader.addEventListener("touchend", endSwipe);
  reader.addEventListener("touchcancel", () => { dragging = false; reader.style.transition = ""; reader.style.transform = ""; });

  return { open: openReader };
}
