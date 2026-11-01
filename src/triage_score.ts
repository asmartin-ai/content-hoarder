import { z } from "zod";
import type { Database } from "bun:sqlite";
import { getSetting, setSetting, withTransaction } from "./db.ts";
import { parseMetadata, type Metadata } from "./models.ts";

export const MODEL_SETTING_KEY = "triage_model";

const PROCESSED = ["done", "keep", "archived"] as const;

const DAY = 86400;

const AGE_BUCKETS: Array<[number, string]> = [
  [30 * DAY, "<30d"],
  [90 * DAY, "30-90d"],
  [365 * DAY, "90d-1y"],
  [2 * 365 * DAY, "1-2y"],
  [4 * 365 * DAY, "2-4y"],
  [Infinity, ">=4y"],
];

const ScoreModelSchema = z.object({
  version: z.literal(1),
  fitted_utc: z.number(),
  trained_on: z.number(),
  processed: z.number(),
  prior: z.number(),
  alpha: z.number(),
  min_support: z.number(),
  features: z.record(z.string(), z.tuple([z.number(), z.number(), z.number()])),
});

export type ScoreModel = z.infer<typeof ScoreModelSchema>;

export interface DriftResult {
  features_added: string[];
  features_dropped: string[];
  rate_drift: {
    shared: number;
    max_abs_delta: number;
    mean_abs_delta: number;
    top_movers: Array<{
      feature: string;
      old_rate: number;
      new_rate: number;
      delta: number;
      abs_delta: number;
    }>;
  };
  prior_drift: { old: number; new: number; delta: number; abs_delta: number };
  drift_score: number;
}

export interface LearnResult {
  applied: boolean;
  trained_on: number;
  processed: number;
  prior: number;
  features_kept: number;
  scored: number;
  top_features: Array<{ feature: string; n: number; k: number; rate: number }>;
  sample: Array<{ score: number; item: string; why: string[] }>;
}

export interface DriftReport {
  applied: boolean;
  has_previous: boolean;
  previous_fitted_utc: number | null;
  current_fitted_utc: number;
  new_decisions: number;
  current: { trained_on: number; processed: number; prior: number; features_kept: number };
  drift: DriftResult | null;
  refit?: LearnResult;
}

function ageBucket(age: number): string {
  return AGE_BUCKETS.find(([limit]) => age < limit)![1];
}

export function extractFeatures(
  row: { source?: string; kind?: string; created_utc?: number; first_seen_utc?: number },
  metadata: Metadata,
  opts: { now?: number } = {},
): string[] {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const features = [`sk:${row.source || "?"}/${row.kind || "?"}`];
  const subreddit = String(metadata.subreddit ?? "").toLowerCase();
  const channel = String(metadata.channel ?? "").toLowerCase();

  if (subreddit) features.push(`sub:${subreddit}`);

  if (channel) features.push(`chan:${channel}`);

  if (metadata.media_type) features.push(`media:${metadata.media_type}`);

  if (metadata.category) features.push(`cat:${metadata.category}`);
  const created = Number(row.created_utc || 0);
  const anchor = created > 0 ? created : Number(row.first_seen_utc || now);
  features.push(`age:${ageBucket(Math.max(0, now - anchor))}`);

  return features;
}

export function fit(db: Database, opts: { minSupport?: number; alpha?: number } = {}): ScoreModel {
  const minSupport = opts.minSupport ?? 20;
  const alpha = opts.alpha ?? 50;
  const now = Math.floor(Date.now() / 1000);

  const rows = db
    .query(
      "SELECT source,kind,status,created_utc,first_seen_utc,metadata FROM items WHERE json_extract(metadata,'$.decayed_at') IS NULL AND json_extract(metadata,'$.decay_label') IS NULL",
    )
    .all() as Array<{
    source: string;
    kind: string;
    status: string;
    created_utc: number;
    first_seen_utc: number;
    metadata: string;
  }>;

  let processed = 0;
  const counts = new Map<string, [number, number]>();

  for (const row of rows) {
    const positive = PROCESSED.some((status) => status === row.status);

    if (positive) processed++;

    for (const feature of extractFeatures(row, parseMetadata(row.metadata), { now })) {
      const count = counts.get(feature) ?? [0, 0];
      count[0]++;

      if (positive) count[1]++;
      counts.set(feature, count);
    }
  }

  const prior = rows.length ? processed / rows.length : 0;
  const features: ScoreModel["features"] = {};

  for (const [feature, [n, k]] of counts)
    if (n >= minSupport)
      features[feature] = [n, k, Number(((k + alpha * prior) / (n + alpha)).toFixed(6))];

  return {
    version: 1,
    fitted_utc: now,
    trained_on: rows.length,
    processed,
    prior: Number(prior.toFixed(6)),
    alpha,
    min_support: minSupport,
    features,
  };
}

