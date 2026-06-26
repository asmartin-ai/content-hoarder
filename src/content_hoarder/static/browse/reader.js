/* browse/reader.js — in-app thread reader ("inline viewing").

   Tap a saved Reddit or Hacker News item → a full-screen sheet with the post +
   a collapsible comment thread, instead of bouncing out to an external tab. The
   post always renders from the already-loaded list item (zero-network, never
   blank); the comment thread loads from the cached /thread endpoint and hydrates
   on a cache miss. "Open original ↗" stays in the header for the cases inline
   can't handle (polls, crossposts, deleted threads, no auth/network).
   Swipe-right or the system back-gesture returns to the feed.

   Spec: docs/design/inline-reddit-reader/spec.md.

   The pure collapsible-thread renderer (subtreeLen + renderThread) was generated
   by the local gemma-4-12b-coder model and held-out tested (19 cases: deeper
   nesting, nested collapse, leaf collapse, escaping, OP badge, empty) before
   inlining. Only addition over the generated form: the `c.author &&` OP guard. */

import { esc, ago, isTypingTarget, safeUrl } from "../core/util.js";
import { normTag, itemTags as tagsOf, suggestTags } from "../core/tags.js";
import { renderMarkdown } from "../core/markdown.js";
import { chIcon } from "../core/icons.js";
import * as api from "../core/api.js";
import { imageUrl, mediaType, mountVideo, playableVideoSrc } from "../core/media.js";
import { isNsfw } from "./render.js";
import { hnUserUrl, itemUrl, shareItem } from "../core/render.js";
import { toast } from "../core/toast.js";
import { pushOverlay, settleTop } from "../core/overlaynav.js";

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
const DELETED_BODIES = new Set(["[deleted]", "[removed]"]);

/* A comment Reddit has tombstoned — removed by a mod ("[removed]") or deleted by its author
   ("[deleted]" body, and the author is "[deleted]" too). */
export function isDeletedComment(c) {
  if (!c) return false;
  const body = String(c.body == null ? "" : c.body).trim();
  return DELETED_BODIES.has(body) || String(c.author || "") === "[deleted]";
}

/* Indices to auto-collapse on load: a deleted/removed comment that HAS replies AND whose entire
   subtree is also deleted — a fully-dead thread worth hiding. A deleted comment with ANY live
   descendant stays expanded (so the live reply remains visible); a childless deleted comment stays
   as a single line (nothing to hide). Pure → node-testable. */
