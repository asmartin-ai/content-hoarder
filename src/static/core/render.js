import { esc, safeUrl, ago, fmtDate } from "./util.js";
import { redditUrl } from "./media.js";
import { toast } from "./toast.js";

export const CH_SOURCES = {
  reddit: { glyph: "r/", token: "--source-reddit" },
  youtube: { glyph: "▶", token: "--source-youtube" },
  hackernews: { glyph: "Y", token: "--source-hackernews" },
  obsidian: { glyph: "◇", token: "--source-obsidian" },
  keep: { glyph: "✎", token: "--source-keep" },
  firefox: { icon: "firefox", token: "--source-firefox" },
  twitter: { glyph: "X", token: "--source-twitter" },
  bookmarks: { glyph: "★", token: "--source-bookmarks" },
  twitch: { glyph: "◉", token: "--source-twitch" },
};

export const srcAccent = (source) => {
  const m = CH_SOURCES[source];

  return m ? "var(" + m.token + ")" : "var(--accent)";
};

export const hnThreadUrl = (item) => {
  const id =
    item && item.source === "hackernews" && item.source_id ? String(item.source_id).trim() : "";

  return id ? "https://news.ycombinator.com/item?id=" + encodeURIComponent(id) : "";
};

export const hnUserUrl = (author) => {
  const a = (author || "").trim();

  return a ? "https://news.ycombinator.com/user?id=" + encodeURIComponent(a) : "";
};

const SCRIPT_URL = /^\s*(javascript|data|vbscript):/i;

const rawItemUrl = (item) =>
  item.source === "hackernews"
    ? hnThreadUrl(item) || item.url || ""
    : item.source === "reddit"
      ? redditUrl((item.metadata || {}).permalink) || item.url || ""
      : item.url || "";

export const itemUrl = (item) => {
  const url = rawItemUrl(item);

  return SCRIPT_URL.test(url) ? "" : url;
};

export function shareItem(item) {
  if (!item) return;
  const url = itemUrl(item);

  if (!url) {
    toast("No link to share");

    return;
  }

  const data = { title: item.title || "Saved item", url };

  if (navigator.share) {
    navigator.share(data).catch(() => {});
  } else if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(url)
      .then(() => toast("Link copied"))
      .catch(() => toast("Couldn't copy link"));
  } else {
    toast(url);
  }
}

export const hnArticleUrl = (item) => {
  if (!item || item.source !== "hackernews") return "";
  const u = (item.url || "").trim();

  if (!u || /news\.ycombinator\.com\/item\?id=/i.test(u)) return "";

  return safeUrl(u) || "";
};

export const articleChip = (item) => {
  const u = hnArticleUrl(item);

  return u
    ? '<a class="comp-link art-chip" href="' +
        esc(u) +
        '" target="_blank" rel="noopener" onclick="event.stopPropagation()">Article ↗</a>'
    : "";
};

export const metaAnchor = (href, label, cls) => {
  const url = safeUrl(href);

  if (!url) return esc(label);

  return (
    '<a class="' +
    (cls || "meta-link") +
    '" href="' +
    esc(url) +
    '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' +
    esc(label) +
    "</a>"
  );
};

export const channelHref = (item) => {
  const m = item.metadata || {};

  return item.source === "youtube" && m.channel_id
    ? "https://www.youtube.com/channel/" + encodeURIComponent(m.channel_id)
    : "";
};

export const uploadDate = (item) => {
  const m = item.metadata || {};

  const uploadDate = m.upload_date?.match(/^\d{8}$/)?.[0];

  if (uploadDate)
    return uploadDate.slice(0, 4) + "-" + uploadDate.slice(4, 6) + "-" + uploadDate.slice(6, 8);

  if (item.created_utc) return new Date(item.created_utc * 1000).toISOString().slice(0, 10);

  return "";
};

export const metaLine = (item, opts) => {
  const { hideSub = false } = opts || {};
  const m = item.metadata || {};
  const parts = [];

  if (item.author) {
    if (item.source === "reddit")
      parts.push(
        "by " +
          metaAnchor(
            "https://www.reddit.com/user/" + encodeURIComponent(item.author),
            item.author,
            "meta-link",
          ),
      );
    else if (item.source === "hackernews")
      parts.push("by " + metaAnchor(hnUserUrl(item.author), item.author, "meta-link"));
    else parts.push("by " + esc(item.author));
  }

  if (!hideSub) {
    if (m.subreddit)
      parts.push(
        metaAnchor(
          "https://www.reddit.com/r/" + encodeURIComponent(m.subreddit),
          "r/" + m.subreddit,
          "meta-link",
        ),
      );

    if (m.channel) parts.push(metaAnchor(channelHref(item), m.channel, "meta-link"));

    if (m.playlist) parts.push(esc(m.playlist));
  }

  if (item.source === "youtube") {
    const ud = uploadDate(item);

    if (ud) parts.push("📅 " + ud);
  }

  if (item.kind) parts.push(esc(item.kind));

  if (m.category && m.category !== "unknown") parts.push("🏷 " + esc(m.category));

  if (Number.isFinite(m.score)) parts.push(Math.round(m.score) + " pts");
  const chip = articleChip(item);

  return parts.join(" · ") + (chip ? " " + chip : "");
};

