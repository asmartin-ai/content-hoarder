/* home/card.js — pure helpers for the Clear round card (contract §5 "Card helpers").
   Data → string; every untrusted string goes through esc(). chIcon() output is trusted
   inline SVG and is never escaped (AGENTS.md source-badge contract). */

import { esc, ago, safeUrl, isRemovedText } from "../core/util.js";
import { CH_SOURCES } from "../core/render.js";
import { chIcon } from "../core/icons.js";
import { thumb, mediaType } from "../core/media.js";

const SOURCE_LABEL = {
  reddit: "Reddit",
  youtube: "YouTube",
  hackernews: "Hacker News",
  firefox: "Firefox",
  obsidian: "Obsidian",
  keep: "Google Keep",
  twitter: "X",
};

const EXCERPT_MAX = 280;

const WORDS_PER_MIN = 230;

/* Finite numbers only; null/""/non-numeric metadata → null. */
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;

  const n = Number(v);

  return Number.isFinite(n) ? n : null;
};

/* Permalink hosts whose card already names the source: no domain hint for these. */
const PERMALINK_HOST =
  /(^|\.)(reddit\.com|redd\.it|youtube\.com|youtu\.be|news\.ycombinator\.com)$/;

/* "https://www.example.com/a" → "example.com"; "" for non-http(s) or permalink URLs. */
const linkDomain = (item) => {
  let u;

  try {
    u = new URL(String(item?.url ?? ""));
  } catch {
    return "";
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") return "";

  const host = u.hostname.replace(/^www\./, "");

  return PERMALINK_HOST.test(host) ? "" : host;
};

/* 4200 → "4.2k", 1250000 → "1.3M", 312 → "312". */
const compact = (n) => {
  const a = Math.abs(n);

  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";

  if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";

  return String(Math.round(n));
};

const plural = (n, one, many) => compact(n) + " " + (n === 1 ? one : many);

const bodyText = (item) => {
  const b = String((item && item.body) || "").trim();

  return b && !isRemovedText(b) ? b : "";
};

/* Markdown/HTML-entity noise out, whitespace collapsed. Plain text (escaped by the caller). */
const plain = (s) =>
  s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → their text
    .replace(/<[^>]+>/g, " ") // stray html tags
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x200B;|&nbsp;/gi, " ")
    .replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+[.)])\s+/gm, "") // headings, quotes, list markers
    .replace(/(\*\*|__|~~|`+)/g, "") // bold, strike, code ticks
    .replace(/(^|\s)[*_](\S)/g, "$1$2") // leading single emphasis marker
    .replace(/(\S)[*_](?=\s|$|[.,;:!?])/g, "$1") // trailing single emphasis marker
    .replace(/^\s*([-*_]\s*){3,}$/gm, " ") // horizontal rules
    .replace(/\s+/g, " ")
    .trim();

const excerpt = (item) => {
  const b = bodyText(item);

  if (!b) return "";
  const t = plain(b);

  if (t.length <= EXCERPT_MAX) return t;

  return t.slice(0, EXCERPT_MAX).replace(/\s+\S*$/, "") + "…";
};

/* Time/effort hint, or "" when the cost is unknown (plain links show their domain instead). */
export function costLabel(item) {
  const m = (item && item.metadata) || {};
  const dur = num(m.duration);

  if (item && item.source === "youtube" && dur && dur > 0) {
    if (dur < 60) return Math.round(dur) + " s clip";

    return Math.max(1, Math.round(dur / 60)) + " min video";
  }

  const mt = mediaType(item || {});
  const b = bodyText(item);

  if (b && (mt.cls === "text" || mt.cls === "link")) {
    const words = plain(b).split(" ").filter(Boolean).length;

    return Math.max(1, Math.round(words / WORDS_PER_MIN)) + " min read";
  }

  if (mt.cls === "image" || mt.cls === "gallery") return "a glance";

  if (mt.cls === "video") return "clip";

  if (mt.cls === "comment") return "comment";

  return "";
}

export function whyLine(item) {
  if (!item) return "";
  const m = item.metadata || {};
  const parts = [];
  const score = num(m.score);

  if (item.source === "reddit" && m.subreddit) parts.push("r/" + m.subreddit);
  else if (m.channel) parts.push(m.channel);
  else if (item.source === "hackernews" && score !== null)
    parts.push(plural(score, "point", "points"));

  const age = ago(item.created_utc);

  if (age) parts.push(age + " ago");

  if (item.source === "reddit") {
    if (score !== null) parts.push(plural(score, "point", "points"));
    const nc = num(m.num_comments);

    if (nc !== null) parts.push(plural(nc, "comment", "comments"));
  } else if (item.source === "hackernews") {
    const nc = num(m.descendants) ?? num(m.num_comments);

    if (nc !== null) parts.push(plural(nc, "comment", "comments"));
  }

  return parts.slice(0, 3).join(" · ");
}

const glyphHtml = (source) => {
  const s = CH_SOURCES[source] || {};
  const icon = s.icon ? chIcon(s.icon) : "";

  if (icon) return icon; // trusted inline SVG

  return esc(
    s.glyph ||
      String(source || "?")
        .charAt(0)
        .toUpperCase(),
  );
};

const cardThumb = (item) => {
  const cls = mediaType(item).cls;

  // Text posts / links / comments have no picture: their "thumb" is a link preview
  // that often 404s, so the card shows the copy alone.
  if (cls !== "image" && cls !== "gallery" && cls !== "video") return "";

  return safeUrl(thumb(item, "card") || "");
};

export function cardHtml(item) {
  const s = CH_SOURCES[item.source];
  const token = s ? s.token : "--accent";
  const label = SOURCE_LABEL[item.source] || item.source || "";
  const title = item.title || "(no title)";
  const cost = costLabel(item);
  const why = [whyLine(item), cost ? "" : linkDomain(item)].filter(Boolean).join(" · ");
  const img = cardThumb(item);
  const ex = excerpt(item);

  return (
    '<article class="card" data-fullname="' +
    esc(item.fullname) +
    '" style="--src: var(' +
    esc(token) +
    ')">' +
    '<div class="card-fg item-fg">' +
    '<p class="card-src"><span class="card-glyph" aria-hidden="true">' +
    glyphHtml(item.source) +
    "</span> " +
    esc(label) +
    "</p>" +
    '<h1 class="card-title">' +
    esc(title) +
    "</h1>" +
    (why ? '<p class="card-why">' + esc(why) + "</p>" : "") +
    (cost ? '<span class="cost">' + esc(cost) + "</span>" : "") +
    (img ? '<img class="card-thumb" src="' + esc(img) + '" alt="" loading="eager">' : "") +
    (ex ? '<p class="card-excerpt">' + esc(ex) + "</p>" : "") +
    "</div></article>"
  );
}
