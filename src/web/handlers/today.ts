import { z } from "zod";
import * as db from "../../db.ts";
import * as resurface from "../../resurface.ts";
import { REGISTRY } from "../../connectors/registry.ts";
import { cookieValue } from "../../hosted.ts";
import { objectBody } from "../http.ts";
import { connection } from "../state.ts";
import { htmlResponse } from "../static.ts";
import type { SafeHtml } from "../views/html.ts";
import { thumbFor } from "../views/media.ts";
import { renderPage } from "../views/page.ts";
import {
  ROUND_SIZES,
  renderPiles,
  renderToday,
  renderUpNext,
  renderWhisper,
  renderWins,
  reentryLine,
  type PileView,
} from "../views/today.ts";
import { smartDeal } from "./clear.ts";
import { restorePile, restPile, sweepList, SWEEP_EXCLUSIONS } from "./sweeps.ts";

const DEFAULT_ROUND = 10;

const DEFAULT_GOAL = 8;

const TODAY_PILES = 3;

const MOSAIC_TILES = 3;

const YEAR_SECONDS = 365 * 86_400;

const HxSweepApply = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("subreddit"),
    source: z.literal("reddit"),
    subreddit: z.string().trim().min(1),
  }),
  z.object({
    kind: z.literal("age"),
    source: z.string().trim().min(1),
    before_utc: z.coerce.number().int().positive(),
  }),
]);

const HxSweepUndo = z.object({ wave: z.coerce.number().int().positive() });

const HxCluster = z.object({ cluster: z.string().trim().min(1) });

const HxClusterUndo = HxCluster.extend({ decayed_at: z.coerce.number().int().positive() });

type Toast = {
  msg: string;
  undo?: { post: string; vals: Record<string, string | number>; target: string };
};

function roundSize(request: Request, url: URL): number {
  const pick = (value: string | null) => ROUND_SIZES.find((size) => String(size) === value);

  return (
    pick(url.searchParams.get("n")) ?? pick(cookieValue(request, "ch_round_size")) ?? DEFAULT_ROUND
  );
}

function sizeCookie(n: number): string {
  return `ch_round_size=${n}; Path=/; SameSite=Lax; Max-Age=${YEAR_SECONDS}`;
}