export interface SkipBucket {
  feature: string;
  n: number;
  k: number;
  processed_rate: number;
  skip_rate: number;
}

export function highSkipBuckets(
  model: ScoreModel,
  opts: { minSkipRate?: number; minSupport?: number } = {},
): SkipBucket[] {
  const minSkipRate = opts.minSkipRate ?? 0.9;
  const minSupport = opts.minSupport ?? 2;

  return Object.entries(model.features)
    .flatMap(([feature, [n, k, processedRate]]) =>
      n >= minSupport && 1 - processedRate >= minSkipRate
        ? [{ feature, n, k, processed_rate: processedRate, skip_rate: 1 - processedRate }]
        : [],
    )
    .sort((a, b) => a.feature.localeCompare(b.feature));
}

export function autoArchivePlan(
  db: Database,
  opts: { minSkipRate?: number; minSupport?: number; source?: string } = {},
) {
  const raw = getSetting(db, MODEL_SETTING_KEY);
  const model = raw ? ScoreModelSchema.parse(JSON.parse(raw)) : null;

  if (!model)
    return {
      applied: false,
      model_present: false,
      model_fitted_utc: null,
      actionable: [],
      informational: [],
      total_actionable: 0,
    };
  const actionable: Array<SkipBucket & { inbox_count: number; subreddit: string }> = [];
  const informational: SkipBucket[] = [];

  for (const bucket of highSkipBuckets(model, opts)) {
    if (bucket.feature.startsWith("sub:")) {
      const subreddit = bucket.feature.slice(4);

      const count = db
        .query(
          "SELECT COUNT(*) AS c FROM items WHERE status='inbox' AND source=? AND lower(json_extract(metadata,'$.subreddit'))=?",
        )
        .get(opts.source ?? "reddit", subreddit) as { c: number };

      actionable.push({ ...bucket, inbox_count: count.c, subreddit });
    } else informational.push(bucket);
  }

  return {
    applied: false,
    model_present: true,
    model_fitted_utc: model.fitted_utc,
    actionable,
    informational,
    total_actionable: actionable.reduce((sum, bucket) => sum + bucket.inbox_count, 0),
  };
}

function featureRate(value: [number, number, number] | undefined): number {
  return value?.[2] ?? 0;
}

function logit(value: number): number {
  const p = Math.min(Math.max(value, 1e-4), 1 - 1e-4);

  return Math.log(p / (1 - p));
}

export function drift(
  previous: ScoreModel,
  current: ScoreModel,
  opts: { topN?: number } = {},
): DriftResult {
  const oldKeys = new Set(Object.keys(previous.features));
  const newKeys = new Set(Object.keys(current.features));
  const shared = [...oldKeys].filter((feature) => newKeys.has(feature)).sort();

  const movers = shared
    .map((feature) => {
      const oldRate = featureRate(previous.features[feature]);
      const newRate = featureRate(current.features[feature]);
      const delta = newRate - oldRate;

      return {
        feature,
        old_rate: Number(oldRate.toFixed(6)),
        new_rate: Number(newRate.toFixed(6)),
        delta: Number(delta.toFixed(6)),
        abs_delta: Number(Math.abs(delta).toFixed(6)),
      };
    })
    .sort((a, b) => b.abs_delta - a.abs_delta || a.feature.localeCompare(b.feature));

  const mean = movers.length
    ? movers.reduce((sum, mover) => sum + mover.abs_delta, 0) / movers.length
    : 0;

  const priorDelta = current.prior - previous.prior;

  return {
    features_added: [...newKeys].filter((key) => !oldKeys.has(key)).sort(),
    features_dropped: [...oldKeys].filter((key) => !newKeys.has(key)).sort(),
    rate_drift: {
      shared: shared.length,
      max_abs_delta: Math.max(0, ...movers.map((mover) => mover.abs_delta)),
      mean_abs_delta: Number(mean.toFixed(6)),
      top_movers: movers.slice(0, opts.topN ?? 10),
    },
    prior_drift: {
      old: Number(previous.prior.toFixed(6)),
      new: Number(current.prior.toFixed(6)),
      delta: Number(priorDelta.toFixed(6)),
      abs_delta: Number(Math.abs(priorDelta).toFixed(6)),
    },
    drift_score: Number(mean.toFixed(6)),
  };
}

