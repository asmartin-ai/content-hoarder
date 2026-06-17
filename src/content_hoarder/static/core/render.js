/* core/render.js — shared HTML fragment builders (data → string, all esc-safe).
   Page-specific row/card layouts stay in each page's own files; only fragments
   used by 2+ pages live here. Sources of the consolidated copies:
   app.js:226-360/448-471 and triage.js:64-141. */

import { esc, safeUrl, ago, fmtDate } from "./util.js";
import { redditUrl } from "./media.js";

/* ---- source identity ---- */
export const CH_SOURCES = {
  reddit:     { glyph: "r/", token: "--source-reddit" },
  youtube:    { glyph: "▶",  token: "--source-youtube" },
  hackernews: { glyph: "Y",  token: "--source-hackernews" },
  obsidian:   { glyph: "◇",  token: "--source-obsidian" },
  keep:       { glyph: "✎",  token: "--source-keep" },
  firefox:    { icon: "firefox", token: "--source-firefox" },
};
export const srcAccent = (source) => {
  const m = CH_SOURCES[source];
  return m ? "var(" + m.token + ")" : "var(--accent)";
};

/* ---- canonical item links ---- */
export const hnThreadUrl = (item) => {
  const id = (item && item.source === "hackernews" && item.source_id) ? String(item.source_id).trim() : "";
  return id ? "https://news.ycombinator.com/item?id=" + encodeURIComponent(id) : "";
};
/* HN user profile (mirrors the Reddit /user/ author link). "" when no author. */
export const hnUserUrl = (author) => {
  const a = (author || "").trim();
  return a ? "https://news.ycombinator.com/user?id=" + encodeURIComponent(a) : "";
};
export const itemUrl = (item) =>
  item.source === "hackernews" ? (hnThreadUrl(item) || item.url || "")
  : item.source === "reddit" ? (redditUrl((item.metadata || {}).permalink) || item.url || "")
  : (item.url || "");

export const metaAnchor = (href, label, cls) => {
  const url = safeUrl(href);
  if (!url) return esc(label);
  return '<a class="' + (cls || "meta-link") + '" href="' + esc(url) +
    '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' + esc(label) + "</a>";
};

/* YouTube channel link when enrich captured the channel id (else "" → plain text). */
export const channelHref = (item) => {
  const m = item.metadata || {};
  return (item.source === "youtube" && m.channel_id)
    ? "https://www.youtube.com/channel/" + encodeURIComponent(m.channel_id) : "";
};

/* YouTube upload date as YYYY-MM-DD (from enrich's upload_date, else created_utc). */
export const uploadDate = (item) => {
  const m = item.metadata || {};
  if (typeof m.upload_date === "string" && /^\d{8}$/.test(m.upload_date))
    return m.upload_date.slice(0, 4) + "-" + m.upload_date.slice(4, 6) + "-" + m.upload_date.slice(6, 8);
  if (item.created_utc) return new Date(item.created_utc * 1000).toISOString().slice(0, 10);
  return "";
};

/* opts.hideSub omits the origin (subreddit/channel/playlist) when the layout
   already shows it; opts.sources is the page's id→{label} map for fallbacks. */
export const metaLine = (item, opts) => {
  const { hideSub = false } = opts || {};
  const m = item.metadata || {};
  const parts = [];
  if (item.author) {
    if (item.source === "reddit") parts.push("by " + metaAnchor("https://www.reddit.com/user/" + encodeURIComponent(item.author), item.author, "meta-link"));
    else if (item.source === "hackernews") parts.push("by " + metaAnchor(hnUserUrl(item.author), item.author, "meta-link"));
    else parts.push("by " + esc(item.author));
  }
  if (!hideSub) {
    if (m.subreddit) parts.push(metaAnchor("https://www.reddit.com/r/" + encodeURIComponent(m.subreddit), "r/" + m.subreddit, "meta-link"));
    if (m.channel) parts.push(metaAnchor(channelHref(item), m.channel, "meta-link"));
    if (m.playlist) parts.push(esc(m.playlist));
  }
  if (item.source === "youtube") { const ud = uploadDate(item); if (ud) parts.push("📅 " + ud); }
  if (item.kind) parts.push(esc(item.kind));
  if (m.category && m.category !== "unknown") parts.push("🏷 " + esc(m.category));
  if (Number.isFinite(m.score)) parts.push(Math.round(m.score) + " pts");
  return parts.join(" · ");
};

/* Posted (created_utc) / added-in-source (saved_utc) / synced (first_seen_utc),
   as a tooltip body. "Added in source" only when it's a genuine source timestamp:
   distinct from post time AND clearly before our sync. */
export const dateTitle = (item) => {
  const c = item.created_utc, s = item.saved_utc, f = item.first_seen_utc;
  const lines = [];
  if (c) lines.push("Posted: " + fmtDate(c));
  if (s && s !== c && s < f - 86400) lines.push("Added in source: " + fmtDate(s));
  if (f) lines.push("Synced here: " + fmtDate(f));
  return lines.join("\n");
};