function triggerHeader(events: { "ch:wins"?: null; "ch:toast"?: Toast }): string {
  return JSON.stringify(events).replace(
    /[\u007f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function fragment(body: SafeHtml, headers: Record<string, string> = {}): Response {
  return htmlResponse(body.toString(), { headers });
}

export function todayPage(request: Request, url: URL): Response {
  if (url.searchParams.has("deck")) return Response.redirect("/clear", 302);
  const n = roundSize(request, url);
  const now = Date.now();

  const body = renderToday({
    now: new Date(now),
    reentry: reentryLine(cookieValue(request, "ch_last_round"), now),
    n,
  });

  return htmlResponse(renderPage({ title: "Today", tab: "today", body }), {
    headers: { "Set-Cookie": sizeCookie(n) },
  });
}

export function upNext(request: Request, url: URL): Response {
  const n = roundSize(request, url);
  const items = smartDeal(n, cookieValue(request, "ch_safe") !== "0");

  return fragment(renderUpNext(items, n), { "Set-Cookie": sizeCookie(n) });
}

export function wins(request: Request): Response {
  const pulse = db.pulse(connection());
  const goal = Number.parseInt(cookieValue(request, "ch_goal"), 10);

  return fragment(
    renderWins({
      today: pulse.cleared_today + pulse.swept_today,
      total: pulse.cleared_total,
      goal: Number.isInteger(goal) && goal >= 0 ? Math.min(goal, 50) : DEFAULT_GOAL,
    }),
  );
}

function yearOf(utc: number): number {
  return new Date(utc * 1000).getFullYear();
}

function pileView(sweep: db.Sweep): PileView {
  const database = connection();

  const thumbs = db
    .sweepSampleItems(database, sweep, MOSAIC_TILES * 3, SWEEP_EXCLUSIONS)
    .map(thumbFor)
    .filter(Boolean)
    .slice(0, MOSAIC_TILES);

  const span = db.sweepSpan(database, sweep, SWEEP_EXCLUSIONS);
  const common = { label: sweep.label, count: sweep.count, thumbs, source: sweep.source };

  const years = {
    firstYear: span ? yearOf(span.first) : null,
    lastYear: span ? yearOf(span.last) : null,
  };

  if (sweep.kind === "subreddit") {
    const subreddit = sweep.subreddit ?? "";

    return {
      ...common,
      ...years,
      glyph: "r/",
      peekQuery: `subreddit:${subreddit.toLowerCase()}`,
      vals: { kind: "subreddit", source: "reddit", subreddit },
    };
  }

  const beforeUtc = sweep.before_utc ?? 0;

  return {
    ...common,
    ...years,
    glyph: (REGISTRY[sweep.source]?.label ?? sweep.source).slice(0, 1).toUpperCase(),
    peekQuery: `source:${sweep.source} before:${new Date(beforeUtc * 1000).toISOString().slice(0, 10)}`,
    vals: { kind: "age", source: sweep.source, before_utc: beforeUtc },
  };
}

function pilesHtml(): SafeHtml {
  return renderPiles(sweepList(TODAY_PILES).map(pileView));
}

export function piles(): Response {
  return fragment(pilesHtml());
}

function pileName(body: z.infer<typeof HxSweepApply>): string {
  if (body.kind === "subreddit") return `r/${body.subreddit} saves`;

  const month = new Date(body.before_utc * 1000).toLocaleString("en-US", {
    month: "short",
    year: "numeric",
  });

  return `${REGISTRY[body.source]?.label ?? body.source} saves from before ${month}`;
}

export async function applyPile(request: Request): Promise<Response> {
  const body = await objectBody(request, HxSweepApply);
  const result = restPile(body);

  const toast: Toast =
    result.decayed_at === null || result.total === 0
      ? { msg: "That pile was already clear." }
      : {
          msg: `${result.total.toLocaleString("en-US")} ${pileName(body)} rested.`,
          undo: { post: "/hx/sweeps/undo", vals: { wave: result.decayed_at }, target: "#piles" },
        };

  return fragment(pilesHtml(), {
    "HX-Trigger": triggerHeader({ "ch:wins": null, "ch:toast": toast }),
  });
}

export async function undoPile(request: Request): Promise<Response> {
  const body = await objectBody(request, HxSweepUndo);

  restorePile(body.wave);

  return fragment(pilesHtml(), {
    "HX-Trigger": triggerHeader({ "ch:wins": null, "ch:toast": { msg: "Back in the pile." } }),
  });
}

export function whisper(): Response {
  return fragment(renderWhisper(resurface.candidate(connection())));
}

function clusterLabel(cluster: string): string {
  const [kind, ...rest] = cluster.split(":");
  const name = rest.join(":");

  return kind === "subreddit" ? `r/${name}` : name;
}

function unknownCluster(): Response {
  return new Response("unknown cluster", { status: 400 });
}

export async function dismissWhisper(request: Request): Promise<Response> {
  const body = await objectBody(request, HxCluster);

  try {
    resurface.dismiss(connection(), body.cluster);
  } catch {
    return unknownCluster();
  }

  return fragment(renderWhisper(null), {
    "HX-Trigger": triggerHeader({ "ch:toast": { msg: "Okay. It'll stay quiet for a while." } }),
  });
}

export async function letgoWhisper(request: Request): Promise<Response> {
  const body = await objectBody(request, HxCluster);
  let result: resurface.LetgoResult;

  try {
    result = resurface.letgo(connection(), body.cluster);
  } catch {
    return unknownCluster();
  }

  const msg = `${clusterLabel(body.cluster)} is resting now.`;

  const toast: Toast =
    result.decayed_at === null
      ? { msg }
      : {
          msg,
          undo: {
            post: "/hx/whisper/undo",
            vals: { cluster: body.cluster, decayed_at: result.decayed_at },
            target: "#whisper",
          },
        };

  return fragment(renderWhisper(null), {
    "HX-Trigger": triggerHeader({ "ch:wins": null, "ch:toast": toast }),
  });
}

export async function undoWhisper(request: Request): Promise<Response> {
  const body = await objectBody(request, HxClusterUndo);

  try {
    resurface.undoLetgo(connection(), body.cluster, body.decayed_at);
  } catch {
    return unknownCluster();
  }

  return fragment(renderWhisper(null), {
    "HX-Trigger": triggerHeader({ "ch:wins": null, "ch:toast": { msg: "Back in the pile." } }),
  });
}
