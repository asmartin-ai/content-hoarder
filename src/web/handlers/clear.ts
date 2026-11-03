import { aiActive, aiConfigured, aiConsent } from "../../assist/consent.ts";
import { hintFor, prefetchHints, type PrefetchOptions } from "../../assist/hints.ts";
import * as db from "../../db.ts";
import { track } from "../../demo_analytics.ts";
import { LlmSuggestionSchema, type Item } from "../../models.ts";
import { parse } from "../../search_query.ts";
import { clamp, json, numberParam, options } from "../http.ts";
import { connection } from "../state.ts";
import { htmlResponse } from "../static.ts";
import { renderCard } from "../views/card.ts";
import { html, type SafeHtml } from "../views/html.ts";
import { icon, type IconName } from "../views/icons.ts";
import { renderPage } from "../views/page.ts";
import { topComment } from "../views/thread.ts";
import { isNsfw } from "../../static/core/veil.js";

const MAX_DEAL = 50;

const MAX_HINTS = 30;

const PREWARM_HINTS = 10;

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

function howto(ai: { configured: boolean; on: boolean }): SafeHtml {
  return html`<dialog class="howto" aria-labelledby="howto-title">
    <h2 id="howto-title" class="howto-title">What the buttons mean</h2>
    <ul class="howto-list">
      ${GUIDE.map(
        (row) =>
          html`<li class="${row.cls}">
            <span class="act-orb">${icon(row.glyph, ORB_ICON)}</span>
            <span class="howto-text"
              ><b>${row.label}</b> ${row.means} <small>${row.how}</small></span
            >
          </li>`,
      )}
    </ul>
    <div class="howto-ai" ${ai.configured ? "" : html`hidden`}>
      <button
        class="howto-switch"
        type="button"
        data-clear-ai
        aria-pressed="${ai.on ? "true" : "false"}"
        ${ai.configured ? "" : html`disabled`}
      >
        <span class="howto-switch-track" aria-hidden="true"
          ><span class="howto-switch-knob"></span
        ></span>
        <span class="howto-switch-copy"
          >AI suggestions <b data-clear-ai-state>${ai.on ? "On" : "Off"}</b></span
        >
      </button>
      <p class="howto-ai-note" data-clear-ai-error hidden role="alert"></p>
    </div>
    <p class="howto-foot">
      Archive is searchable, not deleted. Swipe up to open a card, and Undo is at the top.
      <a class="howto-settings" href="/settings">Settings</a>
    </p>
    <button class="primary howto-ok" type="button">Got it</button>
  </dialog>`;
}

function frame(): SafeHtml {
  const configured = aiConfigured();
  const consent = configured ? aiConsent(connection()) : "unset";

  return html`<section
    class="round"
    data-state="loading"
    data-ai-configured="${configured ? "1" : "0"}"
    data-ai="${consent}"
  >
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
      <span class="pad-note" id="pad-suggested">Suggested</span>
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
    ${howto({ configured, on: consent === "on" })}
  </section>`;
}

export function clearPage(): Response {
  return htmlResponse(renderPage({ title: "Clear", tab: "clear", body: frame(), round: true }));
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

export async function deal(url: URL): Promise<Response> {
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
  let waitMs = 0;

  if (aiActive(database) && items.length) {
    const started = Date.now();

    try {
      await prefetchHints(
        database,
        items.map((item) => item.fullname),
      );
    } catch {}

    waitMs = Date.now() - started;

    const dealt = new Set(items.map((item) => item.fullname));

    setTimeout(() => {
      try {
        const upcoming = db
          .getRandomBatch(database, n * 2 + PREWARM_HINTS, { mode: "smart", unprocessed: true })
          .filter((item) => !dealt.has(item.fullname) && (!safe || !isNsfw(item)))
          .slice(0, PREWARM_HINTS)
          .map((item) => item.fullname);

        void prefetchHints(database, upcoming);
      } catch {}
    }, 0);
  }

  const cards = items.map((item) => {
    const hint = hintFor(database, db.getPublicItem(database, item.fullname) ?? item);

    return {
      fullname: item.fullname,
      status: item.status,
      html: renderCard(item, {
        topComment: topComment(database, item),
        hint,
      }).toString(),
      hinted: hint !== null,
    };
  });

  track(database, "srv_deal", {
    data: { n: items.length, hinted: cards.filter((card) => card.hinted).length, wait_ms: waitMs },
  });

  return json({
    items: cards.map((card) => ({
      fullname: card.fullname,
      status: card.status,
      html: card.html,
    })),
  });
}

export function clearHints(url: URL, opts: PrefetchOptions = {}): Response {
  const database = connection();

  const ids = [
    ...new Set(
      (url.searchParams.get("ids") ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ].slice(0, MAX_HINTS);

  const hints: Record<string, { verdict: "keep" | "skip"; by: "ai" | "history" } | null> = {};
  const missing: string[] = [];

  for (const id of ids) {
    const item = db.getPublicItem(database, id);

    if (!item || item.status !== "inbox") continue;
    const hint = hintFor(database, item);

    hints[id] = hint ? { verdict: hint.verdict, by: hint.by } : null;

    if (!LlmSuggestionSchema.safeParse(item.metadata.llm).success) missing.push(id);
  }

  if (missing.length && aiActive(database)) void prefetchHints(database, missing, opts);

  return json({ hints });
}