export function deadThreadCollapseSet(comments) {
  const out = new Set();
  for (let i = 0; i < comments.length; i++) {
    if (!isDeletedComment(comments[i])) continue;
    const len = subtreeLen(comments, i);
    if (len === 0) continue;                       // no replies → nothing to collapse
    let allDead = true;
    for (let j = i + 1; j <= i + len; j++) {
      if (!isDeletedComment(comments[j])) { allDead = false; break; }
    }
    if (allDead) out.add(i);
  }
  return out;
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
    html += helpers.author ? helpers.author(c.author) : '<span class="rd-au">' + helpers.esc(c.author || "") + "</span>";
    if (c.author && c.author === helpers.opAuthor) html += '<span class="rd-op">OP</span>';
    html += '<span class="rd-cscore">' + (+c.score || 0) + "</span>";
    html += '<span class="rd-cage">' + helpers.ago(c.created_utc) + "</span>";
    if (isC) html += '<span class="rd-hidden">' + subtreeLen(comments, i) + " replies</span>";
    html += "</div>";
    if (!isC) html += '<div class="rd-ctext">' + helpers.md(c.body, c.media) + "</div>";
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

const decodeEntity = (ent) => {
  const e = String(ent || "");
  if (e[0] === "#") {
    const hex = e[1] && e[1].toLowerCase() === "x";
    const n = parseInt(hex ? e.slice(2) : e.slice(1), hex ? 16 : 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : "&" + e + ";";
  }
  return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" })[e] || "&" + e + ";";
};
const decodeEntities = (s) => String(s || "").replace(/&([a-zA-Z]+|#x[0-9a-fA-F]+|#\d+);/g, (_, e) => decodeEntity(e));
const stripTags = (s) => String(s || "").replace(/<[^>]*>/g, "");
const hnHref = (href) => {
  let h = decodeEntities(href || "").trim();
  if (!h) return "";
  if (/^(item|user)\?/i.test(h)) h = "https://news.ycombinator.com/" + h;
  else if (h.startsWith("/")) h = "https://news.ycombinator.com" + h;
  return safeUrl(h) || "";
};

export function hnHtmlToMarkdown(src) {
  let s = String(src == null ? "" : src);
  if (!s.trim()) return "";
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, "")
       .replace(/<style\b[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_m, _q, href, label) => {
    const text = decodeEntities(stripTags(label)).replace(/\s+/g, " ").trim();
    const url = hnHref(href);
    return url ? "[" + (text || url).replace(/[\[\]]/g, "") + "](" + url + ")" : text;
  });
  s = s.replace(/<br\s*\/?>/gi, "\n")
       .replace(/<\/p\s*>/gi, "\n\n")
       .replace(/<p\b[^>]*>/gi, "")
       .replace(/<\/?(pre|code)\b[^>]*>/gi, "`")
       .replace(/<[^>]*>/g, "");
  return decodeEntities(s).replace(/\n{3,}/g, "\n\n").trim();
}

export function renderHnHtml(src) {
  return renderMarkdown(hnHtmlToMarkdown(src), {});
}

export function normalizeThreadComments(raw, source) {
  const out = [];
  const walk = (nodes, fallbackDepth) => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (!node || typeof node !== "object") continue;
      const rawDepth = Number.isFinite(+node.depth) ? +node.depth : fallbackDepth;
      const depth = source === "hackernews" ? Math.max(0, rawDepth - 1) : rawDepth;
      const score = Number.isFinite(+node.score) ? +node.score
        : (Number.isFinite(+node.points) ? +node.points : 0);
      out.push({
        ...node,
        body: node.body != null ? node.body : (node.text != null ? node.text : ""),
        score,
        depth,
      });
      if (Array.isArray(node.children) && node.children.length) walk(node.children, rawDepth + 1);
    }
  };
  walk(raw, 0);
  return out;
}

const SOURCE_META = {
  reddit: {
    label: "Reddit",
    led: "var(--source-reddit)",
    threadPath: (fn, sort) => "/reddit/items/" + encodeURIComponent(fn) + "/thread?sort=" + sort,
    hydratePath: (fn) => "/reddit/items/" + encodeURIComponent(fn) + "/hydrate",
    originalHref: (it) => absReddit(it.metadata && it.metadata.permalink) || it.url || "",
    author: (author) => {
      const au = esc(author || "");
      return author && author !== "[deleted]"
        ? '<a class="rd-au" href="https://www.reddit.com/user/' + au +
          '" target="_blank" rel="noopener noreferrer nofollow">u/' + au + "</a>"
        : '<span class="rd-au">u/' + au + "</span>";
    },
    scoreText: (n) => "▲ " + fmtScore(n),
    bodyHtml: (body, media) => renderMarkdown(body, { media }),
  },
  hackernews: {
    label: "HN",
    led: "var(--source-hackernews)",
    threadPath: (fn, sort) => "/hackernews/items/" + encodeURIComponent(fn) + "/thread?sort=" + sort,
    hydratePath: null,
    originalHref: (it) => itemUrl(it) || it.url || "",
    author: (author) => {
      const url = hnUserUrl(author);
      const au = esc(author || "");
      return url
        ? '<a class="rd-au" href="' + esc(url) +
          '" target="_blank" rel="noopener noreferrer nofollow">' + au + "</a>"
        : '<span class="rd-au">' + au + "</span>";
    },
    scoreText: (n) => fmtScore(n) + " pts",
    bodyHtml: (body) => renderHnHtml(body),
  },
};
const sourceMeta = (it) => SOURCE_META[it && it.source] || SOURCE_META.reddit;

/* ---- manual tag editor (reader header/meta area) ----
   Mirror of the triage card editor: existing tags as removable chips + a "＋ tag"
   affordance (known vocabulary + free input), POSTed to /items/<fn>/tags, optimistic
   with revert+toast on error. Styles live in browse.css (.rd-tag*), which index.html
   loads. The pure helpers live at module scope; the stateful ones (which close over
   the reader's item/postEl) are defined inside initReader, below. */
function tagChipRowHtml(it) {
  const chips = tagsOf(it).map((t) =>
    '<button class="rd-chip-tag" type="button" data-rd-rmtag="' + esc(t) + '">' +
    esc(t) + '<span class="rd-tag-x" aria-hidden="true">✕</span></button>').join("");
  return chips + '<button class="rd-chip-tag rd-tag-add" type="button" data-rd-tagadd="1">＋ tag</button>';
}
function tagEditorHtml(it) {
  return '<div class="rd-tags" data-rd-tags="1">' +
    '<span class="rd-tags-label">tags</span>' +
    '<div class="rd-tags-body">' +
      '<div class="rd-tagrow">' + tagChipRowHtml(it) + "</div>" +
      '<div class="rd-tag-add-ui" hidden>' +
        '<input class="rd-tag-add-input" type="search" placeholder="new or existing tag" ' +
          'autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="done" ' +
          'maxlength="40" aria-label="Add a tag">' +
        '<span class="rd-tag-suggest"></span>' +
      "</div>" +
    "</div></div>";
}
let knownTags = [];        // the user's tag vocabulary, cached from /tags on first open
let knownTagsLoading = false;

export function initReader({ onTriage, onMedia, onImage, closeSheets, onClose } = {}) {
  const $ = (s) => document.querySelector(s);
  const reader = $("#reader");
  if (!reader) return { open() {} };
  const subEl = $("#reader-sub");
  const postEl = $("#reader-post");
  const cmtsEl = $("#reader-comments");
  const ooEl = $("#reader-open-original");
  const ledEl = reader.querySelector(".led");
  const scrollEl = reader.querySelector(".rd-scroll");

  let item = null, fullname = null, ooHref = "";
  let comments = [], collapsed = new Set(), opAuthor = "";
  let revealed = false, isOpen = false;
  let threadSort = localStorage.getItem("ch_reader_sort") || "best";
  if (!["best", "top", "new"].includes(threadSort)) threadSort = "best";
  let videoTeardown = null;    // teardown function for inline video (stops HLS buffering)
  let videoEl = null;          // the mounted <video> (also the "video is playing" flag); close pauses+resets it
  let feedScrollY = 0;         // feed scroll position captured on open; restored on close (reader-lock resets it)

  /* ---- manual tag editor: stateful helpers (close over item/fullname/postEl) ---- */
  function refreshReaderTagRow() {
    if (!item) return;
    const row = postEl.querySelector(".rd-tagrow");
    if (row) row.innerHTML = tagChipRowHtml(item);
  }
  function refreshAddSuggestions(inp) {
    if (!inp) return;
    const ui = inp.closest(".rd-tag-add-ui"); if (!ui) return;
    const sugg = suggestTags(knownTags, tagsOf(item), inp.value);
    const box = ui.querySelector(".rd-tag-suggest");
    box.innerHTML = sugg.length ? sugg.map((t) =>
      '<button class="rd-chip-tag rd-tag-sugg" type="button" data-rd-addtag="' + esc(t) + '">' + esc(t) + "</button>").join("")
      : (inp.value.trim() ? "" : '<span class="rd-tag-sugg-empty">type to create a new tag</span>');
  }
  function openReaderTagAdd() {
    const ui = postEl.querySelector(".rd-tag-add-ui"); if (!ui) return;
    if (!ui.hidden) { ui.hidden = true; return; }
    ui.hidden = false;
    const inp = ui.querySelector(".rd-tag-add-input");
    refreshAddSuggestions(inp);
    if (inp) inp.focus();
  }
  function collapseReaderTagAdd() {
    const ui = postEl.querySelector(".rd-tag-add-ui");
    if (ui) ui.hidden = true;
    const inp = postEl.querySelector(".rd-tag-add-input");
    if (inp) inp.value = "";
  }
  async function readerAddTag(raw) {
    if (!item) return;
    const it = item, fn = fullname;            // snapshot: openReader may swap item mid-POST
    if (!it.metadata) it.metadata = {};        // some items carry no metadata object
    const tag = normTag(raw); if (!tag) return;
    const prev = tagsOf(it).slice();
    if (prev.indexOf(tag) !== -1) return;
    it.metadata.tags = prev.concat([tag]);
    refreshReaderTagRow();                      // optimistic (item === it here)
    try {
      const res = await api.postJSON("/items/" + encodeURIComponent(fn) + "/tags", { add: [tag] });
      it.metadata.tags = Array.isArray(res.tags) ? res.tags : prev.concat([tag]);
    } catch (e) {
      it.metadata.tags = prev;                  // revert
      toast("Couldn't add tag — check connection");
    }
    if (item === it) {                          // repaint only if still showing this item
      refreshReaderTagRow();
      refreshAddSuggestions(postEl.querySelector(".rd-tag-add-input"));
    }
  }
  async function readerRemoveTag(tag) {
    if (!item) return;
    const it = item, fn = fullname;
    if (!it.metadata) it.metadata = {};
    const prev = tagsOf(it).slice();
    it.metadata.tags = prev.filter((t) => t !== tag);
    refreshReaderTagRow();
    try {
      const res = await api.postJSON("/items/" + encodeURIComponent(fn) + "/tags", { remove: [tag] });
      it.metadata.tags = Array.isArray(res.tags) ? res.tags : prev.filter((t) => t !== tag);
    } catch (e) {
      it.metadata.tags = prev;                  // revert
      toast("Couldn't remove tag — check connection");
    }
    if (item === it) refreshReaderTagRow();
  }
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
    const sm = sourceMeta(item);
    subEl.textContent = item.source === "reddit" && m.subreddit ? "r/" + m.subreddit : sm.label;
    const author = (post && post.author) || m.author || item.author || "";
    const scoreRaw = (post && Number.isFinite(post.score)) ? post.score
      : (post && Number.isFinite(post.points)) ? post.points
      : (Number.isFinite(m.score) ? m.score : null);
    const created = (post && post.created_utc) || item.created_utc || 0;
    const body = (post && (post.selftext || post.text)) || item.body || "";
    let h = '<h1 class="rd-ttl">' + esc(item.title || "(untitled)") + "</h1>";
    h += '<div class="rd-by">';
    if (author) h += sm.author(author);
    if (scoreRaw != null) h += '<span class="rd-pscore">' + sm.scoreText(scoreRaw) + "</span>";
    if (created) h += "<span>" + ago(created) + "</span>";
    h += "</div>";
    h += mediaTileHtml();
    if (String(body).trim()) h += '<div class="rd-body">' + sm.bodyHtml(body, post && post.media) + "</div>";
    h += tagEditorHtml(item);   // header/meta area (not over the media tile)
    h += '<span class="rd-chip" id="reader-chip" hidden></span>';
    // Preserve an in-progress tag add (open add-UI + typed text) across this rebuild — the
    // thread load calls renderPost again a few hundred ms after open, which would otherwise
    // wipe the editor the user is typing into. null = the add-UI was closed.
    const openUi = postEl.querySelector(".rd-tag-add-ui");
    const keep = (openUi && !openUi.hidden)
      ? ((postEl.querySelector(".rd-tag-add-input") || {}).value || "") : null;
    postEl.innerHTML = h;
    if (keep !== null) {
      const ui = postEl.querySelector(".rd-tag-add-ui");
      if (ui) {
        ui.hidden = false;
        const inp = ui.querySelector(".rd-tag-add-input");
        if (inp) { inp.value = keep; refreshAddSuggestions(inp); inp.focus(); }
      }
    }
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
        ? renderThread(comments, collapsed, {
            esc,
            author: (author) => sourceMeta(item).author(author),
            md: (body, media) => sourceMeta(item).bodyHtml(body, media),
            ago, opAuthor })
        : '<div class="rd-cmtstate">No comments on this post.</div>');
  }
  function applyThread(res, justHydrated) {
    comments = normalizeThreadComments(res.comments, item.source);
    collapsed = deadThreadCollapseSet(comments);   // auto-collapse fully-dead (deleted) threads on load
    opAuthor = (res.post && res.post.author) || (item.metadata || {}).author || item.author || "";
    if (!videoEl) renderPost(res.post || null);  // don't clobber a playing inline video
    setChip(res.archived ? "archived" : (justHydrated ? "hydrated" : "cached"));
    renderComments();
  }
  function failState() {
    const sm = sourceMeta(item);
    cmtsEl.innerHTML = '<div class="rd-cmtstate err">Couldn’t load the ' + esc(sm.label) + ' thread.' +
      '<a class="rd-oolink" href="' + esc(ooHref || "#") + '" target="_blank" rel="noopener">' +
      "Open original ↗</a></div>";
  }
  async function load() {
    const fn = fullname;
    cmtsEl.innerHTML = '<div class="rd-cmtstate">loading thread…</div>';
    const sm = sourceMeta(item);
    let res;
    try { res = await api.getJSON(sm.threadPath(fn, threadSort)); }
    catch (e) { if (fullname === fn) failState(); return; }
    if (fullname !== fn) return;                       // closed / switched mid-fetch
    if (res && res.cached) { applyThread(res, res.hydrate_status === "hydrated"); return; }
    if (!sm.hydratePath) { failState(); return; }
    cmtsEl.innerHTML = '<div class="rd-cmtstate">fetching the live thread…</div>';
    try { await api.postJSON(sm.hydratePath(fn), {}); }
    catch (e) { if (fullname === fn) failState(); return; }   // 401 no-auth, 502 network, …
    if (fullname !== fn) return;
    try { res = await api.getJSON(sm.threadPath(fn, threadSort)); }
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
    const sm = sourceMeta(it);
    reader.dataset.source = it.source || "";
    reader.setAttribute("aria-label", sm.label + " thread reader");
    if (ledEl) ledEl.style.setProperty("--reader-led", sm.led);
    if (ooEl) ooEl.setAttribute("aria-label", "Open the original on " + sm.label);
    ooHref = sm.originalHref(it);
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
    // Register with the shared overlay coordinator: OS-back closes the reader (or, if a lightbox is
    // open over it, closes the lightbox first). Mirrors the old inline pushState/popstate.
    pushOverlay(() => closeReader(true));
    load();
    // Lazy-load the tag vocabulary once so the "＋ tag" add-UI can suggest known tags.
    if (!knownTags.length && !knownTagsLoading) {
      knownTagsLoading = true;
      api.getJSON("/tags").then((d) => {
        if (d && d.tags && typeof d.tags === "object") knownTags = Object.keys(d.tags).sort();
      }).catch(() => {}).finally(() => { knownTagsLoading = false; });
    }
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
    // A manual close (button/Esc/swipe/F-A-D keys) unwinds the history entry we pushed; an OS-back
    // (fromPop) already popped it, so the coordinator handled the history side for us.
    if (!fromPop) settleTop();
  }
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

  /* ---- manual tag editor: live suggestions + Enter/Esc on the free input ---- */
  postEl.addEventListener("input", (e) => {
    const inp = e.target.closest(".rd-tag-add-input");
    if (inp) refreshAddSuggestions(inp);
  });
  postEl.addEventListener("keydown", (e) => {
    const inp = e.target.closest(".rd-tag-add-input");
    if (!inp) return;
    if (e.key === "Enter") {
      e.preventDefault(); e.stopPropagation();
      if (normTag(inp.value)) { readerAddTag(inp.value); collapseReaderTagAdd(); }
    } else if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      collapseReaderTagAdd();
    }
  });

  /* ---- clicks: close, collapse toggle, media reveal/open ---- */
  reader.addEventListener("click", (e) => {
    if (e.target.closest("#reader-close")) { closeReader(false); return; }
    if (e.target.closest("#reader-share")) { shareItem(item); return; }
    const tog = e.target.closest(".rd-ctoggle");
    if (tog) {
      const ci = +tog.dataset.ci;
      collapsed.has(ci) ? collapsed.delete(ci) : collapsed.add(ci);
      renderComments();
      return;
    }
    // Tap ANYWHERE on a comment (byline OR body text) to collapse/expand its thread — a big tap
    // target alongside the −/+ button. Excludes links, inline images, and buttons so those keep
    // their own actions (the author link opens the profile; an md-img opens the lightbox below).
    const cmt = e.target.closest(".rd-cmt");
    if (cmt && !e.target.closest("a, .md-img, [data-img], button")) {
      const ci = +cmt.dataset.ci;
      if (!Number.isNaN(ci)) {
        collapsed.has(ci) ? collapsed.delete(ci) : collapsed.add(ci);
        renderComments();
      }
      return;
    }
    // ---- manual tag editor (POST /items/<fn>/tags) ----
    const tagRm = e.target.closest("[data-rd-rmtag]");
    if (tagRm) { readerRemoveTag(tagRm.getAttribute("data-rd-rmtag")); return; }
    const sugg = e.target.closest("[data-rd-addtag]");
    if (sugg) { e.preventDefault(); readerAddTag(sugg.getAttribute("data-rd-addtag")); collapseReaderTagAdd(); return; }
    const addBtn = e.target.closest("[data-rd-tagadd]");
    if (addBtn) { openReaderTagAdd(); return; }
    // ---- inline markdown image (comment / selftext) → open it in the lightbox ----
    const mdImg = e.target.closest(".md-img[data-img]");
    if (mdImg) {
      const src = mdImg.getAttribute("data-img");
      if (src && typeof onImage === "function") onImage(src);
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
