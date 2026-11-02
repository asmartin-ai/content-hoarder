import { z } from "zod";
import type { Database } from "bun:sqlite";
import { getSetting, setSetting, withTransaction } from "./db.ts";
import { LlmSuggestionSchema, parseMetadata, type Metadata } from "./models.ts";

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
  outcomes: z.record(z.string(), z.tuple([z.number(), z.number(), z.number()])).optional(),
  keep_prior: z.number().optional(),
});

export type ScoreModel = z.infer<typeof ScoreModelSchema>;

export function loadModel(db: Database): ScoreModel | null {
  const raw = getSetting(db, MODEL_SETTING_KEY);

  return raw ? ScoreModelSchema.parse(JSON.parse(raw)) : null;
}

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
  const llmVerdict = LlmSuggestionSchema.safeParse(metadata.llm);

  if (llmVerdict.success) features.push(`ai:${llmVerdict.data.verdict}`);

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
  let keptTotal = 0;
  const counts = new Map<string, [number, number]>();
  const outcomes = new Map<string, [number, number, number]>();

  for (const row of rows) {
    const positive = PROCESSED.some((status) => status === row.status);
    const keptRow = row.status === "keep" || row.status === "done";

    if (positive) processed++;

    if (keptRow) keptTotal++;

    for (const feature of extractFeatures(row, parseMetadata(row.metadata), { now })) {
      const count = counts.get(feature) ?? [0, 0];
      count[0]++;

      if (positive) count[1]++;
      counts.set(feature, count);

      if (positive) {
        const outcome = outcomes.get(feature) ?? [0, 0, 0];
        outcome[0]++;

        if (keptRow) outcome[1]++;

        if (row.status === "archived") outcome[2]++;
        outcomes.set(feature, outcome);
      }
    }
  }

  const prior = rows.length ? processed / rows.length : 0;
  const features: ScoreModel["features"] = {};
  const outcomeRecord: NonNullable<ScoreModel["outcomes"]> = {};

  for (const [feature, [n, k]] of counts)
    if (n >= minSupport)
      features[feature] = [n, k, Number(((k + alpha * prior) / (n + alpha)).toFixed(6))];

  for (const [feature, outcome] of outcomes) outcomeRecord[feature] = outcome;

  return {
    version: 1,
    fitted_utc: now,
    trained_on: rows.length,
    processed,
    prior: Number(prior.toFixed(6)),
    alpha,
    min_support: minSupport,
    features,
    outcomes: outcomeRecord,
    keep_prior: Number(((keptTotal + 1) / (processed + 2)).toFixed(6)),
  };
}

export interface OutcomeBucket {
  feature: string;
  decided: number;
  kept: number;
  archived: number;
  letgo_rate: number;
  keep_rate: number;
}

