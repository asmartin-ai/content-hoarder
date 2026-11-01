/* Clear (focus mode): the round page shell and the card deal. Contract: docs/design/clear-v2.md §5.
   The gestures live in the island (static/home/round.js, booted by main.js on data-page="clear"). */

import * as db from "../../db.ts";
import type { Item } from "../../models.ts";
import { parse } from "../../search_query.ts";
import { clamp, json, numberParam, options } from "../http.ts";
import { connection } from "../state.ts";
import { htmlResponse } from "../static.ts";
import { renderCard } from "../views/card.ts";
import { raw } from "../views/html.ts";
import { renderPage } from "../views/page.ts";
import { topComment } from "../views/thread.ts";
import { isNsfw } from "../views/today.ts";

const MAX_DEAL = 50;

// The island's frame (clear-overhaul.md §4.3); round.js finds these elements in the page.
const FRAME = `<section class="round" data-state="loading">
  <header class="round-bar">
    <button class="round-x" type="button" aria-label="End round">×</button>
    <ol class="beads" aria-label="0 of 0 decided"></ol>
    <span class="round-clock">0:00</span>
  </header>
  <div class="stage"></div>
  <div class="pad" role="group" aria-label="Decide">
    <div class="pad-minor">
      <button class="act act-keep" type="button" data-act="keep">Keep <kbd>K</kbd></button>
      <button class="act act-snooze" type="button" data-act="snooze">Not now <kbd>N</kbd></button>
      <button class="act act-skip" type="button" data-act="skip">Skip <kbd>S</kbd></button>
      <button class="act act-open" type="button" data-act="open">Open <kbd>↵</kbd></button>
    </div>
    <div class="pad-major">
      <button class="act act-done" type="button" data-act="done"><span>Done</span> <kbd>D</kbd></button>
      <button class="act act-archive" type="button" data-act="archived"><span>Archive</span> <kbd>A</kbd></button>
    </div>
    <button class="undo" type="button" data-act="undo" disabled>Undo <kbd>Z</kbd></button>
  </div>
  <div class="cleared" hidden>
    <p class="stamp">CLEARED</p>
    <p class="cleared-line"></p>
    <div class="cleared-today" hidden></div>
    <div class="cleared-acts">
      <button class="primary" type="button" data-next="again">One more round</button>
      <button type="button" data-next="sweep">Let a pile go</button>
      <button type="button" data-next="enough">That's enough for today</button>
    </div>
  </div>
</section>`;

export function clearPage(): Response {
  return htmlResponse(renderPage({ title: "Clear", tab: "clear", body: raw(FRAME), round: true }));
}

/** A smart batch of `n` inbox items (dealt 2n so the NSFW filter still leaves a full round). */
export function smartDeal(n: number, hideNsfw: boolean): Item[] {
  const batch = db.getRandomBatch(connection(), n * 2, { mode: "smart", unprocessed: true });

  return (hideNsfw ? batch.filter((item) => !isNsfw(item)) : batch).slice(0, n);
}

/** Today's dealt ids, in order, minus anything decided since (no longer inbox). */
function dealIds(ids: string[]): Item[] {
  const database = connection();

  return [...new Set(ids)].flatMap((fullname) => {
    const item = db.getPublicItem(database, fullname);

    return item !== null && item.status === "inbox" ? [item] : [];
  });
}

/** Peek a pile: a search over inbox items only. */
function dealQuery(q: string, n: number, safe: boolean): Item[] {
  const params = new URLSearchParams({ q, status: "inbox" });

  if (safe) params.set("safe", "1");

  return db.searchItems(
    connection(),
    parse(q).text,
    options(params, { status: "inbox", limit: n }),
  );
}

/**
 * `GET /clear/deal?n=&q=&ids=&safe=` → `{ items: [{ fullname, status, html }] }`.
 * `ids` (Today's Up next) wins, then `q`, else a smart random batch.
 */
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
