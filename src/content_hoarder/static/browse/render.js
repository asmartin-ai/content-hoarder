/* browse/render.js — row/card builders for the v3 browse page.
   Layout per the locked spec (05 + 06 mockups): log rows reserve a fixed 128px
   monitor slot even when empty so the pinned action column never moves; the
   chIcon action set is status-colored at rest with key letters in tooltips. */

import { esc, ago } from "../core/util.js";
import { chIcon } from "../core/icons.js";
import {
  CH_SOURCES, srcAccent, itemUrl, metaAnchor, ageMeta, consumeMeta, tagChips, articleChip,
} from "../core/render.js";
import { thumb, ytFallback, mediaType } from "../core/media.js";

export const isNsfw = (item) => !!((item.metadata || {}).over_18);

const glyph = (item) => {
  const m = CH_SOURCES[item.source];
  return m ? (m.glyph || item.source[0]) : "?";
};

/* the F/A/D (+ X off-inbox) action cluster — tooltips carry the key letters */
const actsHtml = (status) =>
  '<div class="acts">' +
  '<button type="button" class="act k" data-act="keep" title="Keep — F" aria-label="Keep">' + chIcon("keep") + "</button>" +
  '<button type="button" class="act a" data-act="archived" title="Archive — A" aria-label="Archive">' + chIcon("archive") + "</button>" +
  '<button type="button" class="act d" data-act="done" title="Done — D" aria-label="Done">' + chIcon("done") + "</button>" +
  (status && status !== "inbox"
    ? '<button type="button" class="act x" data-act="inbox" title="Back to Inbox — X" aria-label="Back to Inbox">IN</button>'
    : "") +
  "</div>";

const underlay =
  '<div class="item-bg r"><span class="u1">&#9635; ARCHIVE</span><span class="u2">&#9193; KEEP — kept on purpose</span></div>' +
  '<div class="item-bg l">&#10005; DONE</div>';

const titleLine = (item) => {
  const url = itemUrl(item);
  const t = esc(item.title || "(untitled)");
  return url
    ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + t + "</a>"
    : t;
};

const metaHtml = (item) => {
  const m = item.metadata || {};
  const bits = [];
  if (isNsfw(item)) bits.push('<span class="nsfw-tag">NSFW</span>');
  if (m.subreddit) bits.push(metaAnchor("https://www.reddit.com/r/" + encodeURIComponent(m.subreddit), "r/" + m.subreddit));
  else if (m.channel) bits.push("<b>" + esc(m.channel) + "</b>");
  else if (item.source === "hackernews") bits.push("<b>HN</b>");
  if (Number.isFinite(m.score)) bits.push(Math.round(m.score) + " pts");
  bits.push(ageMeta(item));
  const consume = consumeMeta(item);
  const chip = articleChip(item);
  return bits.join(" · ") + (consume ? " " + consume : "") + (chip ? " " + chip : "");
};

const snippet = (item) => {
  const body = (item.body || "").trim().replace(/\s+/g, " ");
  return body ? '<div class="snippet">' + esc(body.slice(0, 140)) + "</div>" : "";
};

/* monitor: the fixed thumb slot. NSFW gets the box-constrained blur + veil. */
const monitorHtml = (item, nsfwRevealed) => {
  const t = thumb(item, "list");
  if (!t) return '<div class="monitor empty" aria-hidden="true"></div>';
  const mt = mediaType(item);
  const m = item.metadata || {};
  const blur = isNsfw(item) && !nsfwRevealed;
  const dur = item.source === "youtube" && Number.isFinite(m.duration) && m.duration > 0
    ? '<span class="dur">' + fmtDur(m.duration) + "</span>" : "";
  const badge = mt.cls === "gallery" || mt.cls === "video"
    ? '<span class="mglyph" aria-hidden="true">' + mt.icon + "</span>" : "";
  return '<button type="button" class="monitor' + (blur ? " nsfw" : "") +
    '" data-media="1" aria-label="' + esc(mt.label) + '">' +
    '<img src="' + esc(t) + '" alt="" loading="lazy"' + ytFallback(t) + ">" +
    dur + badge + (blur ? '<span class="veil">NSFW</span>' : "") + "</button>";
};

const fmtDur = (secs) => {
  const s = Math.round(secs), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? h + ":" + String(m).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0")
           : m + ":" + String(s % 60).padStart(2, "0");
};

/* ---- per-density builders ---- */

/* inline row chips: fixed-height log/ledger rows can't grow, so no expander */
const rowChips = (item, o) => tagChips(item, { curated: o.curated, max: 2, expand: false });

export const logRow = (item, opts) => {
  const o = opts || {};
  return '<div class="row' + (item.status !== "inbox" && o.view === "" ? " seen" : "") +
    '" data-fullname="' + esc(item.fullname) + '" style="--src:' + srcAccent(item.source) + '" tabindex="0">' +
    underlay +
    '<div class="item-fg">' +
    '<span class="idx"></span>' +
    '<button type="button" class="avatar" data-select="1" aria-label="Select"><span class="g">' + esc(glyph(item)) + "</span></button>" +
    '<div class="t">' +
    '<h3 class="title">' + titleLine(item) + "</h3>" +
    '<div class="meta">' + metaHtml(item) + rowChips(item, o) + "</div>" +
    snippet(item) +
    "</div>" +
    '<div class="trail">' + monitorHtml(item, o.nsfwRevealed) + actsHtml(o.view) + "</div>" +
    "</div></div>";
};

