/* core/util.js — pure helpers shared by every v3 page.
   Consolidates the triplicated copies in app.js / triage.js / reddit.js
   (reddit's esc missed the single-quote escape — this is the full 5-char one). */

export const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/* Only http(s) or root-relative URLs are allowed in href (blocks javascript:/data: sinks). */
export const safeUrl = (u) => (/^(https?:\/\/|\/)/i.test(u || "") ? u : "");

export const debounce = (fn, ms) => {
  let t;
  return function () { clearTimeout(t); t = setTimeout(fn, ms); };
};

export const isTypingTarget = (el) => /input|select|textarea/i.test((el && el.tagName) || "");

/* Compact relative age: 42s · 5m · 3h · 2d · 4mo · 1y. */
export const ago = (ts) => {
  if (!ts) return "";
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 0) return "";
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  if (s < 2592000) return Math.floor(s / 86400) + "d";
  if (s < 31536000) return Math.floor(s / 2592000) + "mo";
  return Math.floor(s / 31536000) + "y";
};

export const fmtDate = (ts) => (ts ? new Date(ts * 1000).toLocaleDateString() : "");

export const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");

/* Removed/deleted Reddit posts — incl. admin/mod removals ("[ Removed by reddit … ]")
   and "Deleted by user", not just the bare "[removed]"/"[deleted]" placeholders. */
const _rmStart = /^\s*\[\s*(removed|deleted)/i;
const _rmPhrase = /\b(removed by (reddit|a moderator|the moderators|moderator)|deleted by user)\b/i;
export const isRemovedText = (s) => _rmStart.test(s || "") || _rmPhrase.test(s || "");
export const isRemoved = (item) => item.source === "reddit" &&
  (isRemovedText(item.body) || isRemovedText(item.title));
