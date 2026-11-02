import type { Item } from "../../models.ts";
import type { WeekFlow } from "../../db.ts";
import { html, raw, type SafeHtml } from "./html.ts";
import { communityOf, hueOf } from "./media.ts";
import { dateLine, dayTitle, fmt, sourceAccent } from "./today.ts";

export type ModuleStatus = "live" | "prototype" | "planned";

export type KhaosModule = {
  id: string;
  name: string;
  layer: "capture" | "storage" | "engine" | "screen";
  status: ModuleStatus;
  href?: string;
};

export const MODULES: readonly KhaosModule[] = [
  { id: "hoard", name: "Hoard", layer: "screen", status: "live", href: "/clear" },
  { id: "vault", name: "Vault", layer: "storage", status: "live" },
  { id: "desk", name: "Desk", layer: "screen", status: "prototype" },
  { id: "learn", name: "Learn", layer: "screen", status: "prototype" },
  { id: "agents", name: "Agents", layer: "engine", status: "prototype" },
  { id: "discover", name: "Discover", layer: "screen", status: "planned" },
  { id: "car", name: "Car", layer: "capture", status: "planned" },
  { id: "health", name: "Health", layer: "capture", status: "planned" },
];

export const SAMPLE_PARKED: readonly { title: string; wake: string }[] = [
  { title: "Logo feedback for Alex", wake: "wakes when Alex replies" },
  { title: "Parked car-capture test", wake: "wakes Saturday morning" },
];

export const SAMPLE_RECEIPTS: readonly { agent: string; did: string; ask: string }[] = [
  { agent: "Hermes", did: "Delivered your afternoon brief", ask: "Read" },
  { agent: "Coding agent", did: "Fixed the reader's thread bug", ask: "Review" },
];

export const SAMPLE_PATTERNS: readonly { seen: string; offer: string }[] = [
  { seen: "You let go of 9 of the last 10 cooking posts.", offer: "Stop saving these here?" },
  { seen: "Your rounds go fastest after 9 pm.", offer: "Suggest rounds then?" },
];

export type HomeView = {
  now: Date;
  roundSize: number;
  flow: WeekFlow;
  resurfaced: Item | null;
  rhythm: readonly { day: string; on: boolean; today: boolean }[];
};

const STATUS_LABEL = { live: "Live", prototype: "Prototype", planned: "Planned" } as const;

const SOURCE_LABEL = {
  reddit: "Reddit",
  youtube: "YouTube",
  hackernews: "Hacker News",
  firefox: "Tabs",
  twitter: "X",
  keep: "Keep",
  obsidian: "Obsidian",
} as const;

function sourceLabel(source: string): string {
  return Object.hasOwn(SOURCE_LABEL, source)
    ? SOURCE_LABEL[source as keyof typeof SOURCE_LABEL]
    : source;
}

function sampleChip(): SafeHtml {
  return html`<span class="o-chip is-sample">Sample</span>`;
}

function arrow(): SafeHtml {
  return raw(
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7"/><path d="M8 7h9v9"/></svg>',
  );
}

function startHere(n: number): SafeHtml {
  const minutes = Math.max(1, Math.round((n * 12) / 60));

  return html`<section class="o-start" aria-labelledby="o-start-h">
    <p class="o-kicker" id="o-start-h">Start here</p>
    <a class="o-start-go" href="/clear?n=${n}">
      <span class="o-start-verb">Clear ${n}</span>
      <span class="o-start-sub">~${minutes} min · let most of it go, keep what matters</span>
      <span class="o-arrow">${arrow()}</span>
    </a>
    <p class="o-start-alt">
      <a href="/clear?n=5">Lighter: 5</a>
      <a href="/clear?n=25">Bigger: 25</a>
    </p>
  </section>`;
}

