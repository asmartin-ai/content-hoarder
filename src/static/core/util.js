export const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export const safeUrl = (u) => (/^(https?:\/\/|\/)/i.test(u || "") ? u : "");

export const debounce = (fn, ms) => {
  let t;

  return function () {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
};

export const isTypingTarget = (el) => /input|select|textarea/i.test((el && el.tagName) || "");

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

const _rmStart = /^\s*\[\s*(removed|deleted)/i;

const _rmPhrase = /\b(removed by (reddit|a moderator|the moderators|moderator)|deleted by user)\b/i;

export const isRemovedText = (s) => _rmStart.test(s || "") || _rmPhrase.test(s || "");

export const isRemoved = (item) =>
  item.source === "reddit" && (isRemovedText(item.body) || isRemovedText(item.title));
