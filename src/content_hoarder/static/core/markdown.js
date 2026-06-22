/* core/markdown.js — safe Reddit-flavoured markdown subset for the inline reader.

   Renders post self-text + comment bodies (Epic 15). Reddit bodies are markdown
   (links, bold/italic, quotes, lists, inline code, bare URLs incl. giphy); the
   reader used to print them as plain escaped text.

   XSS-safe BY CONSTRUCTION: the raw text is HTML-escaped FIRST (via core esc), then a
   small set of inline + block transforms run on the *escaped* text and only ever INSERT
   a known-safe tag set (<p>/<br>/<a>/<strong>/<em>/<code>/<pre>/<blockquote>/<ul>/<ol>/
   <li>). User text can never introduce a tag, and every <a href> is gated through
   safeUrl (http(s)/root-relative only — blocks javascript:/data: sinks). Pure +
   dependency-light so it stays node-testable like the other reader helpers. */

import { esc, safeUrl } from "./util.js";

const A_MID = '" target="_blank" rel="noopener nofollow">';

/* Peel trailing sentence punctuation / escaped quotes a bare URL shouldn't swallow
   (e.g. the ")" in "(see https://x.com)"). Keeps &amp; — it's a real query separator. */
function splitUrlTail(url) {
  let u = url, tail = "";
  const re = /(&(?:quot|#39|gt|lt);|[.,;:!?)\]}>]+)$/;
  let m;
  while ((m = re.exec(u))) {
    tail = m[0] + tail;
    u = u.slice(0, u.length - m[0].length);
  }
  return [u, tail];
}

const link = (href, text) => '<a href="' + href + A_MID + text + "</a>";

/* Hosts whose images we render INLINE (Reddit-native + the two that actually show up in comments).
   Everything else degrades to a click-through link — loading an <img> leaks the viewer's IP/referrer
   to its host, so non-allowlisted images stay opt-in. */
const IMG_HOST = /(?:^|\.)redd\.it$|(?:^|\.)redditmedia\.com$|^i\.imgur\.com$|(?:^|\.)giphy\.com$/i;
const imgHost = (u) => { try { return IMG_HOST.test(new URL(u).hostname); } catch (e) { return false; } };
const isImgExt = (u) => /\.(?:jpe?g|png|gif|webp|avif)(?:[?#]|$)/i.test(u);

/* Build an <img>. `src` + `alt` are ALREADY HTML-escaped (the renderer escapes everything up
   front; media-id URLs are esc()'d by the caller). No event attributes are ever emitted, so an
   attacker-supplied URL/alt can't introduce script — only a (host-allowlisted) image load. The
   data-img lets the reader open the same URL in the lightbox on tap. */
const imgTag = (src, alt) =>
  '<img class="md-img" loading="lazy" decoding="async" referrerpolicy="no-referrer" src="' +
  src + '" alt="' + alt + '" data-img="' + src + '">';

/* Inline transforms on an already-escaped string. Code spans and links are stashed as
   placeholders so the later bold/italic passes can't corrupt their contents/hrefs. */
function inline(s, media) {
  const stash = [];
  const hold = (html) => "\x00" + (stash.push(html) - 1) + "\x00";

  // 1. inline code `code`
  s = s.replace(/`([^`\n]+)`/g, (_, c) => hold("<code>" + c + "</code>"));
  // 2. images ![alt](target) — BEFORE links so the leading "!" isn't dropped. `target` is either a
  //    Reddit media-id (a key in `media`, e.g. native comment images / emotes / giphy) or a URL; an
  //    <img> renders only for a resolved media-id OR an allowlisted image host, else it degrades to
  //    a safe link / the alt text.
  s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_, alt, target) => {
    const m = media[target];
    const url = m ? esc(m.u) : (imgHost(target) ? (safeUrl(target) || "") : "");
    if (url) return hold(imgTag(url, alt));
    const safe = safeUrl(target);
    return safe ? hold(link(safe, alt || safe)) : alt;
  });
  // 3. markdown links [text](url) — drop an unsafe href, keep the visible text
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    const safe = safeUrl(url);
    return safe ? hold(link(safe, text)) : text;
  });
  // 4. bare URLs (placeheld code/links/images are already invisible to this). An allowlisted bare
  //    image URL renders inline; any other bare URL becomes a link.
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (_, pre, url) => {
    const [clean, tail] = splitUrlTail(url);
    if (imgHost(clean) && isImgExt(clean)) return pre + hold(imgTag(clean, "")) + tail;
    return pre + hold(link(clean, clean)) + tail;
  });
  // 4. bold then italic (bold first so **x** isn't eaten by the * italic rule)
  s = s.replace(/\*\*(\S[^*]*?)\*\*/g, "<strong>$1</strong>")
       .replace(/__(\S[^_]*?)__/g, "<strong>$1</strong>");
  s = s.replace(/\*(\S[^*]*?)\*/g, "<em>$1</em>")
       .replace(/(^|[^\w])_(\S[^_]*?)_(?!\w)/g, "$1<em>$2</em>");
  // restore stashed code/links
  return s.replace(/\x00(\d+)\x00/g, (_, i) => stash[+i]);
}

const isBlank = (l) => /^\s*$/.test(l);
const isFence = (l) => /^\s*```/.test(l);
const isQuote = (l) => /^\s*&gt;/.test(l);       // ">" is escaped to &gt; before this runs
const isUl = (l) => /^\s*[-*+]\s+/.test(l);
const isOl = (l) => /^\s*\d+\.\s+/.test(l);
const startsBlock = (l) => isFence(l) || isQuote(l) || isUl(l) || isOl(l);

/* Render a safe markdown subset to an HTML string. Empty/blank input → "".
   `opts.media` is the comment/post media map ({id: {u, kind, w, h}}) the server resolved from
   media_metadata — used to turn Reddit's native ![img](media-id) refs into inline images. */
export function renderMarkdown(src, opts) {
  const media = (opts && opts.media) || {};
  const text = String(src == null ? "" : src).replace(/\r\n?/g, "\n").trim();
  if (!text) return "";
  const lines = esc(text).split("\n");   // escape EVERYTHING up front
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    if (isFence(line)) {                 // fenced code block — no inline transforms
      const buf = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) { buf.push(lines[i]); i++; }
      i++;                               // consume the closing fence (if present)
      out.push("<pre><code>" + buf.join("\n") + "</code></pre>");
    } else if (isQuote(line)) {
      const buf = [];
      while (i < lines.length && isQuote(lines[i])) {
        buf.push(lines[i].replace(/^\s*&gt;\s?/, "")); i++;
      }
      out.push("<blockquote>" + inline(buf.join("<br>"), media) + "</blockquote>");
    } else if (isUl(line)) {
      const items = [];
      while (i < lines.length && isUl(lines[i])) {
        items.push("<li>" + inline(lines[i].replace(/^\s*[-*+]\s+/, ""), media) + "</li>"); i++;
      }
      out.push("<ul>" + items.join("") + "</ul>");
    } else if (isOl(line)) {
      const items = [];
      while (i < lines.length && isOl(lines[i])) {
        items.push("<li>" + inline(lines[i].replace(/^\s*\d+\.\s+/, ""), media) + "</li>"); i++;
      }
      out.push("<ol>" + items.join("") + "</ol>");
    } else {                             // paragraph: run of plain lines, \n → <br>
      const buf = [];
      while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])) {
        buf.push(lines[i]); i++;
      }
      out.push("<p>" + inline(buf.join("<br>"), media) + "</p>");
    }
  }
  return out.join("");
}
