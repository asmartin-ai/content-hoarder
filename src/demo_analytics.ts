import { Database } from "bun:sqlite";
import { z } from "zod";
import * as config from "./config.ts";

export const EVENT_KINDS = [
  "page_view",
  "page_hide",
  "round_start",
  "card_view",
  "hint_shown",
  "decision",
  "undo",
  "reader_open",
  "round_end",
  "round_suspend",
  "consent_choice",
  "pile_apply",
  "pile_undo",
  "srv_deal",
  "srv_ai_call",
  "srv_status",
  "srv_undo",
  "srv_consent",
  "srv_sweep",
  "srv_pull",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export const MAX_CLIENT_EVENTS = 50;

export const MAX_EVENT_DATA_BYTES = 2048;

export const MAX_CLIENT_BODY_BYTES = 64 * 1024;

const SCHEMA = `CREATE TABLE IF NOT EXISTS demo_events (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  client_at INTEGER,
  sid TEXT,
  kind TEXT NOT NULL,
  page TEXT,
  fullname TEXT,
  data TEXT
);
CREATE INDEX IF NOT EXISTS demo_events_kind_at ON demo_events(kind, at);`;

const INSERT =
  "INSERT INTO demo_events (at, client_at, sid, kind, page, fullname, data) VALUES (?, ?, ?, ?, ?, ?, ?)";

const SELECT =
  "SELECT id, at, client_at, sid, kind, page, fullname, data FROM demo_events ORDER BY at, id";

const EventData = z.record(z.string(), z.json().optional());

export type EventData = z.infer<typeof EventData>;

const CountSchema = z.number().int().nonnegative();

const HintBySchema = z.enum(["ai", "history"]);

const VerdictSchema = z.enum(["keep", "skip"]);

const RoundIdSchema = z.string().max(32);

const ShortTextSchema = z.string().max(64);

const CLIENT_EVENT_FIELDS = {
  at: z.number().int().nonnegative().optional(),
  page: z.string().max(64).optional(),
  fullname: z.string().max(200).optional(),
};

const CLIENT_EVENT_SCHEMAS = [
  z.strictObject({
    ...CLIENT_EVENT_FIELDS,
    kind: z.literal("page_view"),
    data: z.strictObject({ path: ShortTextSchema }),
  }),
  z.strictObject({
    ...CLIENT_EVENT_FIELDS,
    kind: z.literal("page_hide"),
    data: z.strictObject({ visible_ms: CountSchema }),
  }),
  z.strictObject({
    ...CLIENT_EVENT_FIELDS,
    kind: z.literal("round_start"),
    data: z.strictObject({ size: CountSchema, resumed: z.boolean(), round_id: RoundIdSchema }),
  }),
  z.strictObject({
    ...CLIENT_EVENT_FIELDS,
    kind: z.literal("card_view"),
    data: z.strictObject({
      idx: CountSchema,
      hinted: z.boolean(),
      hint_by: HintBySchema.optional(),
    }),
  }),
  z.strictObject({
    ...CLIENT_EVENT_FIELDS,
    kind: z.literal("hint_shown"),
    data: z.strictObject({ by: HintBySchema, idx: CountSchema }),
  }),
  z.strictObject({
    ...CLIENT_EVENT_FIELDS,
    kind: z.literal("decision"),
    data: z.strictObject({
      act: z.enum(["keep", "archived", "done", "snooze", "skip"]),
      method: z.enum(["swipe", "tap", "key"]),
      dwell_ms: CountSchema,
      hint: VerdictSchema.optional(),
      hint_by: HintBySchema.optional(),
    }),
  }),
  z.strictObject({
    ...CLIENT_EVENT_FIELDS,
    kind: z.literal("undo"),
    data: z.strictObject({}).optional(),
  }),
  z.strictObject({
    ...CLIENT_EVENT_FIELDS,
    kind: z.literal("reader_open"),
    data: z.strictObject({}).optional(),
  }),
  z.strictObject({
    ...CLIENT_EVENT_FIELDS,
    kind: z.literal("round_end"),
    data: z.strictObject({
      completed: z.boolean(),
      decided: CountSchema,
      ms: CountSchema,
      round_id: RoundIdSchema,
    }),
  }),
  z.strictObject({
    ...CLIENT_EVENT_FIELDS,
    kind: z.literal("round_suspend"),
    data: z.strictObject({
      round_id: RoundIdSchema,
      decided: CountSchema,
      ms: CountSchema,
    }),
  }),
  z.strictObject({
    ...CLIENT_EVENT_FIELDS,
    kind: z.literal("consent_choice"),
    data: z.strictObject({ on: z.boolean(), where: z.enum(["popup", "add"]) }),
  }),
  z.strictObject({
    ...CLIENT_EVENT_FIELDS,
    kind: z.literal("pile_apply"),
    data: z.strictObject({ kind: ShortTextSchema }),
  }),
  z.strictObject({
    ...CLIENT_EVENT_FIELDS,
    kind: z.literal("pile_undo"),
    data: z.strictObject({}).optional(),
  }),
] as const;

const ClientEventSchema = z
  .discriminatedUnion("kind", CLIENT_EVENT_SCHEMAS)
  .refine(
    (event) => Buffer.byteLength(JSON.stringify(event.data ?? {}), "utf8") <= MAX_EVENT_DATA_BYTES,
  );

export const ClientEventsBody = z.strictObject({
  sid: z.string().min(1).max(64),
  events: z.array(ClientEventSchema).max(MAX_CLIENT_EVENTS),
});

export type ClientEventsBody = z.infer<typeof ClientEventsBody>;

const RowSchema = z.object({
  id: z.number(),
  at: z.number(),
  client_at: z.number().nullable(),
  sid: z.string().nullable(),
  kind: z.string(),
  page: z.string().nullable(),
  fullname: z.string().nullable(),
  data: z.string().nullable(),
});

export interface DemoEventRow {
  id: number;
  at: number;
  client_at: number | null;
  sid: string | null;
  kind: string;
  page: string | null;
  fullname: string | null;
  data: EventData | null;
}

export interface TrackFields {
  sid?: string;
  page?: string;
  fullname?: string;
  data?: EventData;
}

export interface DemoEventsSummary {
  events: number;
  sessions: number;
  first_at: number | null;
  last_at: number | null;
  page_views: Record<string, number>;
  decisions_by_act: Record<string, number>;
  decisions_by_method: Record<string, number>;
  median_dwell_ms: number | null;
  undos: number;
  undos_server: number;
  rounds_started: number;
  rounds_completed: number;
  hints_shown: number;
  hint_agreement: number;
  hints_accepted_legacy: number;
  hints_matched: number;
  ai_calls: {
    ok: number;
    failed: number;
    median_ms: number | null;
    prompt_tokens: number;
    completion_tokens: number;
  };
  first_decision_ms: number | null;
}

const RowFieldsSchema = z.object({
  path: z.string().optional(),
  completed: z.boolean().optional(),
  hinted: z.boolean().optional(),
  act: z.string().optional(),
  hint: z.string().optional(),
  method: z.string().optional(),
  dwell_ms: z.number().optional(),
  ok: z.boolean().optional(),
  ms: z.number().optional(),
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  matched: z.boolean().optional(),
  round_id: z.string().optional(),
});

const READY = new WeakMap<Database, true>();

export function demoAnalyticsOn(): boolean {
  return config.get("CONTENT_HOARDER_DEMO_ANALYTICS") === "1";
}

function ensure(database: Database): void {
  if (READY.has(database)) return;

  database.exec(SCHEMA);

  const columns = z
    .array(z.object({ name: z.string() }))
    .parse(database.query("PRAGMA table_info(demo_events)").all());

  if (!columns.some((column) => column.name === "client_at"))
    database.exec("ALTER TABLE demo_events ADD COLUMN client_at INTEGER");

  READY.set(database, true);
}

function tableExists(database: Database): boolean {
  return (
    database
      .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='demo_events'")
      .get() !== null
  );
}

function parseData(value: string | null): EventData | null {
  if (value === null) return null;

  let decoded: unknown;

  try {
    decoded = JSON.parse(value);
  } catch {
    return null;
  }

  const parsed = EventData.safeParse(decoded);

  return parsed.success ? parsed.data : null;
}

export function track(database: Database, kind: EventKind, fields: TrackFields = {}): void {
  if (!demoAnalyticsOn()) return;

  try {
    ensure(database);
    database
      .query(INSERT)
      .run(
        Date.now(),
        null,
        fields.sid ?? null,
        kind,
        fields.page ?? null,
        fields.fullname ?? null,
        fields.data === undefined ? null : JSON.stringify(fields.data),
      );
  } catch {}
}

export function recordClientEvents(database: Database, body: ClientEventsBody): number {
  if (!demoAnalyticsOn() || !body.events.length) return 0;

  try {
    ensure(database);
    const insert = database.query(INSERT);
    const at = Date.now();

    database.transaction(() => {
      for (const event of body.events)
        insert.run(
          at,
          event.at ?? null,
          body.sid,
          event.kind,
          event.page ?? null,
          event.fullname ?? null,
          event.data === undefined ? null : JSON.stringify(event.data),
        );
    })();

    return body.events.length;
  } catch {
    return 0;
  }
}

export function demoEventRows(database: Database): DemoEventRow[] {
  if (!tableExists(database)) return [];

  return database
    .query(SELECT)
    .all()
    .flatMap((value) => {
      const row = RowSchema.safeParse(value);

      return row.success
        ? [
            {
              id: row.data.id,
              at: row.data.at,
              client_at: row.data.client_at,
              sid: row.data.sid,
              kind: row.data.kind,
              page: row.data.page,
              fullname: row.data.fullname,
              data: parseData(row.data.data),
            },
          ]
        : [];
    });
}

export function demoEventsFromFile(path: string): DemoEventRow[] {
  const database = new Database(path, { readonly: true });

  try {
    return demoEventRows(database);
  } finally {
    database.close();
  }
}

export function demoEventsSummary(database: Database): DemoEventsSummary {
  return summarizeDemoEvents(demoEventRows(database));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2) return sorted[middle] ?? null;

  return Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

interface SessionTiming {
  viewed: number | null;
  decided: number | null;
}

export function summarizeDemoEvents(rows: DemoEventRow[]): DemoEventsSummary {
  const dwell: number[] = [];
  const aiMs: number[] = [];
  const sids = new Set<string>();
  const timings = new Map<string, SessionTiming>();
  const startedRounds = new Set<string>();
  const completedRounds = new Set<string>();
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let aiOk = 0;
  let aiFailed = 0;

  const summary: DemoEventsSummary = {
    events: 0,
    sessions: 0,
    first_at: null,
    last_at: null,
    page_views: {},
    decisions_by_act: {},
    decisions_by_method: {},
    median_dwell_ms: null,
    undos: 0,
    undos_server: 0,
    rounds_started: 0,
    rounds_completed: 0,
    hints_shown: 0,
    hint_agreement: 0,
    hints_accepted_legacy: 0,
    hints_matched: 0,
    ai_calls: { ok: 0, failed: 0, median_ms: null, prompt_tokens: 0, completion_tokens: 0 },
    first_decision_ms: null,
  };

  for (const row of rows) {
    summary.events++;
    firstAt = firstAt === null ? row.at : Math.min(firstAt, row.at);
    lastAt = lastAt === null ? row.at : Math.max(lastAt, row.at);

    if (row.sid) sids.add(row.sid);
    const parsed = RowFieldsSchema.safeParse(row.data ?? {});
    const data = parsed.success ? parsed.data : RowFieldsSchema.parse({});

    if (row.kind === "page_view") {
      bump(summary.page_views, data.path ?? row.page ?? "/");

      if (row.sid !== null) {
        const timing = timings.get(row.sid) ?? { viewed: null, decided: null };
        const at = row.client_at ?? row.at;

        timing.viewed = timing.viewed === null ? at : Math.min(timing.viewed, at);
        timings.set(row.sid, timing);
      }
    } else if (row.kind === "round_start") {
      startedRounds.add(data.round_id ?? `row:${row.id}`);
    } else if (row.kind === "round_end") {
      if (data.completed === true) completedRounds.add(data.round_id ?? `row:${row.id}`);
    } else if (row.kind === "hint_shown") {
      summary.hints_shown++;
    } else if (row.kind === "decision") {
      if (data.act) bump(summary.decisions_by_act, data.act);

      if (data.method) bump(summary.decisions_by_method, data.method);

      if (data.method === "hint") summary.hints_accepted_legacy++;
      else if (
        (data.hint === "keep" && data.act === "keep") ||
        (data.hint === "skip" && data.act === "archived")
      )
        summary.hint_agreement++;

      if (data.dwell_ms !== undefined && data.dwell_ms >= 0) dwell.push(data.dwell_ms);

      if (row.sid !== null) {
        const timing = timings.get(row.sid) ?? { viewed: null, decided: null };
        const at = row.client_at ?? row.at;

        timing.decided = timing.decided === null ? at : Math.min(timing.decided, at);
        timings.set(row.sid, timing);
      }
    } else if (row.kind === "undo") {
      summary.undos++;
    } else if (row.kind === "srv_undo") {
      summary.undos_server++;
    } else if (row.kind === "srv_status") {
      if (data.matched === true) summary.hints_matched++;
    } else if (row.kind === "srv_ai_call") {
      if (data.ok === true) aiOk++;
      else aiFailed++;

      if (data.ms !== undefined) aiMs.push(data.ms);
      promptTokens += data.prompt_tokens ?? 0;
      completionTokens += data.completion_tokens ?? 0;
    }
  }

  const latencies = [...timings.values()]
    .flatMap((timing) =>
      timing.viewed !== null && timing.decided !== null && timing.decided >= timing.viewed
        ? [timing.decided - timing.viewed]
        : [],
    )
    .sort((a, b) => a - b);

  summary.sessions = sids.size;
  summary.first_at = firstAt;
  summary.last_at = lastAt;
  summary.rounds_started = startedRounds.size;
  summary.rounds_completed = completedRounds.size;
  summary.median_dwell_ms = median(dwell);
  summary.first_decision_ms = median(latencies);
  summary.ai_calls = {
    ok: aiOk,
    failed: aiFailed,
    median_ms: median(aiMs),
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
  };

  return summary;
}

function mergeCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, count] of Object.entries(source)) target[key] = (target[key] ?? 0) + count;
}

