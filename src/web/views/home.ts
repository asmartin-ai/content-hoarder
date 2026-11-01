import { html, raw, type SafeHtml } from "./html.ts";
import { ringSvg } from "../../static/core/ring.js";
import { dateLine, dayTitle, fmt } from "./today.ts";

export type ModuleStatus = "live" | "prototype" | "planned";

export type KhaosModule = {
  id: string;
  name: string;
  job: string;
  layer: "capture" | "storage" | "engine" | "screen";
  status: ModuleStatus;
  hue: number;
  href?: string;
  note?: string;
};

export const MODULES: readonly KhaosModule[] = [
  {
    id: "hoard",
    name: "Hoard",
    job: "Saved posts, videos and tabs: clear rounds and a library",
    layer: "screen",
    status: "live",
    hue: 40,
    href: "/clear",
  },
  {
    id: "vault",
    name: "Vault",
    job: "Notes and captures from Keep, WhatsApp, Discord and share",
    layer: "storage",
    status: "live",
    hue: 285,
    note: "Runs as PKMS",
  },
  {
    id: "desk",
    name: "Desk",
    job: "Commitments and shelved projects: resume, park, close, hand off",
    layer: "screen",
    status: "prototype",
    hue: 225,
  },
  {
    id: "learn",
    name: "Learn",
    job: "Spaced review of the things you chose to keep",
    layer: "screen",
    status: "prototype",
    hue: 150,
  },
  {
    id: "agents",
    name: "Agents",
    job: "Hand work to an agent; a receipt comes back to the card",
    layer: "engine",
    status: "prototype",
    hue: 320,
    note: "Afternoon brief runs on Hermes",
  },
  {
    id: "discover",
    name: "Discover",
    job: "A feed in chapters, with a clear-5 checkpoint at the end",
    layer: "screen",
    status: "planned",
    hue: 195,
  },
  {
    id: "car",
    name: "Car",
    job: "Say it while driving; it lands in the vault",
    layer: "capture",
    status: "planned",
    hue: 65,
  },
  {
    id: "health",
    name: "Health",
    job: "Activity and habits, only from what you link",
    layer: "capture",
    status: "planned",
    hue: 120,
  },
];

export type DoNext = {
  module: string;
  title: string;
  step: string;
  minutes: number;
  reason: string;
  href: string;
  sample: boolean;
};

export const SAMPLE_DO_NEXT: readonly DoNext[] = [
  {
    module: "desk",
    title: "YC application",
    step: "Record the one-minute founder video",
    minutes: 10,
    reason: "Due tomorrow, 8pm PT",
    href: "#desk",
    sample: true,
  },
  {
    module: "learn",
    title: "How SQLite stores a table",
    step: "Three review cards from something you kept",
    minutes: 3,
    reason: "Ready to review",
    href: "#learn",
    sample: true,
  },
];

export const SAMPLE_COMING_UP: readonly { module: string; title: string; when: string }[] = [
  { module: "learn", title: "Review: the exposure triangle", when: "Thu" },
  { module: "desk", title: "Wake: logo feedback from Alex", when: "when Alex replies" },
];

export type HomeView = {
  now: Date;
  clearedToday: number;
  clearedTotal: number;
  kept: number;
  goal: number;
  roundSize: number;
  showedUp: ReadonlySet<string>;
};

const STATUS_LABEL = { live: "Live", prototype: "Prototype", planned: "Planned" } as const;

function moduleById(id: string): KhaosModule | undefined {
  return MODULES.find((m) => m.id === id);
}

function arrow(): SafeHtml {
  return raw(
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7"/><path d="M8 7h9v9"/></svg>',
  );
}

function sampleChip(sample: boolean): SafeHtml | string {
  return sample ? html`<span class="o-chip is-sample">Sample</span>` : "";
}

function doNextCard(card: DoNext): SafeHtml {
  const mod = moduleById(card.module);

  return html`<li class="o-do" style="--hue: ${mod?.hue ?? 40}">
    <a class="o-do-link" href="${card.href}">
      <span class="o-do-top">
        <span class="o-mod">${mod?.name ?? card.module}</span>
        ${sampleChip(card.sample)}
        <span class="o-arrow">${arrow()}</span>
      </span>
      <span class="o-do-title">${card.title}</span>
      <span class="o-do-step">${card.step}</span>
      <span class="o-do-meta">${card.reason} · ~${card.minutes} min</span>
    </a>
  </li>`;
}

function hoardCard(n: number): DoNext {
  return {
    module: "hoard",
    title: `Clear ${n}`,
    step: "Let most of it go, keep the few that matter",
    minutes: Math.max(1, Math.round((n * 12) / 60)),
    reason: "A short round fits here",
    href: `/clear?n=${n}`,
    sample: false,
  };
}