function newDecisionsSince(db: Database, sinceUtc: number | null): number {
  if (sinceUtc === null) return 0;

  return (
    db
      .query(
        "SELECT COUNT(*) AS c FROM items WHERE processed_utc IS NOT NULL AND processed_utc>? AND status IN (?,?,?) AND json_extract(metadata,'$.decayed_at') IS NULL AND json_extract(metadata,'$.decay_label') IS NULL",
      )
      .get(sinceUtc, ...PROCESSED) as { c: number }
  ).c;
}

export function scoreItem(model: ScoreModel, featureList: string[]): [number, string[]] {
  const prior = model.prior || 1e-4;
  const base = logit(prior);
  let z = base;
  const contributions: Array<[number, string]> = [];

  for (const feature of featureList) {
    const entry = model.features[feature];

    if (!entry) continue;
    const delta = logit(entry[2]) - base;
    z += delta;

    if (Math.abs(delta) > 1e-9)
      contributions.push([Math.abs(delta), `${feature} ×${(entry[2] / prior).toFixed(1)}`]);
  }

  contributions.sort((a, b) => b[0] - a[0] || b[1].localeCompare(a[1]));

  return [1 / (1 + Math.exp(-z)), contributions.slice(0, 3).map(([, reason]) => reason)];
}

export function learn(
  db: Database,
  opts: {
    apply?: boolean;
    minSupport?: number;
    alpha?: number;
    limit?: number;
    samples?: number;
  } = {},
): LearnResult {
  const apply = opts.apply ?? false;
  const model = fit(db, opts);
  const params: number[] = [];
  const limit = opts.limit ? " LIMIT ?" : "";

  if (opts.limit) params.push(Math.trunc(opts.limit));

  const rows = db
    .query(
      `SELECT fullname,source,kind,created_utc,first_seen_utc,metadata FROM items WHERE status='inbox'${limit}`,
    )
    .all(...params) as Array<{
    fullname: string;
    source: string;
    kind: string;
    created_utc: number;
    first_seen_utc: number;
    metadata: string;
  }>;

  const top: Array<{ score: number; item: string; why: string[] }> = [];
  withTransaction(db, () => {
    for (const row of rows) {
      const metadata = parseMetadata(row.metadata);

      const [score, why] = scoreItem(
        model,
        extractFeatures(row, metadata, { now: model.fitted_utc }),
      );

      top.push({
        score,
        item: `${metadata.subreddit ? `r/${metadata.subreddit}: ` : ""}${row.fullname}`,
        why,
      });

      if (apply) {
        metadata.triage_score = Number(score.toFixed(4));
        metadata.triage_why = why;
        db.query("UPDATE items SET metadata=? WHERE fullname=?").run(
          JSON.stringify(metadata),
          row.fullname,
        );
      }
    }

    if (apply) setSetting(db, MODEL_SETTING_KEY, JSON.stringify(model));
  });
  top.sort((a, b) => b.score - a.score || b.item.localeCompare(a.item));

  const strongest = Object.entries(model.features).sort(
    (a, b) =>
      Math.abs(logit(b[1][2]) - logit(model.prior || 1e-4)) -
      Math.abs(logit(a[1][2]) - logit(model.prior || 1e-4)),
  );

  return {
    applied: apply,
    trained_on: model.trained_on,
    processed: model.processed,
    prior: model.prior,
    features_kept: Object.keys(model.features).length,
    scored: rows.length,
    top_features: strongest
      .slice(0, 15)
      .map(([feature, [n, k, rate]]) => ({ feature, n, k, rate })),
    sample: top
      .slice(0, opts.samples ?? 10)
      .map(({ score, item, why }) => ({ score: Number(score.toFixed(4)), item, why })),
  };
}

export function driftReport(
  db: Database,
  opts: {
    apply?: boolean;
    minSupport?: number;
    alpha?: number;
    limit?: number;
    samples?: number;
    sinceProcessed?: number;
  } = {},
): DriftReport {
  const stored = getSetting(db, MODEL_SETTING_KEY);
  const previous = stored ? ScoreModelSchema.parse(JSON.parse(stored)) : null;
  const current = fit(db, opts);
  const since = opts.sinceProcessed ?? (previous ? previous.fitted_utc : null);

  const report: DriftReport = {
    applied: false,
    has_previous: previous !== null,
    previous_fitted_utc: previous?.fitted_utc ?? null,
    current_fitted_utc: current.fitted_utc,
    new_decisions: newDecisionsSince(db, since),
    current: {
      trained_on: current.trained_on,
      processed: current.processed,
      prior: current.prior,
      features_kept: Object.keys(current.features).length,
    },
    drift: previous ? drift(previous, current) : null,
  };

  if (opts.apply) {
    report.refit = learn(db, opts);
    report.applied = true;
  }

  return report;
}
