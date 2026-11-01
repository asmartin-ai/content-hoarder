/**
 * The rich triage card (docs/design/clear-v2.md §4). Class names are a contract
 * with home.css and the round island (static/home/round.js).
 */

import type { Item } from "../../models.ts";
import { chIcon } from "../../static/core/icons.js";
import { renderMarkdown } from "../../static/core/markdown.js";
import { ago, isRemovedText } from "../../static/core/util.js";
import { html, raw, type SafeHtml } from "./html.ts";
import { icon } from "./icons.ts";
import { cardMedia, compact, costLabel, domainOf, extraMeta } from "./media.ts";
import type { TopComment } from "./thread.ts";

const BODY_CAP = 6000;

const STAT_ICON = 16;

// Same glyph table as static/core/render.js CH_SOURCES.
const SOURCES = {
  reddit: { glyph: "r/", label: "Reddit" },
  youtube: { glyph: "▶", label: "YouTube" },
  hackernews: { glyph: "Y", label: "Hacker News" },
  obsidian: { glyph: "◇", label: "Obsidian" },
  keep: { glyph: "✎", label: "Keep" },
  firefox: { glyph: "", label: "Firefox" },
  twitter: { glyph: "X", label: "Twitter" },
} as const;

const CARD_KINDS = ["post", "comment", "video", "story", "note"] as const;

type CardKind = (typeof CARD_KINDS)[number];

function cardKind(item: Item): CardKind {
  const known = CARD_KINDS.find((kind) => kind === item.kind);

  if (known) return known;

  if (item.source === "youtube") return "video";

  if (item.source === "hackernews") return "story";

  if (item.source === "keep" || item.source === "obsidian") return "note";

  return "post";
}

function glyph(source: string): SafeHtml {
  // chIcon returns trusted SVG markup (AGENTS.md source-badge contract: never escape it).
  if (source === "firefox") return raw(chIcon("firefox", { size: "1em" }));

  // SAFETY: SOURCES is a finite known map
  return html`${Object.hasOwn(SOURCES, source) ? (SOURCES[source as keyof typeof SOURCES]?.glyph ?? source.charAt(0).toUpperCase()) : source.charAt(0).toUpperCase()}`;
}

function by(author: string, prefix: string): SafeHtml {
  const name = author.trim();

  return name && name !== "[deleted]"
    ? html`<span class="card-by">${prefix}${name}</span>`
    : html``;
}

function where(item: Item): SafeHtml {
  const md = item.metadata;

  if (item.source === "reddit") {
    const sub = md.subreddit || /^\/r\/([^/]+)\//.exec(md.permalink ?? "")?.[1] || "";

    return html`${sub ? html`<b>r/${sub}</b>` : html`<b>Reddit</b>`}${by(item.author, "u/")}`;
  }

  if (item.source === "youtube") return html`<b>${md.channel || item.author || "YouTube"}</b>`;

  if (item.source === "hackernews") return html`<b>Hacker News</b>${by(item.author, "u/")}`;

  if (item.source === "twitter") return html`<b>Twitter</b>${by(item.author, "@")}`;

  // SAFETY: SOURCES is a finite known map, guarded by Object.hasOwn above
  return html`<b
    >${Object.hasOwn(SOURCES, item.source) ? (SOURCES[item.source as keyof typeof SOURCES]?.label ?? item.source) : item.source}</b
  >`;
}

function age(item: Item): SafeHtml {
  const ts = item.created_utc || item.saved_utc;

  if (!ts) return html``;
  const label: string = ago(ts);

  return label
    ? html`<time class="card-age" datetime="${new Date(ts * 1000).toISOString()}">${label}</time>`
    : html``;
}

function mediaFigure(item: Item, nsfw: boolean): SafeHtml {
  const media = cardMedia(item);

  if (!media) return html``;

  const opens = media.kind === "video" || media.kind === "youtube" || media.kind === "link";

  return html`<figure
    class="card-media${nsfw ? " is-nsfw" : ""}"
    data-media="${media.kind}"
    ${opens ? html`data-open=""` : ""}
  >
    <img
      src="${media.src}"
      ${media.fallback ? html` data-fallback="${media.fallback}"` : ""}
      alt=""
      loading="eager"
      decoding="async"
    />${media.badge ? html`<span class="media-badge">${media.badge}</span>` : ""}
  </figure>`;
}

