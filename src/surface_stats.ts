import type { Database, SQLQueryBindings } from "bun:sqlite";
import { z } from "zod";
import { aiUsage } from "./assist/hints.ts";
import { hintAgreement } from "./db.ts";
import { parseMetadata } from "./models.ts";
import { extractFeatures } from "./triage_score.ts";

const DAY = 86_400;

const DECISION_DAYS = 14;

const TOP_PER_FAMILY = 15;

const SCORE_BINS = 10;

const WILSON_Z = 1.96;

const DEFAULT_PRICE_IN_PER_M = 0.15;

const DEFAULT_PRICE_OUT_PER_M = 0.5;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const DECIDED_STATUSES = ["keep", "done", "archived"] as const;

const DECAYED_EXCLUSION_SQL =
  "json_extract(metadata, '$.decayed_at') IS NULL AND json_extract(metadata, '$.decay_label') IS NULL";

const FAMILY_ORDER = [
  "source/kind",
  "subreddit",
  "channel",
  "media",
  "category",
  "age",
  "saved_weekday",
  "decided_hour",
] as const;

const FAMILY_LABELS = {
  sk: "source/kind",
  sub: "subreddit",
  chan: "channel",
  media: "media",
  cat: "category",
  age: "age",
} satisfies Record<string, string>;

function isFamilyKey(key: string): key is keyof typeof FAMILY_LABELS {
  return Object.hasOwn(FAMILY_LABELS, key);
}

const CALIBRATION_CAVEAT =
  "retrospective: a stored triage_score may postdate the decision it is compared with, and the bins cover every scored item regardless of --since";

const HintOutcomeSchema = z.object({
  verdict: z.enum(["keep", "skip"]),
  by: z.enum(["ai", "history"]),
  decided: z.enum(DECIDED_STATUSES),
  matched: z.boolean(),
  at: z.number().optional(),
});

export interface WilsonInterval {
  lo: number;
  hi: number;
}

export interface StatusCounts {
  keep: number;
  done: number;
  archived: number;
}

export interface DecisionDay {
  day: string;
  keep: number;
  done: number;
  archived: number;
  total: number;
}

export interface FamilyRate {
  family: string;
  value: string;
  decided: number;
  kept: number;
  archived: number;
  keep_rate: number;
  wilson: WilsonInterval;
}

export interface HintSplit {
  shown: number;
  matched: number;
  rate: number;
}

export interface HintConfusionRow {
  verdict: "keep" | "skip";
  decided: "keep" | "archived" | "done";
  count: number;
}

export interface HintReport {
  shown: number;
  matched: number;
  rate: number;
  by: { ai: HintSplit; history: HintSplit };
  verdicts: { keep: HintSplit; skip: HintSplit };
  confusion: HintConfusionRow[];
}

export interface CalibrationBucket {
  bin: string;
  score_lo: number;
  score_hi: number;
  items: number;
  decided: number;
  kept: number;
  keep_rate: number;
  processed_share: number;
}

export interface CalibrationReport {
  caveat: string;
  buckets: CalibrationBucket[];
}

export interface AiUsageReport {
  scope: "all_time";
  calls: number;
  ok: number;
  failed: number;
  prompt_tokens: number;
  completion_tokens: number;
  tokens: number;
  since: number;
  prices: { in_per_m: number; out_per_m: number };
  cost_usd: number;
  cost_per_1000_ok_usd: number | null;
}

export interface SurfaceStatsReport {
  generated_utc: number;
  since: number | null;
  decisions: {
    decided: number;
    keep_rate: number;
    by_status: StatusCounts;
    decayed: StatusCounts;
    per_day: DecisionDay[];
    inbox: number;
  };
  families: FamilyRate[];
  hint: HintReport;
  calibration: CalibrationReport;
  ai: AiUsageReport;
}

interface FamilyAccumulator {
  decided: number;
  kept: number;
  archived: number;
}

interface DecidedRow {
  source: string;
  kind: string;
  status: string;
  created_utc: number;
  first_seen_utc: number;
  saved_utc: number;
  processed_utc: number | null;
  metadata: string;
}