function flowSection(flow: WeekFlow): SafeHtml {
  const arrivedTotal = flow.arrived.reduce((sum, row) => sum + row.n, 0);
  const learning = 3;
  const committed = 1;
  const outcomes = Math.max(1, flow.letGo + flow.kept + learning + committed);
  const share = (n: number): string => `${Math.max(4, (n / outcomes) * 100).toFixed(1)}%`;

  return html`<section class="o-flow" aria-labelledby="o-flow-h">
    <h2 class="o-h" id="o-flow-h">This week's flow</h2>
    <p class="o-flow-lede">
      <strong>${fmt(flow.letGo)}</strong> let go. That's ${fmt(flow.letGo)} things you don't owe
      anyone.
    </p>
    <div class="o-flow-grid">
      <div class="o-flow-in">
        <p class="o-kicker">Arrived · ${fmt(arrivedTotal)}</p>
        <ul class="o-ramps">
          ${flow.arrived.map(
            (row) =>
              html`<li style="${sourceAccent(row.source)}">
                <span class="o-ramp-dot"></span>${sourceLabel(row.source)}
                <span class="o-ramp-n">${fmt(row.n)}</span>
              </li>`,
          )}
          <li class="is-sample">
            <span class="o-ramp-dot"></span>Keep · WhatsApp · Discord ${sampleChip()}
          </li>
        </ul>
      </div>
      <div class="o-flow-out">
        <p class="o-kicker">Where your attention moved it</p>
        <div class="o-river" role="img" aria-label="Let go ${flow.letGo}, kept ${flow.kept}">
          <span class="o-seg is-letgo" style="flex-basis: ${share(flow.letGo)}"></span>
          <span class="o-seg is-kept" style="flex-basis: ${share(flow.kept)}"></span>
          <span class="o-seg is-learn" style="flex-basis: ${share(learning)}"></span>
          <span class="o-seg is-commit" style="flex-basis: ${share(committed)}"></span>
        </div>
        <ul class="o-legend">
          <li class="is-letgo"><span></span>Let go <b>${fmt(flow.letGo)}</b></li>
          <li class="is-kept"><span></span>Kept <b>${fmt(flow.kept)}</b></li>
          <li class="is-learn"><span></span>Learning <b>${learning}</b> ${sampleChip()}</li>
          <li class="is-commit">
            <span></span>Became a commitment <b>${committed}</b> ${sampleChip()}
          </li>
        </ul>
      </div>
    </div>
  </section>`;
}

function savedAgo(item: Item, now: Date): string {
  const created = Number(item.created_utc) || 0;

  if (!created) return "Saved a while ago";
  const days = Math.max(1, Math.round((now.getTime() / 1000 - created) / 86_400));

  if (days >= 365) return `From ${Math.round(days / 365)} year${days >= 730 ? "s" : ""} ago`;

  if (days >= 30) return `From ${Math.round(days / 30)} months ago`;

  return `From ${days} days ago`;
}

function resurfacedCard(item: Item | null, now: Date): SafeHtml {
  if (!item)
    return html`<article class="o-panel o-again">
      <p class="o-kicker">Worth seeing again</p>
      <p class="o-muted">Nothing resting right now.</p>
    </article>`;

  const ids = encodeURIComponent(item.fullname);

  return html`<article class="o-panel o-again" style="--hue: ${hueOf(communityOf(item))}">
    <p class="o-kicker">Worth seeing again</p>
    <p class="o-again-title">${item.title}</p>
    <p class="o-reason">${savedAgo(item, now)} · ${communityOf(item)} · still glad you saved it?</p>
    <p class="o-actions">
      <a class="o-btn is-keep" href="/clear?n=1&amp;ids=${ids}">Decide</a>
      <a class="o-btn" href="/library?open=${ids}">Open</a>
    </p>
  </article>`;
}

function parkedPanel(): SafeHtml {
  return html`<article class="o-panel o-parked">
    <p class="o-kicker">Parked until… ${sampleChip()}</p>
    <ul>
      ${SAMPLE_PARKED.map(
        (row) =>
          html`<li>
            <span class="o-park-title">${row.title}</span><span class="o-wake">${row.wake}</span>
          </li>`,
      )}
    </ul>
    <p class="o-muted">Nothing here is overdue. It comes back when its condition is true.</p>
  </article>`;
}