export function mergeDemoEventsSummaries(summaries: DemoEventsSummary[]): DemoEventsSummary {
  const merged = summarizeDemoEvents([]);
  const dwellMedians: number[] = [];
  const aiMedians: number[] = [];
  const firstDecision: number[] = [];

  for (const summary of summaries) {
    merged.events += summary.events;
    merged.sessions += summary.sessions;

    if (summary.first_at !== null)
      merged.first_at =
        merged.first_at === null ? summary.first_at : Math.min(merged.first_at, summary.first_at);

    if (summary.last_at !== null)
      merged.last_at =
        merged.last_at === null ? summary.last_at : Math.max(merged.last_at, summary.last_at);

    mergeCounts(merged.page_views, summary.page_views);
    mergeCounts(merged.decisions_by_act, summary.decisions_by_act);
    mergeCounts(merged.decisions_by_method, summary.decisions_by_method);
    merged.undos += summary.undos;
    merged.undos_server += summary.undos_server;
    merged.rounds_started += summary.rounds_started;
    merged.rounds_completed += summary.rounds_completed;
    merged.hints_shown += summary.hints_shown;
    merged.hint_agreement += summary.hint_agreement;
    merged.hints_accepted_legacy += summary.hints_accepted_legacy;
    merged.hints_matched += summary.hints_matched;
    merged.ai_calls.ok += summary.ai_calls.ok;
    merged.ai_calls.failed += summary.ai_calls.failed;
    merged.ai_calls.prompt_tokens += summary.ai_calls.prompt_tokens;
    merged.ai_calls.completion_tokens += summary.ai_calls.completion_tokens;

    if (summary.median_dwell_ms !== null) dwellMedians.push(summary.median_dwell_ms);

    if (summary.ai_calls.median_ms !== null) aiMedians.push(summary.ai_calls.median_ms);

    if (summary.first_decision_ms !== null) firstDecision.push(summary.first_decision_ms);
  }

  merged.median_dwell_ms = median(dwellMedians);
  merged.ai_calls.median_ms = median(aiMedians);
  merged.first_decision_ms = median(firstDecision);

  return merged;
}