function bodyText(item: Item): string {
  if (item.source === "youtube" || item.source === "firefox") return "";
  const body = item.body.trim();

  return body && !isRemovedText(body) ? body.slice(0, BODY_CAP) : "";
}

function reply(top: TopComment | null | undefined): SafeHtml {
  if (!top) return html``;

  // renderMarkdown escapes its input first and only emits a fixed safe tag set.
  return html`<aside class="card-reply">
    <p class="reply-who">Top comment · u/${top.author} · ▲ ${compact(top.score)}</p>
    <div class="reply-body md">${raw(renderMarkdown(top.body))}</div>
  </aside>`;
}

function stat(cls: string, glyphHtml: SafeHtml, text: string): SafeHtml {
  return html`<span class="stat ${cls}">${glyphHtml} ${text}</span>`;
}

function externalDomain(item: Item): string {
  const domain = domainOf(item.url);

  if (!domain) return "";

  if (item.source === "reddit" && /(^|\.)(reddit\.com|redd\.it)$/i.test(domain)) return "";

  if (item.source === "hackernews" && domain === "news.ycombinator.com") return "";

  return domain;
}

function stats(item: Item, nsfw: boolean): SafeHtml {
  const md = item.metadata;
  const parts: SafeHtml[] = [];

  if (item.source === "reddit" || item.source === "hackernews") {
    if (md.score) parts.push(stat("stat-score", icon("up", STAT_ICON), compact(md.score)));
    const comments = item.source === "reddit" ? md.num_comments : extraMeta(item).descendants;

    if (comments && item.kind !== "comment")
      parts.push(stat("stat-comments", icon("comment", STAT_ICON), compact(comments)));
  }

  if (item.source === "youtube" && md.view_count !== undefined)
    parts.push(stat("stat-views", icon("eye", STAT_ICON), `${compact(md.view_count)} views`));
  const cost = costLabel(item);

  if (cost) parts.push(html`<span class="cost">${cost}</span>`);
  const domain = item.source === "youtube" ? "" : externalDomain(item);

  if (domain) parts.push(html`<span class="stat stat-domain">${domain}</span>`);

  if (nsfw) parts.push(html`<span class="tag tag-nsfw">NSFW</span>`);

  return parts.length ? html`<footer class="card-stats">${parts}</footer>` : html``;
}

/** Server-rendered rich card for any source. Every interpolation is escaped. */
export function renderCard(item: Item, opts?: { topComment?: TopComment | null }): SafeHtml {
  const kind = cardKind(item);
  const nsfw = Boolean(item.metadata.over_18);
  const isComment = kind === "comment";
  const title = item.title.trim();
  const body = bodyText(item);

  const accent = Object.hasOwn(SOURCES, item.source)
    ? `var(--source-${item.source})`
    : "var(--accent)";

  const context =
    isComment && title ? html`<p class="card-context">Comment on <b>${title}</b></p>` : html``;

  const heading = !isComment && title ? html`<h2 class="card-title">${title}</h2>` : html``;

  // renderMarkdown escapes its input first and only emits a fixed safe tag set.
  const bodyHtml = body
    ? html`<div class="card-body md${isComment ? " is-comment" : ""}">
          ${raw(renderMarkdown(body))}
        </div>
        <button class="card-more" type="button" hidden>Show more</button>`
    : html``;

  const removed =
    item.source === "reddit" &&
    (isRemovedText(item.title.trim()) || isRemovedText(item.body.trim()))
      ? html`<p class="card-note">
          Removed on Reddit — nothing left to read here. Archive is the easy call.
        </p>`
      : html``;

  return html`<article
    class="card"
    data-fullname="${item.fullname}"
    data-source="${item.source}"
    data-kind="${kind}"
    style="--src: ${accent}"
  >
    <div class="card-fg item-fg">
      <header class="card-head">
        <span class="card-glyph" aria-hidden="true">${glyph(item.source)}</span
        ><span class="card-where">${where(item)}</span>${age(item)}
      </header>
      ${mediaFigure(item, nsfw)}${context}${heading}${removed}${bodyHtml}${reply(opts?.topComment)}${stats(item, nsfw)}
    </div>
  </article>`;
}