export const dateTitle = (item) => {
  const c = item.created_utc,
    s = item.saved_utc,
    f = item.first_seen_utc;

  const lines = [];

  if (c) lines.push("Posted: " + fmtDate(c));

  if (s && s !== c && s < f - 86400) lines.push("Added in source: " + fmtDate(s));

  if (f) lines.push("Synced here: " + fmtDate(f));

  return lines.join("\n");
};

export const datesLine = (item) => {
  const c = item.created_utc,
    s = item.saved_utc,
    f = item.first_seen_utc;

  const showSaved = s && s !== c && s < f - 86400;

  const vis = [],
    tip = [];

  if (c) {
    vis.push("posted " + ago(c));
    tip.push("Posted: " + fmtDate(c));
  }

  if (showSaved) {
    vis.push("saved " + ago(s));
    tip.push("Added in source: " + fmtDate(s));
  }

  if (f) {
    vis.push("synced " + ago(f));
    tip.push("Synced here: " + fmtDate(f));
  }

  if (!vis.length) return "";

  return (
    '<div class="tcard-dates" title="' + esc(tip.join("\n")) + '">' + vis.join(" · ") + "</div>"
  );
};

export const ageMeta = (item) =>
  '<span class="m-age" title="' +
  esc(dateTitle(item)) +
  '">' +
  esc((item.created_utc ? "posted " : "synced ") + ago(item.created_utc || item.first_seen_utc)) +
  "</span>";

const READ_WPM = 200;

export const consumeMeta = (item) => {
  const m = item.metadata || {};

  let mins = 0,
    verb = "";

  if (item.source === "youtube" && Number.isFinite(m.duration) && m.duration > 0) {
    mins = Math.max(1, Math.round(m.duration / 60));
    verb = m.category === "listenable" ? "listen" : "watch";
  } else if (item.body && item.body.trim()) {
    const words = item.body.trim().split(/\s+/).length;

    if (words >= 40) {
      mins = Math.max(1, Math.round(words / READ_WPM));
      verb = "read";
    }
  }

  if (!mins) return "";

  const amt =
    mins >= 60
      ? Math.floor(mins / 60) + "h" + (mins % 60 ? " " + (mins % 60) + "m" : "")
      : mins + " min";

  return '<span class="consume ' + verb + '">' + amt + " " + verb + "</span>";
};

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

  const overflow = !tail.length
    ? ""
    : expand
      ? tail
          .map(
            (t) =>
              '<button type="button" class="tag-chip tag-overflow" hidden>' + esc(t) + "</button>",
          )
          .join("") +
        '<button type="button" class="tag-chip tag-more" aria-expanded="false">+' +
        tail.length +
        " more</button>"
      : '<span class="tag-chip tag-rest">+' + tail.length + "</span>";

  return (
    '<div class="tag-chips">' +
    head.map((t) => '<button type="button" class="tag-chip">' + esc(t) + "</button>").join("") +
    overflow +
    "</div>"
  );
};

export const wireTagExpanders = (container) => {
  container.addEventListener("click", (e) => {
    const more = e.target.closest(".tag-more");

    if (!more) return;
    e.stopPropagation();
    const open = more.getAttribute("aria-expanded") === "true";
    more.setAttribute("aria-expanded", String(!open));
    more
      .closest(".tag-chips")
      .querySelectorAll(".tag-overflow")
      .forEach((c) => {
        c.hidden = open;
      });
    more.textContent = open
      ? "+" + more.closest(".tag-chips").querySelectorAll(".tag-overflow").length + " more"
      : "less";
  });
};

export const COMP_LABEL = { reddit: "Reddit", hackernews: "Hacker News", firefox: "Firefox" };

export const companionHref = (c) => {
  let u = ((c && (c.permalink || c.url)) || "").trim();

  if (/^\/r\//i.test(u)) u = "https://www.reddit.com" + u;

  return safeUrl(u);
};

export const companionList = (item) => {
  const list = (item.metadata || {}).companions;

  return Array.isArray(list) ? list.filter((c) => companionHref(c)) : [];
};

export const companionsHtml = (item, sources) => {
  const cs = companionList(item);

  if (!cs.length) return "";

  const links = cs
    .map((c) => {
      const label =
        COMP_LABEL[c.source] || ((sources || {})[c.source] || {}).label || c.source || "link";

      return (
        '<a class="comp-link" href="' +
        esc(companionHref(c)) +
        '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' +
        esc(label) +
        " ↗</a>"
      );
    })
    .join("");

  return (
    '<div class="companions" title="Saved discussion threads for this video">' +
    '<span class="comp-lead" aria-hidden="true">💬</span>' +
    links +
    "</div>"
  );
};
