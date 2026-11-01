import type { z } from "zod";
import * as db from "../../db.ts";
import { RESURFACE_SUBREDDITS, RESURFACE_TAGS } from "../../categorize.ts";
import { REGISTRY } from "../../connectors/registry.ts";
import { clamp, json, numberParam, objectBody } from "../http.ts";
import { connection } from "../state.ts";
import { SweepApplyBody, SweepUndoBody } from "../schemas.ts";

export const SWEEP_EXCLUSIONS = {
  excludeSubreddits: RESURFACE_SUBREDDITS,
  excludeTags: RESURFACE_TAGS,
};

export function sweepList(limit: number): db.Sweep[] {
  return db.sweepCandidates(connection(), {
    limit,
    ...SWEEP_EXCLUSIONS,
    sourceLabel: (source) => REGISTRY[source]?.label ?? source,
  });
}

export function listSweeps(url: URL): Response {
  return json({ sweeps: sweepList(clamp(numberParam(url.searchParams.get("limit"), 6), 1, 12)) });
}

export function restPile(body: z.infer<typeof SweepApplyBody>): db.DecayResult {
  return body.kind === "subreddit"
    ? db.decay(connection(), {
        ...SWEEP_EXCLUSIONS,
        source: body.source,
        subreddits: [body.subreddit],
        label: "sweep",
        apply: true,
      })
    : db.decay(connection(), {
        ...SWEEP_EXCLUSIONS,
        source: body.source,
        beforeUtc: body.before_utc,
        label: "sweep",
        apply: true,
      });
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
