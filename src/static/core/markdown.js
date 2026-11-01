import { esc, safeUrl } from "./util.js";

const A_MID = '" target="_blank" rel="noopener nofollow">';

function splitUrlTail(url) {
  let u = url,
    tail = "";

  const re = /(&(?:quot|#39|gt|lt);|[.,;:!?)\]}>]+)$/;
  let m;

  while ((m = re.exec(u))) {
    tail = m[0] + tail;
    u = u.slice(0, u.length - m[0].length);
  }

  return [u, tail];
}

const link = (href, text) => '<a href="' + href + A_MID + text + "</a>";

const IMG_HOST = /(?:^|\.)redd\.it$|(?:^|\.)redditmedia\.com$|^i\.imgur\.com$|(?:^|\.)giphy\.com$/i;

const imgHost = (u) => {
  try {
    return IMG_HOST.test(new URL(u).hostname);
  } catch {
    return false;
  }
};

const isImgExt = (u) => /\.(?:jpe?g|png|gif|webp|avif)(?:[?#]|$)/i.test(u);

const imgTag = (src, alt) =>
  '<img class="md-img" loading="lazy" decoding="async" referrerpolicy="no-referrer" src="' +
  src +
  '" alt="' +
  alt +
  '" data-img="' +
  src +
  '">';

function inline(s, media) {
  const stash = [];
  const hold = (html) => "\uE000" + (stash.push(html) - 1) + "\uE000";

  s = s.replace(/`([^`\n]+)`/g, (_, c) => hold("<code>" + c + "</code>"));
  s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_, alt, target) => {
    const m = media[target];
    const url = m ? esc(m.u) : imgHost(target) ? safeUrl(target) || "" : "";

    if (url) return hold(imgTag(url, alt));
    const safe = safeUrl(target);

    return safe ? hold(link(safe, alt || safe)) : alt;
  });
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    const safe = safeUrl(url);

    return safe ? hold(link(safe, text)) : text;
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, (_, pre, url) => {
    const [clean, tail] = splitUrlTail(url);

    if (imgHost(clean) && isImgExt(clean)) return pre + hold(imgTag(clean, "")) + tail;

    return pre + hold(link(clean, clean)) + tail;
  });
  s = s
    .replace(/\*\*(\S[^*]*?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(\S[^_]*?)__/g, "<strong>$1</strong>");
  s = s
    .replace(/\*(\S[^*]*?)\*/g, "<em>$1</em>")
    .replace(/(^|[^\w])_(\S[^_]*?)_(?!\w)/g, "$1<em>$2</em>");

  return s.replace(/\uE000(\d+)\uE000/g, (_, i) => stash[+i]);
}

const isBlank = (l) => /^\s*$/.test(l);

const isFence = (l) => /^\s*```/.test(l);

const isQuote = (l) => /^\s*&gt;/.test(l);

const isUl = (l) => /^\s*[-*+]\s+/.test(l);

const isOl = (l) => /^\s*\d+\.\s+/.test(l);

const startsBlock = (l) => isFence(l) || isQuote(l) || isUl(l) || isOl(l);

const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;

const isTableAt = (lines, i) =>
  i + 1 < lines.length && lines[i].indexOf("|") >= 0 && TABLE_SEP.test(lines[i + 1]);

const splitRow = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

export function renderMarkdown(src, opts) {
  const media = (opts && opts.media) || {};

  const text = String(src == null ? "" : src)
    .replace(/\r\n?/g, "\n")
    .trim();

  if (!text) return "";
  const lines = esc(text).split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      i++;
      continue;
    }

    if (isFence(line)) {
      const buf = [];
      i++;

      while (i < lines.length && !isFence(lines[i])) {
        buf.push(lines[i]);
        i++;
      }

      i++;
      out.push("<pre><code>" + buf.join("\n") + "</code></pre>");
    } else if (isQuote(line)) {
      const buf = [];

      while (i < lines.length && isQuote(lines[i])) {
        buf.push(lines[i].replace(/^\s*&gt;\s?/, ""));
        i++;
      }

      out.push("<blockquote>" + inline(buf.join("<br>"), media) + "</blockquote>");
    } else if (isUl(line)) {
      const items = [];

      while (i < lines.length && isUl(lines[i])) {
        items.push("<li>" + inline(lines[i].replace(/^\s*[-*+]\s+/, ""), media) + "</li>");
        i++;
      }

      out.push("<ul>" + items.join("") + "</ul>");
    } else if (isOl(line)) {
      const items = [];

      while (i < lines.length && isOl(lines[i])) {
        items.push("<li>" + inline(lines[i].replace(/^\s*\d+\.\s+/, ""), media) + "</li>");
        i++;
      }

      out.push("<ol>" + items.join("") + "</ol>");
    } else if (isTableAt(lines, i)) {
      const head = splitRow(line);
      i += 2;
      const rows = [];

      while (
        i < lines.length &&
        !isBlank(lines[i]) &&
        lines[i].indexOf("|") >= 0 &&
        !startsBlock(lines[i])
      ) {
        rows.push(splitRow(lines[i]));
        i++;
      }

      let t = '<table class="md-table"><thead><tr>';

      for (const h of head) t += "<th>" + inline(h, media) + "</th>";
      t += "</tr></thead><tbody>";

      for (const r of rows) {
        t += "<tr>";

        for (let k = 0; k < head.length; k++)
          t += "<td>" + inline(r[k] == null ? "" : r[k], media) + "</td>";
        t += "</tr>";
      }

      out.push(t + "</tbody></table>");
    } else {
      const buf = [];

      while (
        i < lines.length &&
        !isBlank(lines[i]) &&
        !startsBlock(lines[i]) &&
        !isTableAt(lines, i)
      ) {
        buf.push(lines[i]);
        i++;
      }

      out.push("<p>" + inline(buf.join("<br>"), media) + "</p>");
    }
  }

  return out.join("");
}