function pairs(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  return entries.length ? entries.map(([key, count]) => `${key}=${count}`).join(", ") : "-";
}

export function formatDemoEventsSummary(summary: DemoEventsSummary): string {
  const first = summary.first_at === null ? "-" : new Date(summary.first_at).toISOString();
  const last = summary.last_at === null ? "-" : new Date(summary.last_at).toISOString();

  return [
    `events=${summary.events} sessions=${summary.sessions} first_at=${first} last_at=${last}`,
    `page_views: ${pairs(summary.page_views)}`,
    `decisions: ${pairs(summary.decisions_by_act)} by_method: ${pairs(summary.decisions_by_method)}`,
    `median_dwell_ms=${summary.median_dwell_ms ?? "-"}`,
    `undos=${summary.undos} undos_server=${summary.undos_server}`,
    `rounds: started=${summary.rounds_started} completed=${summary.rounds_completed}`,
    `hints: shown=${summary.hints_shown} agreement=${summary.hint_agreement} accepted_legacy=${summary.hints_accepted_legacy} matched=${summary.hints_matched}`,
    `ai_calls: ok=${summary.ai_calls.ok} failed=${summary.ai_calls.failed} median_ms=${summary.ai_calls.median_ms ?? "-"} prompt_tokens=${summary.ai_calls.prompt_tokens} completion_tokens=${summary.ai_calls.completion_tokens}`,
    `first_decision_ms=${summary.first_decision_ms ?? "-"}`,
  ].join("\n");
}
