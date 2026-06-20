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

/* Inline transforms on an already-escaped string. Code spans and links are stashed as
   placeholders so the later bold/italic passes can't corrupt their contents/hrefs. */
function inline(s) {
  const stash = [];
  const hold = (html) => "\x00" + (stash.push(html) - 1) + "\x00";

  // 1. inline code `code`
  s = s.replace(/`([^`\n]+)`/g, (_, c) => hold("<code>" + c + "</code>"));
  // 2. markdown links [text](url) — drop an unsafe href, keep the visible text
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    const safe = safeUrl(url);
    return safe ? hold(link(safe, text)) : text;
  });
  // 3. bare URLs (placeheld links are already invisible to this)
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (_, pre, url) => {
    const [clean, tail] = splitUrlTail(url);
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

/* Render a safe markdown subset to an HTML string. Empty/blank input → "". */
export function renderMarkdown(src) {
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
      out.push("<blockquote>" + inline(buf.join("<br>")) + "</blockquote>");
    } else if (isUl(line)) {
      const items = [];
      while (i < lines.length && isUl(lines[i])) {
        items.push("<li>" + inline(lines[i].replace(/^\s*[-*+]\s+/, "")) + "</li>"); i++;
      }
      out.push("<ul>" + items.join("") + "</ul>");
    } else if (isOl(line)) {
      const items = [];
      while (i < lines.length && isOl(lines[i])) {
        items.push("<li>" + inline(lines[i].replace(/^\s*\d+\.\s+/, "")) + "</li>"); i++;
      }
      out.push("<ol>" + items.join("") + "</ol>");
    } else {                             // paragraph: run of plain lines, \n → <br>
      const buf = [];
      while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])) {
        buf.push(lines[i]); i++;
      }
      out.push("<p>" + inline(buf.join("<br>")) + "</p>");
    }
  }
  return out.join("");
}
