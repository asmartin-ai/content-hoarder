/* Today (lamp mode), server-rendered with htmx partials. Contract: docs/design/clear-v2.md §6.
   Wins-only copy: never a remaining-backlog total. */

import { NSFW_TAGS, type Item } from "../../models.ts";
import type { ResurfaceCard } from "../../resurface.ts";
import { html, raw, type SafeHtml } from "./html.ts";
import { cardMedia, costLabel, thumbFor } from "./media.ts";
import { moonIcon } from "./page.ts";

export const ROUND_SIZES = [5, 10, 25] as const;

const STRIP_CARDS = 6;

const DECISION_SECONDS = 12;

const LONG_READ_MINUTES = 5;

const SOURCE_TOKENS = {
  reddit: true,
  youtube: true,
  hackernews: true,
  obsidian: true,
  keep: true,
  firefox: true,
  twitter: true,
} as const;

/** `--src` accent for a source, from core/tokens.css. */
export function sourceAccent(source: string): string {
  // SAFETY: SOURCE_TOKENS is a finite known map
  return Object.hasOwn(SOURCE_TOKENS, source)
    ? `--src: var(--source-${source})`
    : "--src: var(--accent)";
}

export function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function plural(n: number, one: string, many: string): string {
  return `${fmt(n)} ${n === 1 ? one : many}`;
}

/** "SAT 31 OCT" */
export function dateLine(now: Date): string {
  return now
    .toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })
    .replace(/,/g, "")
    .toUpperCase();
}