export function outcomeBuckets(
  model: ScoreModel,
  opts: { minDecided?: number } = {},
): OutcomeBucket[] {
  const minDecided = opts.minDecided ?? 8;
  const outcomes: Record<string, [number, number, number]> = model.outcomes ?? {};

  return Object.entries(outcomes)
    .flatMap(([feature, [decided, kept, archived]]) =>
      decided >= minDecided
        ? [
            {
              feature,
              decided,
              kept,
              archived,
              letgo_rate: Number((archived / decided).toFixed(6)),
              keep_rate: Number((kept / decided).toFixed(6)),
            },
          ]
        : [],
    )
    .sort(
      (a, b) =>
        b.letgo_rate - a.letgo_rate || b.decided - a.decided || a.feature.localeCompare(b.feature),
    );
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
  const model = loadModel(db);

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

const _HINT_MIN_DECIDED = 8;

const _SOURCE_LABELS = {
  reddit: "Reddit",
  youtube: "YouTube",
  hackernews: "Hacker News",
  twitter: "Twitter",
  obsidian: "Obsidian",
  keep: "Google Keep",
  firefox: "Firefox",
} satisfies Record<string, string>;

const _KIND_LABELS = {
  post: "posts",
  comment: "comments",
  video: "videos",
  story: "stories",
  tweet: "tweets",
  note: "notes",
  bookmark: "bookmarks",
  tab: "tabs",
  item: "items",
} satisfies Record<string, string>;

const _AGE_AGO = {
  "<30d": "from the last month",
  "30-90d": "from 1-3 months ago",
  "90d-1y": "from 3-12 months ago",
  "1-2y": "from 1-2 years ago",
  "2-4y": "from over 2 years ago",
  ">=4y": "from over 4 years ago",
} satisfies Record<string, string>;

function isSourceLabelKey(source: string): source is keyof typeof _SOURCE_LABELS {
  return Object.hasOwn(_SOURCE_LABELS, source);
}

function isKindLabelKey(kind: string): kind is keyof typeof _KIND_LABELS {
  return Object.hasOwn(_KIND_LABELS, kind);
}

function isAgeAgoKey(bucket: string): bucket is keyof typeof _AGE_AGO {
  return Object.hasOwn(_AGE_AGO, bucket);
}

const _FEATURE_PRIORITY = ["sub:", "chan:", "cat:", "media:", "ai:", "sk:", "age:"];

type TriageHint = { verdict: "keep" | "skip"; reason: string };

function featurePriority(feature: string): number {
  return _FEATURE_PRIORITY.findIndex((prefix) => feature.startsWith(prefix));
}

function skLabel(feature: string): string {
  const [source, kind] = feature.slice(3).split("/");

  if (!source) return "items";

  const sourceLabel = isSourceLabelKey(source)
    ? _SOURCE_LABELS[source]
    : source.charAt(0).toUpperCase() + source.slice(1);

  const kindLabel = kind ? (isKindLabelKey(kind) ? _KIND_LABELS[kind] : `${kind}s`) : "items";

  return `${sourceLabel} ${kindLabel}`;
}

function featureLabel(feature: string, metadata: Metadata): string {
  if (feature.startsWith("sub:")) return `r/${String(metadata.subreddit || feature.slice(4))}`;

  if (feature.startsWith("chan:")) return String(metadata.channel || feature.slice(5));

  if (feature.startsWith("sk:")) return skLabel(feature);

  if (feature.startsWith("age:")) {
    const bucket = feature.slice(4);

    return `content ${isAgeAgoKey(bucket) ? _AGE_AGO[bucket] : "from a while ago"}`;
  }

  if (feature.startsWith("media:")) return `saved ${feature.slice(6)}`;

  if (feature.startsWith("cat:")) return `filed as ${feature.slice(4)}`;

  if (feature === "ai:keep") return "items the AI suggested keeping";

  if (feature === "ai:skip") return "items the AI suggested letting go";

  return feature;
}

function hintSubject(feature: string, metadata: Metadata): string {
  if (feature.startsWith("sub:")) return `from r/${String(metadata.subreddit || feature.slice(4))}`;

  if (feature.startsWith("chan:")) return `from ${String(metadata.channel || feature.slice(5))}`;

  if (feature.startsWith("sk:")) return skLabel(feature);

  if (feature.startsWith("age:")) {
    const bucket = feature.slice(4);

    return `items ${isAgeAgoKey(bucket) ? _AGE_AGO[bucket] : "from a while ago"}`;
  }

  return featureLabel(feature, metadata);
}

function whyReason(feature: string, outcome: [number, number, number], metadata: Metadata): string {
  const [decided, kept, archived] = outcome;

  const verb =
    kept >= archived
      ? `kept or finished ${kept} of ${decided}`
      : `let go ${archived} of ${decided}`;

  return `${featureLabel(feature, metadata)}: ${verb}`;
}

function outcomeStrength(model: ScoreModel, outcome: [number, number, number]): number {
  const alpha = model.alpha || 1;
  const rate = (outcome[1] + alpha * 0.5) / (outcome[0] + alpha);

  return Math.abs(logit(rate) - logit(0.5));
}

function outcomeReasons(model: ScoreModel, featureList: string[], metadata: Metadata): string[] {
  return featureList
    .flatMap((feature) => {
      const outcome = model.outcomes?.[feature];
      const rank = featurePriority(feature);

      if (!outcome || outcome[0] < _HINT_MIN_DECIDED || rank < 0) return [];
      const strength = outcomeStrength(model, outcome);

      return strength > 1e-9 ? [{ feature, outcome, strength, rank }] : [];
    })
    .sort(
      (a, b) =>
        b.strength - a.strength ||
        b.outcome[0] - a.outcome[0] ||
        a.rank - b.rank ||
        a.feature.localeCompare(b.feature),
    )
    .slice(0, 3)
    .map(({ feature, outcome }) => whyReason(feature, outcome, metadata));
}

function keepProbability(model: ScoreModel, featureList: string[]): number {
  const base = model.keep_prior ?? 0.5;
  const alpha = model.alpha || 1;
  let best: { outcome: [number, number, number]; rank: number; feature: string } | null = null;

  for (const feature of featureList) {
    const outcome = model.outcomes?.[feature];
    const rank = featurePriority(feature);

    if (!outcome || outcome[0] < _HINT_MIN_DECIDED || rank < 0) continue;

    if (
      !best ||
      rank < best.rank ||
      (rank === best.rank &&
        (outcome[0] > best.outcome[0] ||
          (outcome[0] === best.outcome[0] && feature.localeCompare(best.feature) < 0)))
    )
      best = { outcome, rank, feature };
  }

  return best ? (best.outcome[1] + alpha * base) / (best.outcome[0] + alpha) : base;
}

function historyHint(
  model: ScoreModel,
  featureList: string[],
  metadata: Metadata,
): TriageHint | null {
  const candidates = featureList
    .flatMap((feature) => {
      const outcome = model.outcomes?.[feature];
      const rank = featurePriority(feature);

      if (!outcome || outcome[0] < _HINT_MIN_DECIDED || rank < 0) return [];

      const [decided, kept, archived] = outcome;

      return [
        {
          feature,
          decided,
          kept,
          archived,
          keep_rate: kept / decided,
          letgo_rate: archived / decided,
          rank,
        },
      ];
    })
    .sort(
      (a, b) =>
        Math.abs(b.keep_rate - 0.5) - Math.abs(a.keep_rate - 0.5) ||
        b.decided - a.decided ||
        a.rank - b.rank ||
        a.feature.localeCompare(b.feature),
    );

  const top = candidates[0];

  if (!top) return null;

  const verdict = top.keep_rate >= 0.8 ? "keep" : top.letgo_rate >= 0.8 ? "skip" : null;

  if (!verdict) return null;

  const count = verdict === "keep" ? top.kept : top.archived;
  const verb = verdict === "keep" ? "You kept or finished" : "You let go";

  return {
    verdict,
    reason: `${verb} ${count} of ${top.decided} ${hintSubject(top.feature, metadata)}`,
  };
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

const _LEARN_CHUNK = 500;

interface ScoredItem {
  fullname: string;
  score: number;
  why: string[];
  hint: TriageHint | null;
  item: string;
}

function applyLearnChunk(
  db: Database,
  entries: ScoredItem[],
  last: boolean,
  model: ScoreModel,
): void {
  withTransaction(db, () => {
    for (const entry of entries) {
      const current = db
        .query("SELECT status,metadata FROM items WHERE fullname=?")
        .get(entry.fullname) as { status: string; metadata: string } | null;

      if (!current || current.status !== "inbox") continue;

      const metadata = parseMetadata(current.metadata);

      metadata.triage_score = Number(entry.score.toFixed(4));
      metadata.triage_why = entry.why;

      if (entry.hint) Reflect.set(metadata, "triage_hint", entry.hint);
      else Reflect.deleteProperty(metadata, "triage_hint");

      db.query("UPDATE items SET metadata=? WHERE fullname=?").run(
        JSON.stringify(metadata),
        entry.fullname,
      );
    }

    if (last) setSetting(db, MODEL_SETTING_KEY, JSON.stringify(model));
  });
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

  const scored = rows.map((row): ScoredItem => {
    const metadata = parseMetadata(row.metadata);
    const features = extractFeatures(row, metadata, { now: model.fitted_utc });
    const [processedScore] = scoreItem(model, features);

    return {
      fullname: row.fullname,
      score: Math.sqrt(processedScore * keepProbability(model, features)),
      why: outcomeReasons(model, features, metadata),
      hint: historyHint(model, features, metadata),
      item: `${metadata.subreddit ? `r/${metadata.subreddit}: ` : ""}${row.fullname}`,
    };
  });

  if (apply) {
    const chunks = Math.max(1, Math.ceil(scored.length / _LEARN_CHUNK));

    for (let index = 0; index < chunks; index += 1)
      applyLearnChunk(
        db,
        scored.slice(index * _LEARN_CHUNK, (index + 1) * _LEARN_CHUNK),
        index === chunks - 1,
        model,
      );
  }

  const top = scored.map(({ score, item, why }) => ({ score, item, why }));

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
  const previous = loadModel(db);
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

interface AutoLearnState {
  scheduled: boolean;
  current: Promise<LearnResult | null> | null;
  logged: boolean;
}

interface LearnWorkerReply {
  ok: boolean;
  result?: LearnResult;
  message?: string;
}

const _autoLearnStates = new WeakMap<Database, AutoLearnState>();

const _autoLearnPathStates = new Map<string, AutoLearnState>();

function learnPath(db: Database): string | null {
  const path = db.filename;

  return path && path !== ":memory:" ? path : null;
}

function freshAutoLearnState(): AutoLearnState {
  return { scheduled: false, current: null, logged: false };
}

function autoLearnState(db: Database): AutoLearnState {
  const path = learnPath(db);

  if (path) {
    const known = _autoLearnPathStates.get(path);

    if (known) return known;
    const state = freshAutoLearnState();

    _autoLearnPathStates.set(path, state);

    return state;
  }

  const known = _autoLearnStates.get(db);

  if (known) return known;
  const state = freshAutoLearnState();

  _autoLearnStates.set(db, state);

  return state;
}

function autoLearnEvery(): number {
  const raw = Number(process.env.TRIAGE_AUTO_LEARN_EVERY);

  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 20;
}

function autoLearnPending(db: Database): number {
  const raw = Number(getSetting(db, "auto_learn_pending", "0") || 0);

  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0;
}

function incrementAutoLearnPending(db: Database, count: number): number {
  const row = db
    .query(
      "INSERT INTO settings(key,value) VALUES('auto_learn_pending',?) " +
        "ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+CAST(excluded.value AS INTEGER) " +
        "RETURNING CAST(value AS INTEGER) AS value",
    )
    .get(String(count)) as { value: number } | null;

  return Number(row?.value ?? count);
}

function consumeAutoLearnPending(db: Database, count: number): void {
  db.query(
    "UPDATE settings SET value=MAX(CAST(value AS INTEGER)-?,0) WHERE key='auto_learn_pending'",
  ).run(count);
}

const _AUTO_LEARN_CLAIM_KEY = "auto_learn_claim";

const _AUTO_LEARN_LEASE_MS = 10 * 60 * 1000;

function acquireAutoLearnClaim(db: Database): string | null {
  const token = crypto.randomUUID();
  const now = Date.now();

  const row = db
    .query(
      "INSERT INTO settings(key,value) VALUES(?,?) " +
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value " +
        "WHERE (CASE WHEN json_valid(settings.value) " +
        "THEN CAST(json_extract(settings.value,'$.until') AS INTEGER) ELSE 0 END)<=? " +
        "RETURNING value",
    )
    .get(
      _AUTO_LEARN_CLAIM_KEY,
      JSON.stringify({ token, until: now + _AUTO_LEARN_LEASE_MS }),
      now,
    ) as { value: string } | null;

  if (!row) return null;

  return claimToken(row.value) === token ? token : null;
}

const AutoLearnClaimSchema = z.object({ token: z.string() });

function claimToken(raw: string): string | null {
  try {
    const parsed = AutoLearnClaimSchema.safeParse(JSON.parse(raw));

    return parsed.success ? parsed.data.token : null;
  } catch {
    return null;
  }
}

function releaseAutoLearnClaim(db: Database, token: string): void {
  try {
    db.query(
      "DELETE FROM settings WHERE key=? AND " +
        "json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END,'$.token')=?",
    ).run(_AUTO_LEARN_CLAIM_KEY, token);
  } catch {}
}

function learnInWorker(path: string): Promise<LearnResult> {
  const worker = new Worker(new URL("./triage_learn_worker.ts", import.meta.url).href);
  const { promise, resolve, reject } = Promise.withResolvers<LearnResult>();

  worker.onmessage = (event: MessageEvent<LearnWorkerReply>) => {
    const reply = event.data;

    worker.terminate();

    if (reply.ok && reply.result) resolve(reply.result);
    else reject(new Error(reply.message ?? "triage learn worker failed"));
  };

  worker.onerror = (event) => {
    worker.terminate();
    reject(new Error(event.message || "triage learn worker failed"));
  };

  worker.postMessage({ path });

  return promise;
}

function logAutoLearnFailure(db: Database, cause: unknown): void {
  const state = autoLearnState(db);

  if (state.logged) return;
  state.logged = true;
  console.error(
    `triage auto learn failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
}

async function executeAutoLearn(db: Database, consumed: number): Promise<LearnResult | null> {
  try {
    const path = learnPath(db);
    const result = path ? await learnInWorker(path) : learn(db, { apply: true });

    consumeAutoLearnPending(db, consumed);

    return result;
  } catch (error) {
    logAutoLearnFailure(db, error);

    return null;
  }
}

function runAutoLearn(db: Database, state: AutoLearnState): Promise<LearnResult | null> {
  if (state.current) return state.current;

  if (autoLearnPending(db) < autoLearnEvery()) return Promise.resolve(null);

  const current = claimedAutoLearn(db);

  const clear = () => {
    if (state.current === current) state.current = null;
  };

  state.current = current;
  void current.then(clear, clear);

  return current;
}

async function claimedAutoLearn(db: Database): Promise<LearnResult | null> {
  const claim = acquireAutoLearnClaim(db);

  if (!claim) return null;

  try {
    const consumed = autoLearnPending(db);

    if (consumed < autoLearnEvery()) return null;

    return await executeAutoLearn(db, consumed);
  } finally {
    releaseAutoLearnClaim(db, claim);
  }
}

function scheduleAutoLearn(db: Database): void {
  const state = autoLearnState(db);

  if (state.scheduled || state.current) return;
  state.scheduled = true;
  setTimeout(() => {
    state.scheduled = false;
    void runAutoLearn(db, state);
  }, 0);
}

export function noteDecision(db: Database, count = 1): void {
  const step = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;

  if (step < 1) return;

  try {
    const pending = incrementAutoLearnPending(db, step);

    if (pending >= autoLearnEvery()) scheduleAutoLearn(db);
  } catch (error) {
    logAutoLearnFailure(db, error);
  }
}

export async function autoLearnNow(db: Database): Promise<LearnResult | null> {
  return runAutoLearn(db, autoLearnState(db));
}