function receiptsPanel(): SafeHtml {
  return html`<article class="o-panel o-receipts">
    <p class="o-kicker">Agent receipts ${sampleChip()}</p>
    <ul>
      ${SAMPLE_RECEIPTS.map(
        (row) =>
          html`<li>
            <span class="o-agent">${row.agent}</span>
            <span class="o-did">${row.did}</span>
            <span class="o-btn" aria-disabled="true">${row.ask}</span>
          </li>`,
      )}
    </ul>
  </article>`;
}

function patternsPanel(): SafeHtml {
  return html`<article class="o-panel o-patterns">
    <p class="o-kicker">Patterns noticed ${sampleChip()}</p>
    <ul>
      ${SAMPLE_PATTERNS.map(
        (row) =>
          html`<li>
            <span class="o-seen">${row.seen}</span>
            <span class="o-offer">${row.offer}</span>
            <span class="o-yesno"
              ><span class="o-btn is-keep" aria-disabled="true">Yes</span
              ><span class="o-btn" aria-disabled="true">No</span></span
            >
          </li>`,
      )}
    </ul>
  </article>`;
}

function guardPanel(): SafeHtml {
  return html`<article class="o-panel o-guard">
    <p class="o-kicker">Attention guard ${sampleChip()}</p>
    <div class="o-meter-row">
      <span>Nudges today</span><b>1 of 3</b>
      <span class="o-meter"><span style="width: 33%"></span></span>
    </div>
    <div class="o-meter-row"><span>Quiet hours</span><b>22:00 – 08:00</b></div>
    <div class="o-meter-row">
      <span>Earned autonomy: let go of r/memes saves on its own</span><b>18 of 20 approvals</b>
      <span class="o-meter is-earn"><span style="width: 90%"></span></span>
    </div>
  </article>`;
}

function rhythmStrip(rhythm: HomeView["rhythm"]): SafeHtml {
  return html`<section class="o-rhythm" aria-label="Days you showed up, last two weeks">
    <p class="o-kicker">Rhythm · last 14 days</p>
    <ol>
      ${rhythm.map(
        (d) =>
          html`<li
            class="${d.on ? "is-on" : ""} ${d.today ? "is-today" : ""}"
            title="${d.day}"
          ></li>`,
      )}
    </ol>
  </section>`;
}

function modulesStrip(): SafeHtml {
  return html`<nav class="o-modules" aria-label="Modules">
    ${MODULES.map((m) =>
      m.href
        ? html`<a class="o-chip is-${m.status}" href="${m.href}" data-layer="${m.layer}"
            >${m.name} · ${STATUS_LABEL[m.status]}</a
          >`
        : html`<span class="o-chip is-${m.status}" data-layer="${m.layer}"
            >${m.name} · ${STATUS_LABEL[m.status]}</span
          >`,
    )}
  </nav>`;
}

export function renderHome(view: HomeView): SafeHtml {
  return html`<section class="orient">
    <header class="o-head">
      <p class="o-date">${dateLine(view.now)} · ${dayTitle(view.now)}</p>
      <h1 class="o-title">Welcome back</h1>
      <p class="o-sub">Here's how your attention moved, and one good place to start.</p>
    </header>
    <div class="o-top">${startHere(view.roundSize)} ${flowSection(view.flow)}</div>
    <h2 class="o-h">Khaos is holding these for you</h2>
    <div class="o-panels">
      ${resurfacedCard(view.resurfaced, view.now)} ${parkedPanel()} ${receiptsPanel()}
    </div>
    <h2 class="o-h">Learning how you work</h2>
    <div class="o-panels is-two">${patternsPanel()} ${guardPanel()}</div>
    <footer class="o-foot">${rhythmStrip(view.rhythm)} ${modulesStrip()}</footer>
  </section>`;
}
