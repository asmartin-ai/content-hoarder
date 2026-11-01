import * as db from "../../db.ts";
import { RESURFACE_SUBREDDITS, RESURFACE_TAGS } from "../../categorize.ts";
import { REGISTRY } from "../../connectors/registry.ts";
import { clamp, json, numberParam, objectBody } from "../http.ts";
import { connection } from "../state.ts";
import { SweepApplyBody, SweepUndoBody } from "../schemas.ts";

export function listSweeps(url: URL): Response {
  return json({
    sweeps: db.sweepCandidates(connection(), {
      limit: clamp(numberParam(url.searchParams.get("limit"), 6), 1, 12),
      excludeSubreddits: RESURFACE_SUBREDDITS,
      excludeTags: RESURFACE_TAGS,
      sourceLabel: (source) => REGISTRY[source]?.label ?? source,
    }),
  });
}

/**
 * Rest a whole pile with one reversible, wave-stamped `decay` (never
 * routed through bulkSetStatus, so it cannot enqueue Reddit unsaves).
 */
export async function applySweep(request: Request): Promise<Response> {
  const body = await objectBody(request, SweepApplyBody);
  const knowledge = { excludeSubreddits: RESURFACE_SUBREDDITS, excludeTags: RESURFACE_TAGS };

  const result =
    body.kind === "subreddit"
      ? db.decay(connection(), {
          ...knowledge,
          source: body.source,
          subreddits: [body.subreddit],
          label: "sweep",
          apply: true,
        })
      : db.decay(connection(), {
          ...knowledge,
          source: body.source,
          beforeUtc: body.before_utc,
          label: "sweep",
          apply: true,
        });

  return json({ total: result.total, wave: result.decayed_at });
}

export async function undoSweep(request: Request): Promise<Response> {
  const body = await objectBody(request, SweepUndoBody);

  // undecay's upper bound is exclusive; one wave id is one integer.
  const result = db.undecay(connection(), {
    decayedAfter: body.wave,
    decayedBefore: body.wave + 1,
    apply: true,
  });

  return json({ restored: result.total });
}