function winTile(label: string, value: string, hue: number, sample = false): SafeHtml {
  return html`<li class="o-win" style="--hue: ${hue}">
    <span class="o-win-label">${label} ${sampleChip(sample)}</span>
    <span class="o-win-n">${value}</span>
  </li>`;
}

function moduleTile(mod: KhaosModule): SafeHtml {
  const body = html`<span class="o-mtop">
      <span class="o-mname">${mod.name}</span>
      <span class="o-chip is-${mod.status}">${STATUS_LABEL[mod.status]}</span>
    </span>
    <span class="o-mjob">${mod.job}</span>
    ${mod.note ? html`<span class="o-mnote">${mod.note}</span>` : ""}`;

  return html`<li
    class="o-mod-tile is-${mod.status}"
    style="--hue: ${mod.hue}"
    data-layer="${mod.layer}"
  >
    ${mod.href ? html`<a class="o-mlink" href="${mod.href}">${body}</a>` : html`<div class="o-mlink">${body}</div>`}
  </li>`;
}

function isoDay(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");

  return `${d.getFullYear()}-${month}-${day}`;
}

function calendar(now: Date, showedUp: ReadonlySet<string>): SafeHtml {
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const lead = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const today = isoDay(now);
  const cells: SafeHtml[] = [];

  for (let i = 0; i < lead; i++) cells.push(html`<span class="o-day is-pad"></span>`);

  for (let d = 1; d <= daysInMonth; d++) {
    const key = isoDay(new Date(now.getFullYear(), now.getMonth(), d));
    const cls = [showedUp.has(key) ? "is-on" : "", key === today ? "is-today" : ""].join(" ");

    cells.push(html`<span class="o-day ${cls}">${d}</span>`);
  }

  const month = now.toLocaleDateString("en-GB", { month: "long", year: "numeric" });

  const heads = ["M", "T", "W", "T", "F", "S", "S"].map(
    (h) => html`<span class="o-dh">${h}</span>`,
  );

  return html`<section class="o-cal" aria-label="Days you showed up">
    <h2 class="o-h">${month}</h2>
    <div class="o-grid">${heads}${cells}</div>
    <p class="o-cal-key"><span class="o-dot"></span> a day with at least one decision</p>
  </section>`;
}

export function renderHome(view: HomeView): SafeHtml {
  const doNext = [hoardCard(view.roundSize), ...SAMPLE_DO_NEXT];

  return html`<section class="orient">
    <header class="o-head">
      <p class="o-date">${dateLine(view.now)}</p>
      <h1 class="o-title">Welcome back</h1>
      <p class="o-sub">${dayTitle(view.now)}. Here's what's ready for you.</p>
    </header>
    <div class="o-cols">
      <div class="o-main">
        <section aria-labelledby="o-do-h">
          <h2 class="o-h" id="o-do-h">Do next</h2>
          <ul class="o-dos">
            ${doNext.map(doNextCard)}
          </ul>
        </section>
        <section aria-labelledby="o-wins-h">
          <h2 class="o-h" id="o-wins-h">Wins</h2>
          <div class="o-wins-row">
            <div class="o-ring" aria-hidden="true">
              ${raw(ringSvg(Math.min(view.clearedToday, view.goal), view.goal))}
            </div>
            <ul class="o-wins">
              ${winTile("Cleared today", fmt(view.clearedToday), 150)}
              ${winTile("Cleared, all time", fmt(view.clearedTotal), 40)}
              ${winTile("Kept", fmt(view.kept), 225)}
              ${winTile("Learned this week", "12", 150, true)}
            </ul>
          </div>
        </section>
        <section aria-labelledby="o-mods-h">
          <h2 class="o-h" id="o-mods-h">Modules</h2>
          <ul class="o-mods">
            ${MODULES.map(moduleTile)}
          </ul>
        </section>
      </div>
      <aside class="o-side">
        ${calendar(view.now, view.showedUp)}
        <section class="o-up" aria-labelledby="o-up-h">
          <h2 class="o-h" id="o-up-h">Coming up ${sampleChip(true)}</h2>
          <ul>
            ${SAMPLE_COMING_UP.map(
              (row) =>
                html`<li style="--hue: ${moduleById(row.module)?.hue ?? 40}">
                  <span class="o-up-title">${row.title}</span>
                  <span class="o-up-when">${row.when}</span>
                </li>`,
            )}
          </ul>
        </section>
      </aside>
    </div>
  </section>`;
}
