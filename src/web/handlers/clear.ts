import * as db from "../../db.ts";
import type { Item } from "../../models.ts";
import { parse } from "../../search_query.ts";
import { clamp, json, numberParam, options } from "../http.ts";
import { connection } from "../state.ts";
import { htmlResponse } from "../static.ts";
import { renderCard } from "../views/card.ts";
import { html, type SafeHtml } from "../views/html.ts";
import { icon, type IconName } from "../views/icons.ts";
import { renderPage } from "../views/page.ts";
import { topComment } from "../views/thread.ts";
import { isNsfw } from "../views/today.ts";

const MAX_DEAL = 50;

const ORB_ICON = 26;

const MAJOR_ORB_ICON = 32;

function act(opts: {
  act: string;
  cls: string;
  glyph: IconName;
  label: string;
  key: string;
  major?: boolean;
}): SafeHtml {
  return html`<button
    class="act ${opts.cls}${opts.major ? " is-major" : ""}"
    type="button"
    data-act="${opts.act}"
    aria-keyshortcuts="${opts.key}"
  >
    <span class="act-orb">${icon(opts.glyph, opts.major ? MAJOR_ORB_ICON : ORB_ICON)}</span
    ><span class="act-label">${opts.label} <kbd>${opts.key}</kbd></span>
  </button>`;
}

const GUIDE: { cls: string; glyph: IconName; label: string; means: string; how: string }[] = [
  {
    cls: "act-done",
    glyph: "check",
    label: "Done",
    means: "You got what you needed from it.",
    how: "Swipe left",
  },
  {
    cls: "act-archive",
    glyph: "archive",
    label: "Archive",
    means: "You don't need it. Out of sight, still searchable.",
    how: "Swipe right",
  },
  {
    cls: "act-keep",
    glyph: "bookmark",
    label: "Keep",
    means: "Worth coming back to. It goes on your Keep list.",
    how: "Button only",
  },
  {
    cls: "act-snooze",
    glyph: "clock",
    label: "Not now",
    means: "Ask me again in a week.",
    how: "Button only",
  },
  {
    cls: "act-skip",
    glyph: "skip",
    label: "Skip",
    means: "No decision. It stays where it was.",
    how: "Swipe down",
  },
];

const HOWTO = html`<dialog class="howto" aria-labelledby="howto-title">
  <h2 id="howto-title" class="howto-title">What the buttons mean</h2>
  <ul class="howto-list">
    ${GUIDE.map(
      (row) =>
        html`<li class="${row.cls}">
          <span class="act-orb">${icon(row.glyph, ORB_ICON)}</span>
          <span class="howto-text"><b>${row.label}</b> ${row.means} <small>${row.how}</small></span>
        </li>`,
    )}
  </ul>
  <p class="howto-foot">Swipe up to open a card. Nothing is deleted, and Undo is at the top.</p>
  <button class="primary howto-ok" type="button">Got it</button>
</dialog>`;

const FRAME = html`<section class="round" data-state="loading">
  <header class="round-bar">
    <button class="round-x" type="button" aria-label="End round">${icon("x", 22)}</button>
    <ol class="beads" aria-label="0 of 0 decided"></ol>
    <button class="undo" type="button" data-act="undo" aria-keyshortcuts="Z" disabled>
      ${icon("undo", 20)}<span>Undo</span>
    </button>
    <button class="round-help" type="button" aria-label="What the buttons mean">?</button>
  </header>
  <div class="stage"></div>
  <div class="pad" role="group" aria-label="Decide">
    ${act({ act: "skip", cls: "act-skip", glyph: "skip", label: "Skip", key: "S" })}
    ${act({ act: "done", cls: "act-done", glyph: "check", label: "Done", key: "D", major: true })}
    ${act({ act: "keep", cls: "act-keep", glyph: "bookmark", label: "Keep", key: "K" })}
    ${act({
      act: "archived",
      cls: "act-archive",
      glyph: "archive",
      label: "Archive",
      key: "A",
      major: true,
    })}
    ${act({ act: "snooze", cls: "act-snooze", glyph: "clock", label: "Not now", key: "N" })}
  </div>
  <div class="cleared" hidden>
    <p class="stamp">Cleared</p>
    <ol class="receipt" aria-label="This round"></ol>
    <dl class="cleared-stats">
      <div>
        <dt>cleared</dt>
        <dd class="cs-n">0</dd>
      </div>
      <div class="cs-freed-box" hidden>
        <dt>freed</dt>
        <dd class="cs-freed"></dd>
      </div>
      <div>
        <dt>spent</dt>
        <dd class="cs-time">0:00</dd>
      </div>
    </dl>
    <p class="cleared-line"></p>
    <div class="cleared-today" hidden></div>
    <div class="cleared-acts">
      <button class="primary" type="button" data-next="again">One more round</button>
      <button type="button" data-next="sweep">Let a pile go</button>
      <button type="button" data-next="enough">That's enough for today</button>
    </div>
  </div>
  ${HOWTO}
</section>`;

export function clearPage(): Response {
  return htmlResponse(renderPage({ title: "Clear", tab: "clear", body: FRAME, round: true }));
}

export function smartDeal(n: number, hideNsfw: boolean): Item[] {
  const batch = db.getRandomBatch(connection(), n * 2, { mode: "smart", unprocessed: true });

  return (hideNsfw ? batch.filter((item) => !isNsfw(item)) : batch).slice(0, n);
}

function dealIds(ids: string[]): Item[] {
  const database = connection();

  return [...new Set(ids)].flatMap((fullname) => {
    const item = db.getPublicItem(database, fullname);

    return item !== null && item.status === "inbox" ? [item] : [];
  });
}

function dealQuery(q: string, n: number, safe: boolean): Item[] {
  const params = new URLSearchParams({ q, status: "inbox" });

  if (safe) params.set("safe", "1");

  return db.searchItems(
    connection(),
    parse(q).text,
    options(params, { status: "inbox", limit: n }),
  );
}

export function deal(url: URL): Response {
  const params = url.searchParams;
  const n = clamp(numberParam(params.get("n"), 10), 1, MAX_DEAL);
  const safe = params.get("safe") === "1";
  const q = (params.get("q") ?? "").trim();

  const ids = (params.get("ids") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  const picked = ids.length ? dealIds(ids) : q ? dealQuery(q, n * 2, safe) : smartDeal(n, safe);
  const items = (safe ? picked.filter((item) => !isNsfw(item)) : picked).slice(0, n);
  const database = connection();

  return json({
    items: items.map((item) => ({
      fullname: item.fullname,
      status: item.status,
      html: renderCard(item, { topComment: topComment(database, item) }).toString(),
    })),
  });
}