/* Inline labeled breakdown (triage card style). */
export const datesLine = (item) => {
  const c = item.created_utc, s = item.saved_utc, f = item.first_seen_utc;
  const showSaved = s && s !== c && s < f - 86400;
  const vis = [], tip = [];
  if (c) { vis.push("posted " + ago(c)); tip.push("Posted: " + fmtDate(c)); }
  if (showSaved) { vis.push("saved " + ago(s)); tip.push("Added in source: " + fmtDate(s)); }
  if (f) { vis.push("synced " + ago(f)); tip.push("Synced here: " + fmtDate(f)); }
  if (!vis.length) return "";
  return '<div class="tcard-dates" title="' + esc(tip.join("\n")) + '">' + vis.join(" · ") + "</div>";
};

/* Posted/synced age for the meta line (visible at every density). */
export const ageMeta = (item) =>
  '<span class="m-age" title="' + esc(dateTitle(item)) + '">' +
  esc((item.created_utc ? "posted " : "synced ") + ago(item.created_utc || item.first_seen_utc)) + "</span>";

/* Time-to-consume estimate, gated on available data: YouTube duration → "N min
   watch/listen"; a text body → "N min read". Returns "" when there's no signal. */
const READ_WPM = 200;
export const consumeMeta = (item) => {
  const m = item.metadata || {};
  let mins = 0, verb = "";
  if (item.source === "youtube" && Number.isFinite(m.duration) && m.duration > 0) {
    mins = Math.max(1, Math.round(m.duration / 60));
    verb = m.category === "listenable" ? "listen" : "watch";
  } else if (item.body && item.body.trim()) {
    const words = item.body.trim().split(/\s+/).length;
    if (words >= 40) { mins = Math.max(1, Math.round(words / READ_WPM)); verb = "read"; }
  }
  if (!mins) return "";
  const amt = mins >= 60
    ? Math.floor(mins / 60) + "h" + (mins % 60 ? " " + (mins % 60) + "m" : "")
    : mins + " min";
  return '<span class="consume ' + verb + '">' + amt + " " + verb + "</span>";
};

/* Tag chips with the Epic 13:329 display strategy, implemented ONCE: enriched
   YouTube items carry ~25+ raw yt-dlp keywords in metadata.tags; never dump them.
   opts.curated — Set of curated vocabulary (FILTER_TAGS); curated tags sort first.
   opts.max — visible cap (default 3); the rest render hidden behind a
   "+M more" expander button (page CSS/JS toggles .expanded on the wrapper).
   opts.expand=false — for fixed-height rows that can't grow: no hidden chips,
   just a static "+N" marker (Epic 13: chips across all densities).
   All tags stay in metadata.tags for FTS — this is display-only. */
export const tagChips = (item, opts) => {
  const { curated = null, max = 3, expand = true } = opts || {};
  const all = (item.metadata || {}).tags || [];
  if (!all.length) return "";
  let tags = all;
  if (curated && curated.size) {
    const inSet = all.filter((t) => curated.has(t));
    const rest = all.filter((t) => !curated.has(t));
    tags = inSet.concat(rest);
  }
  const head = tags.slice(0, max);
  const tail = tags.slice(max);
  const overflow = !tail.length ? "" : expand
    ? tail.map((t) => '<button type="button" class="tag-chip tag-overflow" hidden>' + esc(t) + "</button>").join("") +
      '<button type="button" class="tag-chip tag-more" aria-expanded="false">+' + tail.length + " more</button>"
    : '<span class="tag-chip tag-rest">+' + tail.length + "</span>";
  return '<div class="tag-chips">' +
    head.map((t) => '<button type="button" class="tag-chip">' + esc(t) + "</button>").join("") +
    overflow +
    "</div>";
};

/* One delegated handler a page can install once to make the "+M more" expander
   work anywhere tagChips() rendered. */
export const wireTagExpanders = (container) => {
  container.addEventListener("click", (e) => {
    const more = e.target.closest(".tag-more");
    if (!more) return;
    e.stopPropagation();
    const open = more.getAttribute("aria-expanded") === "true";
    more.setAttribute("aria-expanded", String(!open));
    more.closest(".tag-chips").querySelectorAll(".tag-overflow").forEach((c) => { c.hidden = open; });
    more.textContent = open ? "+" + more.closest(".tag-chips").querySelectorAll(".tag-overflow").length + " more" : "less";
  });
};

/* Companion discussion threads folded onto a canonical YouTube item (Epic 11). */
export const COMP_LABEL = { reddit: "Reddit", hackernews: "Hacker News", firefox: "Firefox" };
export const companionHref = (c) => {
  let u = ((c && (c.permalink || c.url)) || "").trim();
  if (/^\/r\//i.test(u)) u = "https://www.reddit.com" + u;  // legacy relative reddit permalink
  return safeUrl(u);
};
export const companionList = (item) => {
  const list = (item.metadata || {}).companions;
  return Array.isArray(list) ? list.filter((c) => companionHref(c)) : [];
};
export const companionsHtml = (item, sources) => {
  const cs = companionList(item);
  if (!cs.length) return "";
  const links = cs.map((c) => {
    const label = COMP_LABEL[c.source] || ((sources || {})[c.source] || {}).label || c.source || "link";
    return '<a class="comp-link" href="' + esc(companionHref(c)) +
      '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' + esc(label) + " ↗</a>";
  }).join("");
  return '<div class="companions" title="Saved discussion threads for this video">' +
    '<span class="comp-lead" aria-hidden="true">💬</span>' + links + "</div>";
};