export const ledgerRow = (item, n, opts) => {
  const o = opts || {};
  const mt = mediaType(item);
  const play = (mt.cls === "video" || mt.cls === "image" || mt.cls === "gallery")
    ? '<button type="button" class="playpill" data-media="1">' + mt.icon + " view</button>" : "";
  return '<div class="row" data-fullname="' + esc(item.fullname) +
    '" style="--src:' + srcAccent(item.source) + '" tabindex="0">' +
    underlay +
    '<div class="item-fg">' +
    '<span class="idx">' + String(n).padStart(2, "0") + "</span>" +
    '<button type="button" class="avatar" data-select="1" aria-label="Select"><span class="g">' + esc(glyph(item)) + "</span></button>" +
    '<div class="t">' +
    '<h3 class="title">' + titleLine(item) + "</h3>" +
    '<div class="meta">' + metaHtml(item) + rowChips(item, o) + "</div>" +
    "</div>" +
    '<div class="trail">' + play + actsHtml(o.view) + "</div>" +
    "</div></div>";
};

export const pinCard = (item, opts) => {
  const o = opts || {};
  const t = thumb(item, "card");
  const m = item.metadata || {};
  const mt = mediaType(item);
  const blur = isNsfw(item) && !o.nsfwRevealed;
  const screen = t
    ? '<button type="button" class="screen' + (blur ? " nsfw" : "") + '" data-media="1">' +
      (item.source === "youtube" ? '<div class="bloom" style="background-image:url(\'' + esc(t) + '\')"></div>' : "") +
      '<img src="' + esc(t) + '" alt="" loading="lazy"' + ytFallback(t) + ">" +
      (Array.isArray(m.gallery) && m.gallery.length > 1
        ? '<span class="badge gallery">🖼 ' + m.gallery.length + "</span>" : "") +
      (item.source === "youtube" && Number.isFinite(m.duration) && m.duration > 0
        ? '<span class="badge dur">' + fmtDur(m.duration) + "</span>" : "") +
      (blur ? '<span class="veil">NSFW · REVEAL</span>' : "") +
      "</button>"
    : "";
  return '<article class="pin" data-fullname="' + esc(item.fullname) + '">' + screen +
    '<div class="body">' +
    '<div class="head">' +
    '<button type="button" class="avatar" data-select="1" style="--src:' + srcAccent(item.source) +
    '" aria-label="Select"><span class="g">' + esc(glyph(item)) + "</span></button>" +
    '<span class="meta">' + metaHtml(item) + "</span></div>" +
    "<h3>" + titleLine(item) + "</h3>" +
    snippet(item).replace('class="snippet"', 'class="snippet" style="display:block"') +
    '<div class="tagrow">' + tagChips(item, { curated: o.curated, max: 3 }) + actsHtml(o.view) + "</div>" +
    "</div></article>";
};

/* ---- list assembly with recency group headers (log/ledger only) ---- */

/* group on the SORTED field (arrival recency) so labels stay monotonic down the
   page — grouping on a different timestamp than the sort interleaves headers */
const groupLabel = (item, now) => {
  const ts = item.first_seen_utc || item.created_utc || 0;
  const d = (now - ts) / 86400;
  if (d < 1) return "TODAY";
  if (d < 7) return "THIS WEEK";
  if (d < 31) return "THIS MONTH";
  return "EARLIER";
};

export function listHtml(items, state, opts) {
  const o = opts || {};
  const now = Math.floor(Date.now() / 1000);
  if (state.density === "card") {
    return items.map((it) => pinCard(it, o)).join("");
  }
  const grouped = state.sort === "first_seen_utc:desc" && !state.focus;
  let html = "", last = null, n = 0;
  for (const it of items) {
    n += 1;
    if (grouped) {
      const g = groupLabel(it, now);
      if (g !== last) { html += '<div class="grouphead">' + g + "</div>"; last = g; }
    }
    html += state.density === "comfortable" ? logRow(it, o) : ledgerRow(it, n, o);
  }
  if (state.focus && items.length) {
    html = '<div class="grouphead">FOCUS BATCH — JUST THESE</div>' + html;
  }
  return html;
}

/* empty state — an invitation, not a scoreboard (locked #10) */
export const emptyHtml = (focus) =>
  '<div class="emptystate"><div class="es-mark">✓</div>' +
  "<h3>The page is clear.</h3><p>Nothing here is waiting on you.</p>" +
  '<div class="amb-acts">' +
  '<button type="button" class="ambbtn primary" id="empty-draw">' +
  (focus ? "Draw another batch" : "Draw a Focus batch") + "</button>" +
  '<button type="button" class="ambbtn" id="empty-surprise">⚄ Surprise me</button>' +
  "</div></div>";