function allRows<T>(db: Database, sql: string, params: SQLQueryBindings[] = []): T[] {
  return db.query<T, SQLQueryBindings[]>(sql).all(...params);
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;

  return Math.round(value * factor) / factor;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? round(numerator / denominator) : 0;
}

function envPrice(name: string, fallback: number): number {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function wilson95(kept: number, total: number): WilsonInterval {
  if (total <= 0) return { lo: 0, hi: 1 };
  const p = kept / total;
  const z = WILSON_Z;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  const lo = round(Math.max(0, Math.min(p, (center - margin) / denominator)));
  const hi = round(Math.min(1, Math.max(p, (center + margin) / denominator)));

  return { lo, hi };
}

function collectSurfaceStats(
  db: Database,
  now: number,
  since: number | undefined,
): SurfaceStatsReport {
  const sinceSql = since === undefined ? "" : " AND processed_utc >= ?";
  const sinceParams: SQLQueryBindings[] = since === undefined ? [] : [since];

  const byStatus: StatusCounts = { keep: 0, done: 0, archived: 0 };

  const statusRows = allRows<{ status: string; c: number }>(
    db,
    "SELECT status, COUNT(*) AS c FROM items " +
      "WHERE status IN ('keep','done','archived') AND " +
      DECAYED_EXCLUSION_SQL +
      sinceSql +
      " GROUP BY status",
    sinceParams,
  );

  for (const row of statusRows) {
    const count = Number(row.c) || 0;

    if (row.status === "keep") byStatus.keep = count;
    else if (row.status === "done") byStatus.done = count;
    else if (row.status === "archived") byStatus.archived = count;
  }

  const decayed: StatusCounts = { keep: 0, done: 0, archived: 0 };

  const decayedRows = allRows<{ status: string; c: number }>(
    db,
    "SELECT status, COUNT(*) AS c FROM items " +
      "WHERE status IN ('keep','done','archived') AND NOT (" +
      DECAYED_EXCLUSION_SQL +
      ")" +
      sinceSql +
      " GROUP BY status",
    sinceParams,
  );

  for (const row of decayedRows) {
    const count = Number(row.c) || 0;

    if (row.status === "keep") decayed.keep = count;
    else if (row.status === "done") decayed.done = count;
    else if (row.status === "archived") decayed.archived = count;
  }

  const decided = byStatus.keep + byStatus.done + byStatus.archived;
  const kept = byStatus.keep + byStatus.done;

  const inboxRows = allRows<{ c: number }>(
    db,
    "SELECT COUNT(*) AS c FROM items WHERE status='inbox'",
  );

  const inbox = Number(inboxRows[0]?.c ?? 0) || 0;

  const todayStart = Math.floor(now / DAY) * DAY;
  const windowStart = todayStart - (DECISION_DAYS - 1) * DAY;
  const dayStart = since !== undefined && since > windowStart ? since : windowStart;
  const dayMap = new Map<string, DecisionDay>();

  for (let offset = 0; offset < DECISION_DAYS; offset++) {
    const day = new Date((windowStart + offset * DAY) * 1000).toISOString().slice(0, 10);

    dayMap.set(day, { day, keep: 0, done: 0, archived: 0, total: 0 });
  }

  const dayRows = allRows<{ day: string; status: string; c: number }>(
    db,
    "SELECT date(processed_utc, 'unixepoch') AS day, status, COUNT(*) AS c FROM items " +
      "WHERE processed_utc IS NOT NULL AND processed_utc >= ? " +
      "AND status IN ('keep','done','archived') AND " +
      DECAYED_EXCLUSION_SQL +
      " GROUP BY day, status",
    [dayStart],
  );

  for (const row of dayRows) {
    const entry = dayMap.get(String(row.day ?? ""));

    if (!entry) continue;
    const count = Number(row.c) || 0;

    if (row.status === "keep") entry.keep += count;
    else if (row.status === "done") entry.done += count;
    else if (row.status === "archived") entry.archived += count;
    entry.total += count;
  }

  const perDay: DecisionDay[] = [];

  for (const entry of dayMap.values()) perDay.push(entry);

  const familyCounts = new Map<string, Map<string, FamilyAccumulator>>();

  const hintVerdicts = {
    keep: { shown: 0, matched: 0, rate: 0 },
    skip: { shown: 0, matched: 0, rate: 0 },
  } satisfies Record<"keep" | "skip", HintSplit>;

  const confusionCounts = new Map<string, number>();

  const note = (family: string, value: string, itemKept: boolean, itemArchived: boolean): void => {
    let values = familyCounts.get(family);

    if (!values) {
      values = new Map();
      familyCounts.set(family, values);
    }

    const entry = values.get(value) ?? { decided: 0, kept: 0, archived: 0 };

    entry.decided++;

    if (itemKept) entry.kept++;

    if (itemArchived) entry.archived++;
    values.set(value, entry);
  };

  const decidedSql =
    "SELECT source, kind, status, created_utc, first_seen_utc, saved_utc, processed_utc, metadata " +
    "FROM items WHERE status IN ('keep','done','archived') AND " +
    DECAYED_EXCLUSION_SQL;

  for (const row of db.query<DecidedRow, SQLQueryBindings[]>(decidedSql).iterate()) {
    const metadata = parseMetadata(row.metadata);
    const parsedHint = HintOutcomeSchema.safeParse(metadata.hint_outcome);

    if (parsedHint.success) {
      const hint = parsedHint.data;

      hintVerdicts[hint.verdict].shown++;

      if (hint.matched) hintVerdicts[hint.verdict].matched++;

      const confusionKey = `${hint.verdict}|${hint.decided}`;

      confusionCounts.set(confusionKey, (confusionCounts.get(confusionKey) ?? 0) + 1);
    }

    if (since !== undefined && (row.processed_utc === null || row.processed_utc < since)) continue;
    const itemKept = row.status === "keep" || row.status === "done";
    const itemArchived = row.status === "archived";

    for (const feature of extractFeatures(row, metadata, { now })) {
      const separator = feature.indexOf(":");

      if (separator < 0) continue;
      const familyKey = feature.slice(0, separator);

      if (isFamilyKey(familyKey))
        note(FAMILY_LABELS[familyKey], feature.slice(separator + 1), itemKept, itemArchived);
    }

    const anchor =
      row.saved_utc > 0
        ? row.saved_utc
        : row.created_utc > 0
          ? row.created_utc
          : row.first_seen_utc;

    if (anchor > 0)
      note(
        "saved_weekday",
        WEEKDAYS[new Date(anchor * 1000).getUTCDay()] ?? "?",
        itemKept,
        itemArchived,
      );

    if (row.processed_utc !== null)
      note(
        "decided_hour",
        String(new Date(row.processed_utc * 1000).getUTCHours()).padStart(2, "0"),
        itemKept,
        itemArchived,
      );
  }

  for (const split of [hintVerdicts.keep, hintVerdicts.skip])
    split.rate = rate(split.matched, split.shown);

  const families: FamilyRate[] = [];

  for (const family of FAMILY_ORDER) {
    const values = familyCounts.get(family);

    if (!values) continue;

    const ranked = [...values.entries()]
      .map(([value, counts]) => ({
        family,
        value,
        decided: counts.decided,
        kept: counts.kept,
        archived: counts.archived,
        keep_rate: rate(counts.kept, counts.decided),
        wilson: wilson95(counts.kept, counts.decided),
      }))
      .sort((a, b) => b.decided - a.decided || a.value.localeCompare(b.value))
      .slice(0, TOP_PER_FAMILY);

    for (const row of ranked) families.push(row);
  }

  const confusion: HintConfusionRow[] = [];

  for (const verdict of ["keep", "skip"] as const)
    for (const status of DECIDED_STATUSES)
      confusion.push({
        verdict,
        decided: status,
        count: confusionCounts.get(`${verdict}|${status}`) ?? 0,
      });

  const agreement = hintAgreement(db);

  const hint: HintReport = {
    shown: agreement.shown,
    matched: agreement.matched,
    rate: agreement.rate ?? 0,
    by: {
      ai: {
        shown: agreement.by.ai.shown,
        matched: agreement.by.ai.matched,
        rate: rate(agreement.by.ai.matched, agreement.by.ai.shown),
      },
      history: {
        shown: agreement.by.history.shown,
        matched: agreement.by.history.matched,
        rate: rate(agreement.by.history.matched, agreement.by.history.shown),
      },
    },
    verdicts: hintVerdicts,
    confusion,
  };

  const scoreRows = allRows<{ decile: number; items: number; decided: number; kept: number }>(
    db,
    "SELECT MAX(0, MIN(9, CAST(CAST(json_extract(metadata, '$.triage_score') AS REAL) * 10 AS INTEGER))) AS decile, " +
      "COUNT(*) AS items, " +
      "SUM(CASE WHEN status IN ('keep','done','archived') THEN 1 ELSE 0 END) AS decided, " +
      "SUM(CASE WHEN status IN ('keep','done') THEN 1 ELSE 0 END) AS kept " +
      "FROM items WHERE json_type(metadata, '$.triage_score') IN ('integer','real') AND " +
      DECAYED_EXCLUSION_SQL +
      " GROUP BY decile ORDER BY decile",
  );

  const calibrationBuckets: CalibrationBucket[] = [];

  for (const row of scoreRows) {
    const items = Number(row.items) || 0;

    if (items === 0) continue;

    const index = Math.min(
      SCORE_BINS - 1,
      Math.max(0, Math.floor(Number.isFinite(row.decile) ? row.decile : 0)),
    );

    const bucketDecided = Number(row.decided) || 0;
    const bucketKept = Number(row.kept) || 0;
    const scoreLo = round(index / SCORE_BINS, 2);
    const scoreHi = round((index + 1) / SCORE_BINS, 2);

    calibrationBuckets.push({
      bin: `${scoreLo.toFixed(1)}-${scoreHi.toFixed(1)}`,
      score_lo: scoreLo,
      score_hi: scoreHi,
      items,
      decided: bucketDecided,
      kept: bucketKept,
      keep_rate: rate(bucketKept, bucketDecided),
      processed_share: rate(bucketDecided, items),
    });
  }

  const usage = aiUsage(db);

  const prices = {
    in_per_m: envPrice("LLM_PRICE_IN_PER_M", DEFAULT_PRICE_IN_PER_M),
    out_per_m: envPrice("LLM_PRICE_OUT_PER_M", DEFAULT_PRICE_OUT_PER_M),
  };

  const costTotal =
    (usage.prompt_tokens / 1_000_000) * prices.in_per_m +
    (usage.completion_tokens / 1_000_000) * prices.out_per_m;

  const ai: AiUsageReport = {
    scope: "all_time",
    calls: usage.calls,
    ok: usage.ok,
    failed: usage.failed,
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    tokens: usage.prompt_tokens + usage.completion_tokens,
    since: usage.since,
    prices,
    cost_usd: round(costTotal, 9),
    cost_per_1000_ok_usd: usage.ok > 0 ? round((costTotal / usage.ok) * 1000, 9) : null,
  };

  return {
    generated_utc: now,
    since: since ?? null,
    decisions: {
      decided,
      keep_rate: rate(kept, decided),
      by_status: byStatus,
      decayed,
      per_day: perDay,
      inbox,
    },
    families,
    hint,
    calibration: { caveat: CALIBRATION_CAVEAT, buckets: calibrationBuckets },
    ai,
  };
}

export function surfaceStats(db: Database, opts: { since?: number } = {}): SurfaceStatsReport {
  const now = Math.floor(Date.now() / 1000);

  const since =
    opts.since !== undefined && Number.isFinite(opts.since) ? Math.floor(opts.since) : undefined;

  const ownsTransaction = !db.inTransaction;

  if (ownsTransaction) db.exec("BEGIN");

  try {
    const report = collectSurfaceStats(db, now, since);

    if (ownsTransaction) db.exec("COMMIT");

    return report;
  } catch (error) {
    if (ownsTransaction) db.exec("ROLLBACK");

    throw error;
  }
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatSurfaceStats(report: SurfaceStatsReport): string {
  const lines: string[] = [];

  const sinceLabel =
    report.since === null
      ? "all time"
      : `since ${new Date(report.since * 1000).toISOString().slice(0, 10)}`;

  lines.push(`Surface stats (${sinceLabel}; UTC days, local analytics only)`);
  lines.push("");
  lines.push(
    `decisions  ${report.decisions.decided}  (keep ${report.decisions.by_status.keep}, done ${report.decisions.by_status.done}, archived ${report.decisions.by_status.archived})  keep ${percent(report.decisions.keep_rate)}  inbox ${report.decisions.inbox}`,
  );

  const decayed = report.decisions.decayed;

  lines.push(
    `decayed    ${decayed.keep + decayed.done + decayed.archived}  (keep ${decayed.keep}, done ${decayed.done}, archived ${decayed.archived})  sweeps, excluded from rates`,
  );
  lines.push("");
  lines.push("last 14 days");

  let printedDays = 0;

  for (const day of report.decisions.per_day) {
    if (day.total === 0) continue;
    lines.push(
      `  ${day.day}  ${day.total}  (keep ${day.keep}, done ${day.done}, archived ${day.archived})`,
    );
    printedDays++;
  }

  if (printedDays === 0) lines.push("  (no decisions)");
  lines.push("");

  if (!report.families.length) {
    lines.push("by feature family  (no decisions)");
  } else {
    lines.push("by feature family (top 15 each)");

    let currentFamily = "";

    for (const row of report.families) {
      if (row.family !== currentFamily) {
        currentFamily = row.family;
        lines.push(`  ${currentFamily}`);
      }

      lines.push(
        `    ${row.value.padEnd(28)} ${String(row.decided).padStart(5)} decided  ${String(row.kept).padStart(4)} kept  ${String(row.archived).padStart(4)} archived  ${percent(row.keep_rate).padStart(6)}  CI ${percent(row.wilson.lo)}-${percent(row.wilson.hi)}`,
      );
    }
  }

  const hint = report.hint;

  lines.push("");
  lines.push(
    `hint agreement (all time)  shown ${hint.shown}  matched ${hint.matched}  rate ${percent(hint.rate)}`,
  );
  lines.push(
    `  ai       shown ${hint.by.ai.shown}  matched ${hint.by.ai.matched}  rate ${percent(hint.by.ai.rate)}`,
  );
  lines.push(
    `  history  shown ${hint.by.history.shown}  matched ${hint.by.history.matched}  rate ${percent(hint.by.history.rate)}`,
  );
  lines.push(
    `  verdict keep  shown ${hint.verdicts.keep.shown}  matched ${hint.verdicts.keep.matched}  rate ${percent(hint.verdicts.keep.rate)}`,
  );
  lines.push(
    `  verdict skip  shown ${hint.verdicts.skip.shown}  matched ${hint.verdicts.skip.matched}  rate ${percent(hint.verdicts.skip.rate)}`,
  );
  lines.push("  confusion (verdict x decided)");

  for (const row of hint.confusion)
    lines.push(`    ${row.verdict.padEnd(5)} -> ${row.decided.padEnd(8)} ${row.count}`);

  lines.push("");
  lines.push("model calibration (score deciles)");
  lines.push(`  caveat: ${report.calibration.caveat}`);

  if (!report.calibration.buckets.length) lines.push("  (no scored items)");

  for (const bucket of report.calibration.buckets)
    lines.push(
      `  ${bucket.bin.padEnd(10)} items ${String(bucket.items).padStart(4)}  decided ${String(bucket.decided).padStart(4)}  kept ${String(bucket.kept).padStart(4)}  keep ${percent(bucket.keep_rate)}  processed ${percent(bucket.processed_share)}`,
    );

  const ai = report.ai;

  lines.push("");
  lines.push(
    `ai usage (all time)  calls ${ai.calls}  ok ${ai.ok}  failed ${ai.failed}  tokens ${ai.tokens} (in ${ai.prompt_tokens}, out ${ai.completion_tokens})`,
  );
  lines.push(
    `  estimated cost (all time) $${ai.cost_usd.toFixed(9)} at $${ai.prices.in_per_m}/M in + $${ai.prices.out_per_m}/M out`,
  );
  lines.push(
    `  cost per 1,000 ok suggestions (all time) ${ai.cost_per_1000_ok_usd === null ? "n/a" : `$${ai.cost_per_1000_ok_usd.toFixed(9)}`}`,
  );

  return lines.join("\n");
}
