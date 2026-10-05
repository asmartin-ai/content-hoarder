import { z } from "zod";
import type { Database } from "bun:sqlite";
import { decay, decayFullnames, getSetting, setSetting, undecay } from "./db.ts";
import { RESURFACE_SUBREDDITS, RESURFACE_TAGS } from "./categorize.ts";

export const STATE_KEY = "resurfacing_state";

export const NO_RENAG_DAYS = 30;

export const NEVER_UTC = Number.MAX_SAFE_INTEGER;

export const MIN_CLUSTER = 10;

export const DORMANT_DAYS = 90;

export const REACTIVATION_DAYS = 14;

export const FALLBACK_SCORE = 0.0245;

const DAY = 86400;

const StateSchema = z
  .object({ _served_on: z.string().optional() })
  .catchall(
    z
      .object({ dismissed_until: z.number().optional(), last_shown: z.number().optional() })
      .catch({}),
  );

type ResurfacingState = z.infer<typeof StateSchema>;

function readState(db: Database): ResurfacingState {
  try {
    return StateSchema.parse(JSON.parse(getSetting(db, STATE_KEY) ?? "{}"));
  } catch {
    return {};
  }
}

function saveState(db: Database, state: ResurfacingState): void {
  setSetting(db, STATE_KEY, JSON.stringify(state));
}

const entries = [
  ...RESURFACE_TAGS.map((tag) => ({ key: `tag:${tag}`, tag, subreddit: null })),
  ...RESURFACE_SUBREDDITS.map((subreddit) => ({
    key: `subreddit:${subreddit}`,
    tag: null,
    subreddit,
  })),
];

export function clusters(): Array<[string, string | null, string | null]> {
  return entries.map(({ key, tag, subreddit }) => [key, tag, subreddit]);
}

interface ClusterCriteria {
  tag: string | null;
  subreddit: string | null;
}

function parseCluster(cluster: string): ClusterCriteria {
  const found = entries.find((entry) => entry.key === cluster);

  if (!found) throw new Error(`unknown cluster: ${JSON.stringify(cluster)}`);

  return { tag: found.tag, subreddit: found.subreddit };
}

function where(tag: string | null, subreddit: string | null): [string, (string | number)[]] {
  if (tag) return ["EXISTS (SELECT 1 FROM json_each(metadata,'$.tags') WHERE value=?)", [tag]];

  return ["lower(json_extract(metadata,'$.subreddit'))=?", [subreddit?.toLowerCase() ?? ""]];
}

export interface ResurfaceCard {
  cluster: string;
  label: string;
  count: number;
  last_added_utc: number;
  reactivated: boolean;
  sample: Array<{ fullname: string; title: string; thumbnail: string | null }>;
  query: string;
}

export interface LetgoResult {
  cluster: string;
  total: number;
  decayed_at: number | null;
}

export function candidate(
  db: Database,
  opts: { now?: number; rng?: { choice<T>(items: T[]): T } } = {},
): ResurfaceCard | null {
  const now = opts.now || Math.floor(Date.now() / 1000);
  const state = readState(db);
  const date = new Date(now * 1000);
  const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

  if (state._served_on === today) return null;

  const scored: Array<{
    rank: number;
    score: number;
    key: string;
    tag: string | null;
    subreddit: string | null;
    count: number;
    lastAdded: number;
    reactivated: boolean;
  }> = [];

  for (const { key, tag, subreddit } of entries) {
    if ((state[key]?.dismissed_until ?? 0) > now) continue;
    const [predicate, params] = where(tag, subreddit);

    // SAFETY: This aggregate query aliases and selects exactly the declared columns.
    const aggregate = db
      .query(
        `SELECT COUNT(*) AS count,MAX(first_seen_utc) AS last_added,AVG(json_extract(metadata,'$.triage_score')) AS mean_score FROM items WHERE status='inbox' AND ${predicate}`,
      )
      .get(...params) as { count: number; last_added: number | null; mean_score: number | null };

    const lastAdded = aggregate.last_added ?? 0;

    if (aggregate.count < MIN_CLUSTER) continue;

    // SAFETY: MAX(first_seen_utc) is the sole selected nullable column.
    const priorRow = db
      .query(
        `SELECT MAX(first_seen_utc) AS prior FROM items WHERE status='inbox' AND ${predicate} AND first_seen_utc<?`,
      )
      .get(...params, now - REACTIVATION_DAYS * DAY) as { prior: number | null };

    const prior = priorRow.prior ?? 0;

    const reactivated =
      lastAdded >= now - REACTIVATION_DAYS * DAY && prior > 0 && prior <= now - DORMANT_DAYS * DAY;

    const dormantDays = (now - lastAdded) / DAY;

    if (!reactivated && dormantDays < DORMANT_DAYS) continue;
    scored.push({
      rank: reactivated ? 1 : 0,
      score: (aggregate.mean_score ?? FALLBACK_SCORE) * Math.max(dormantDays / 30, 1),
      key,
      tag,
      subreddit,
      count: aggregate.count,
      lastAdded,
      reactivated,
    });
  }

  if (!scored.length) return null;
  scored.sort((a, b) => b.rank - a.rank || b.score - a.score);
  const finalists = scored.slice(0, 3);

  const picked = opts.rng
    ? opts.rng.choice(finalists)
    : finalists[Math.floor(Math.random() * finalists.length)]!;

  const [predicate, params] = where(picked.tag, picked.subreddit);

  // SAFETY: The SELECT aliases match the sample row contract.
  const sample = db
    .query(
      `SELECT fullname,title,json_extract(metadata,'$.thumbnail') AS thumbnail FROM items WHERE status='inbox' AND ${predicate} ORDER BY first_seen_utc DESC LIMIT 3`,
    )
    .all(...params) as Array<{ fullname: string; title: string; thumbnail: string | null }>;

  state[picked.key] = { ...state[picked.key], last_shown: now };
  state._served_on = today;
  saveState(db, state);

  return {
    cluster: picked.key,
    label: picked.subreddit ? `r/${picked.subreddit}` : (picked.tag ?? ""),
    count: picked.count,
    last_added_utc: picked.lastAdded,
    reactivated: picked.reactivated,
    sample,
    query: `${picked.subreddit ? "subreddit" : "tag"}:${picked.subreddit ?? picked.tag} status:inbox`,
  };
}

