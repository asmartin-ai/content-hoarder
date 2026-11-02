import type { z } from "zod";
import * as db from "../../db.ts";
import { track } from "../../demo_analytics.ts";
import { RESURFACE_SUBREDDITS, RESURFACE_TAGS } from "../../categorize.ts";
import { REGISTRY } from "../../connectors/registry.ts";
import * as triageScore from "../../triage_score.ts";
import { clamp, json, numberParam, objectBody } from "../http.ts";
import { connection } from "../state.ts";
import { SweepApplyBody, SweepUndoBody } from "../schemas.ts";

const LEARNED_MIN_DECIDED = 8;

const LEARNED_LETGO_RATE = 0.8;

export const SWEEP_EXCLUSIONS = {
  excludeSubreddits: RESURFACE_SUBREDDITS,
  excludeTags: RESURFACE_TAGS,
};

export type PileSweep = db.Sweep & { reason?: string };

export function sweepList(limit: number): db.Sweep[] {
  return db.sweepCandidates(connection(), {
    limit,
    ...SWEEP_EXCLUSIONS,
    sourceLabel: (source) => REGISTRY[source]?.label ?? source,
  });
}

export function learnedPiles(limit: number): PileSweep[] {
  if (limit <= 0) return [];

  const database = connection();
  const model = triageScore.loadModel(database);

  if (!model) return [];

  const excluded = new Set(RESURFACE_SUBREDDITS.map((sub) => sub.toLowerCase()));

  const candidates = triageScore
    .outcomeBuckets(model, { minDecided: LEARNED_MIN_DECIDED })
    .filter(
      (bucket) => bucket.feature.startsWith("sub:") && bucket.letgo_rate >= LEARNED_LETGO_RATE,
    )
    .map((bucket) => ({ bucket, key: bucket.feature.slice("sub:".length) }))
    .filter(({ key }) => key.length > 0 && !excluded.has(key))
    .sort(
      (a, b) =>
        b.bucket.letgo_rate - a.bucket.letgo_rate ||
        b.bucket.archived - a.bucket.archived ||
        a.key.localeCompare(b.key),
    );

  if (!candidates.length) return [];

  const eligible = db.decay(database, {
    ...SWEEP_EXCLUSIONS,
    subreddits: candidates.map(({ key }) => key),
    topSubs: candidates.length,
    samples: 0,
    apply: false,
  }).by_subreddit;

  const piles: PileSweep[] = [];

  for (const { bucket, key } of candidates) {
    const count = eligible[key] ?? 0;

    if (!count) continue;

    const samples = db.sweepSampleItems(
      database,
      { kind: "subreddit", source: "reddit", subreddit: key },
      3,
      SWEEP_EXCLUSIONS,
    );

    const subreddit = samples[0]?.metadata.subreddit ?? key;

    piles.push({
      id: `learned:subreddit:${key}`,
      kind: "subreddit",
      source: "reddit",
      subreddit,
      label: `r/${subreddit}`,
      count,
      sample: samples.map((item) => item.title.slice(0, 140)),
      reason: `You let go ${bucket.archived} of ${bucket.decided} from r/${subreddit}`,
    });

    if (piles.length >= limit) break;
  }

  return piles;
}

export function pileList(limit: number): PileSweep[] {
  const cap = Math.max(0, limit);
  const learned = learnedPiles(cap);

  if (learned.length >= cap) return learned;

  const taken = new Set(learned.map((pile) => (pile.subreddit ?? "").toLowerCase()));

  const rest = sweepList(cap + taken.size).filter(
    (sweep) => sweep.kind !== "subreddit" || !taken.has((sweep.subreddit ?? "").toLowerCase()),
  );

  return [...learned, ...rest].slice(0, cap);
}

export function listSweeps(url: URL): Response {
  return json({ sweeps: pileList(clamp(numberParam(url.searchParams.get("limit"), 6), 1, 12)) });
}

export function restPile(body: z.infer<typeof SweepApplyBody>): db.DecayResult {
  const database = connection();

  const result =
    body.kind === "subreddit"
      ? db.decay(database, {
          ...SWEEP_EXCLUSIONS,
          source: body.source,
          subreddits: [body.subreddit],
          label: "sweep",
          apply: true,
        })
      : db.decay(database, {
          ...SWEEP_EXCLUSIONS,
          source: body.source,
          beforeUtc: body.before_utc,
          label: "sweep",
          apply: true,
        });

  track(database, "srv_sweep", {
    data: { applied: result.applied, total: result.total },
  });

  return result;
}

export function restorePile(wave: number): number {
  return db.undecay(connection(), {
    decayedAfter: wave,
    decayedBefore: wave + 1,
    apply: true,
  }).total;
}

export async function applySweep(request: Request): Promise<Response> {
  const result = restPile(await objectBody(request, SweepApplyBody));

  return json({ total: result.total, wave: result.decayed_at });
}

export async function undoSweep(request: Request): Promise<Response> {
  const body = await objectBody(request, SweepUndoBody);

  return json({ restored: restorePile(body.wave) });
}