function agoText(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`;

  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;

  return `${Math.floor(seconds / 86_400)}d`;
}

/**
 * Re-entry line from cookie `ch_last_round=<at_ms>.<cleared>` (written by the round):
 * "Last round 2h ago — 10 cleared."; after three days a no-debt welcome; "" when unknown.
 */
export function reentryLine(cookie: string | null, nowMs: number): string {
  const match = /^(\d+)\.(\d+)$/.exec(cookie ?? "");

  if (!match) return "";
  const elapsed = Math.max(0, (nowMs - Number(match[1])) / 1000);

  if (elapsed > 3 * 86_400) return "Welcome back. Nothing is owed — start small.";

  return `Last round ${agoText(elapsed)} ago — ${fmt(Number(match[2]))} cleared.`;
}

/** Display minutes for a whole-round estimate ("about 2 minutes"). */
function aboutMinutes(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));

  return `about ${plural(minutes, "minute", "minutes")}`;
}

/** The lit object. Without ids the round deals its own smart batch. */
export function renderHeroGo(opts: { n: number; ids?: string[]; oob?: boolean }): SafeHtml {
  const params = new URLSearchParams({ n: String(opts.n) });

  if (opts.ids?.length) params.set("ids", opts.ids.join(","));

  return html`<a
    class="hero-go"
    id="hero-go"
    href="/clear?${params.toString()}"
    ${opts.oob ? raw(' hx-swap-oob="true"') : ""}
    ><span class="hero-verb">Clear ${opts.n}</span
    ><span class="hero-sub">${aboutMinutes(opts.n * DECISION_SECONDS)}</span></a
  >`;
}

export function renderSizes(n: number, oob = false): SafeHtml {
  const links = ROUND_SIZES.map(
    (size) =>
      html`<a
        href="/?n=${size}"
        hx-get="/hx/today/upnext?n=${size}"
        hx-target="#upnext"
        hx-swap="outerHTML"
        hx-push-url="/?n=${size}"
        ${size === n ? html`aria-current="page"` : ""}
        >${size}</a
      >`,
  );

  return html`<nav
    class="hero-sizes"
    id="hero-sizes"
    aria-label="Round size"
    ${oob ? raw(' hx-swap-oob="true"') : ""}
  >
    ${links}
  </nav>`;
}

export function renderToday(opts: { now: Date; reentry: string; n: number }): SafeHtml {
  return html`<section class="today">
    <header class="today-head">
      <p class="today-date">${dateLine(opts.now)}</p>
      ${opts.reentry ? html`<p class="today-reentry">${opts.reentry}</p>` : ""}
    </header>
    <div class="hero">${renderHeroGo({ n: opts.n })} ${renderSizes(opts.n)}</div>
    <section
      class="upnext"
      id="upnext"
      aria-label="Up next"
      hx-get="/hx/today/upnext?n=${opts.n}"
      hx-trigger="load"
      hx-swap="outerHTML"
    ></section>
    <section
      class="wins"
      id="wins"
      aria-label="Wins"
      hx-get="/hx/today/wins"
      hx-trigger="load, ch:wins from:body"
    >
      <p class="wins-line">&nbsp;</p>
    </section>
    <section
      class="piles"
      id="piles"
      hx-get="/hx/today/piles"
      hx-trigger="load"
      hx-swap="outerHTML"
      hidden
    ></section>
    <aside
      class="whisper"
      id="whisper"
      hx-get="/hx/today/whisper"
      hx-trigger="load"
      hx-swap="outerHTML"
      hidden
    ></aside>
    <footer class="today-foot">
      <a href="/library">Search the library</a>
      <button class="today-theme" type="button" aria-label="Switch light/dark">
        ${moonIcon()}
      </button>
    </footer>
  </section>`;
}

function stripCaption(item: Item): string {
  if (item.metadata.subreddit) return `r/${item.metadata.subreddit}`;

  if (item.metadata.channel) return item.metadata.channel;

  return item.source;
}

/** Same rule as db.searchItems' hideNsfw: an NSFW tag bucket or Reddit's over_18 flag. */
export function isNsfw(item: Item): boolean {
  const flagged = item.metadata.over_18 === true || item.metadata.over_18 === 1;

  return (
    flagged || (item.metadata.tags ?? []).some((tag) => NSFW_TAGS.some((nsfw) => nsfw === tag))
  );
}

function stripCard(item: Item): SafeHtml {
  const thumb = thumbFor(item);
  const caption = stripCaption(item);

  if (thumb)
    return html`<li
      class="strip-card${isNsfw(item) ? " is-nsfw" : ""}"
      style="${sourceAccent(item.source)}"
    >
      <img src="${thumb}" alt="" loading="lazy" decoding="async" /><span class="strip-cap"
        >${caption}</span
      >
    </li>`;

  return html`<li class="strip-card is-text" style="${sourceAccent(item.source)}">
    <span class="strip-title">${item.title || caption}</span
    ><span class="strip-cap">${caption}</span>
  </li>`;
}

/** "N min …" from costLabel, or null when the cost is not in minutes. */
function knownMinutes(item: Item): number | null {
  const match = /^(\d+) min\b/.exec(costLabel(item));

  return match ? Number(match[1]) : null;
}

/** "3 images · 4 videos (15 min) · 1 long read" */
export function mixLine(items: Item[]): string {
  let images = 0;
  let videos = 0;
  let videoMinutes = 0;
  let longReads = 0;

  for (const item of items) {
    const kind = cardMedia(item)?.kind;
    const minutes = knownMinutes(item);

    if (kind === "image" || kind === "gallery") images += 1;

    if (kind === "video" || kind === "youtube") {
      videos += 1;
      videoMinutes += minutes ?? 0;
    }

    if (minutes !== null && minutes >= LONG_READ_MINUTES && costLabel(item).endsWith("read"))
      longReads += 1;
  }

  const videoPart = videos
    ? `${plural(videos, "video", "videos")}${videoMinutes > 0 ? ` (${videoMinutes} min)` : ""}`
    : "";

  const parts = [
    images ? plural(images, "image", "images") : "",
    videoPart,
    longReads ? plural(longReads, "long read", "long reads") : "",
  ];

  return parts.filter(Boolean).join(" · ");
}

/** Up next (Netflix row): the actual cards of the next round, plus OOB hero + sizes. */
export function renderUpNext(items: Item[], n: number): SafeHtml {
  const oob = html`${renderHeroGo({ n, ids: items.map((item) => item.fullname), oob: true })}${renderSizes(n, true)}`;

  if (!items.length)
    return html`<section class="upnext" id="upnext" aria-label="Up next">
        <h2 class="sec-h">Up next</h2>
        <p class="sec-sub">Nothing waiting here. That's a clear deck.</p>
      </section>
      ${oob}`;

  const more = items.length - STRIP_CARDS;

  return html`<section class="upnext" id="upnext" aria-label="Up next">
      <h2 class="sec-h">Up next</h2>
      <ol class="strip">
        ${items.slice(0, STRIP_CARDS).map(stripCard)}${more > 0 ? html`<li class="strip-more">+${more}</li>` : ""}
      </ol>
      <p class="upnext-mix">${mixLine(items)}</p>
    </section>
    ${oob}`;
}

/** Inner content of #wins: pebbles toward the daily goal (0 = no goal) + the wins line. */
export function renderWins(opts: { today: number; total: number; goal: number }): SafeHtml {
  const pebbles = Array.from({ length: opts.goal }, (_, index) =>
    index < opts.today ? html`<i class="on"></i>` : html`<i></i>`,
  );

  return html`${opts.goal > 0 ? html`<div class="pebbles" aria-hidden="true">${pebbles}</div>` : ""}
    <p class="wins-line">
      <b>${fmt(opts.today)}</b> cleared today · <b>${fmt(opts.total)}</b> all-time
    </p>`;
}

export type PileView = {
  label: string;
  count: number;
  firstYear: number | null;
  lastYear: number | null;
  thumbs: string[];
  glyph: string;
  source: string;
  peekQuery: string;
  vals:
    | { kind: "subreddit"; source: "reddit"; subreddit: string }
    | { kind: "age"; source: string; before_utc: number };
};

function pileMeta(pile: PileView): string {
  const saves = plural(pile.count, "save", "saves");

  if (pile.firstYear === null || pile.lastYear === null) return saves;

  if (pile.firstYear === pile.lastYear) return `${saves} · ${pile.firstYear}`;

  return `${saves} · ${pile.firstYear} – ${pile.lastYear}`;
}

function pileRow(pile: PileView): SafeHtml {
  const mosaic = pile.thumbs.length
    ? html`<div
        class="pile-mosaic"
        aria-hidden="true"
        data-glyph="${pile.glyph}"
        style="${sourceAccent(pile.source)}"
      >
        ${pile.thumbs.map((src) => html`<img src="${src}" alt="" loading="lazy" decoding="async" />`)}
      </div>`
    : html`<div
        class="pile-mosaic is-glyph"
        aria-hidden="true"
        style="${sourceAccent(pile.source)}"
      >
        <span class="pile-glyph">${pile.glyph}</span>
      </div>`;

  const peek = new URLSearchParams({ n: "10", q: pile.peekQuery });

  return html`<li class="pile">
    ${mosaic}
    <div class="pile-main">
      <p class="pile-label">${pile.label}</p>
      <p class="pile-meta">${pileMeta(pile)}</p>
    </div>
    <a class="pile-peek" href="/clear?${peek.toString()}">Peek</a>
    <button
      class="pile-go"
      type="button"
      hx-post="/hx/sweeps/apply"
      hx-vals="${JSON.stringify(pile.vals)}"
      hx-target="#piles"
      hx-swap="outerHTML"
      hx-disabled-elt="this"
    >
      Let go
    </button>
  </li>`;
}

/** The whole #piles section; hidden when there is nothing to let go. */
export function renderPiles(piles: PileView[]): SafeHtml {
  if (!piles.length) return html`<section class="piles" id="piles" hidden></section>`;

  return html`<section class="piles" id="piles" aria-labelledby="piles-h">
    <h2 class="sec-h" id="piles-h">Let a pile go</h2>
    <p class="sec-sub">One tap rests the whole pile. Nothing is deleted; undo any time.</p>
    <ul class="pile-list">
      ${piles.map(pileRow)}
    </ul>
  </section>`;
}

/** Resurface whisper (moss): one knowledge cluster worth a peek, or an empty hidden aside. */
export function renderWhisper(card: ResurfaceCard | null): SafeHtml {
  if (!card) return html`<aside class="whisper" id="whisper" hidden></aside>`;

  const vals = JSON.stringify({ cluster: card.cluster });
  const peek = new URLSearchParams({ n: "5", q: card.cluster });

  return html`<aside class="whisper" id="whisper">
    <p class="whisper-q">Still curious about <b>${card.label}</b>? ${fmt(card.count)} saved.</p>
    <div class="whisper-acts">
      <a class="whisper-peek" href="/clear?${peek.toString()}">Peek 5</a>
      <button
        class="whisper-later"
        type="button"
        hx-post="/hx/whisper/dismiss"
        hx-vals="${vals}"
        hx-target="#whisper"
        hx-swap="outerHTML"
      >
        Not now
      </button>
      <button
        class="whisper-letgo"
        type="button"
        hx-post="/hx/whisper/letgo"
        hx-vals="${vals}"
        hx-target="#whisper"
        hx-swap="outerHTML"
      >
        Let it go
      </button>
    </div>
  </aside>`;
}