export function dismiss(
  db: Database,
  cluster: string,
  opts: { days?: number; now?: number } = {},
): void {
  parseCluster(cluster);
  const now = opts.now || Math.floor(Date.now() / 1000);
  const state = readState(db);
  state[cluster] = { ...state[cluster], dismissed_until: now + (opts.days ?? NO_RENAG_DAYS) * DAY };
  saveState(db, state);
}

export function letgo(db: Database, cluster: string, opts: { now?: number } = {}): LetgoResult {
  const { tag, subreddit } = parseCluster(cluster);

  const result = decay(db, {
    tags: tag ? [tag] : null,
    subreddits: subreddit ? [subreddit] : null,
    apply: true,
    now: opts.now,
  });

  const state = readState(db);
  state[cluster] = { ...state[cluster], dismissed_until: NEVER_UTC };
  saveState(db, state);

  return { cluster, total: Number(result.total), decayed_at: result.decayed_at };
}

export interface UndoLetgoResult {
  cluster: string;
  total: number;
}

export function undoLetgo(db: Database, cluster: string, wave: number): UndoLetgoResult {
  parseCluster(cluster);

  const result = undecay(db, {
    decayedAfter: Math.trunc(wave),
    decayedBefore: Math.trunc(wave) + 1,
    apply: true,
  });

  const state = readState(db);
  const clusterState = state[cluster];

  if (clusterState) {
    delete clusterState.dismissed_until;
    saveState(db, state);
  }

  return { cluster, total: Number(result.total) };
}

export interface SnoozeEscalation {
  total: number;
  applied: boolean;
  decayed_at: number | null;
  label: string;
  escalate_after: number;
  now: number;
  sample: string[];
}

export function escalateSnoozed(
  db: Database,
  opts: { escalateAfter?: number; now?: number; apply?: boolean; limit?: number } = {},
): SnoozeEscalation {
  const threshold = opts.escalateAfter ?? 3;

  if (threshold < 1) throw new Error("escalate_after must be >= 1");
  const now = opts.now || Math.floor(Date.now() / 1000);
  const limit = opts.limit === undefined ? "" : " LIMIT ?";
  const params: number[] = opts.limit === undefined ? [threshold] : [threshold, opts.limit];

  // SAFETY: The query selects only the two declared item columns.
  const rows = db
    .query(
      `SELECT fullname,title FROM items WHERE status='inbox' AND CAST(COALESCE(json_extract(metadata,'$.snooze_count'),0) AS INTEGER)>=? ORDER BY first_seen_utc ASC,fullname ASC${limit}`,
    )
    .all(...params) as Array<{ fullname: string; title: string }>;

  const result: SnoozeEscalation = {
    total: rows.length,
    applied: false,
    decayed_at: null,
    label: "snooze-escalated",
    escalate_after: threshold,
    now,
    sample: rows.slice(0, 5).map((row) => `${row.fullname}: ${(row.title || "").slice(0, 60)}`),
  };

  if (opts.apply) {
    if (!rows.length) result.applied = true;
    else {
      const decayed = decayFullnames(db, {
        fullnames: rows.map(({ fullname }) => fullname),
        label: "snooze-escalated",
        apply: true,
      });

      result.total = Number(decayed.total);
      result.applied = true;
      result.decayed_at = decayed.decayed_at;
    }
  }

  return result;
}
