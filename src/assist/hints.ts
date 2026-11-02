import type { Database } from "bun:sqlite";
import { z } from "zod";
import * as config from "../config.ts";
import * as db from "../db.ts";
import { track } from "../demo_analytics.ts";
import {
  LlmSuggestionSchema,
  MetadataSchema,
  parseMetadata,
  type Item,
  type Metadata,
} from "../models.ts";
import type { CardHint } from "../web/views/card.ts";
import { aiActive } from "./consent.ts";
import { suggest, type ChatOverride, type LlmUsage } from "./llm.ts";

const LLM_HINT_KEY = "llm";

const HISTORY_HINT_KEY = "triage_hint";

const DAY_KEY = "ai_day";

const USAGE_KEY = "ai_usage";

const CONCURRENCY = 4;

const HistoryHintSchema = z.object({
  verdict: z.enum(["keep", "skip"]),
  reason: z.string(),
});

const DaySchema = z.object({
  day: z.string(),
  count: z.number().catch(0),
});

const UsageSchema = z.object({
  calls: z.number().catch(0),
  ok: z.number().catch(0),
  failed: z.number().catch(0),
  prompt_tokens: z.number().catch(0),
  completion_tokens: z.number().catch(0),
  since: z.number().catch(0),
});

export type AiUsage = z.infer<typeof UsageSchema>;

const ZERO_USAGE: AiUsage = {
  calls: 0,
  ok: 0,
  failed: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  since: 0,
};

interface DbGate {
  inflight: Set<string>;
  active: number;
  waiting: Array<() => void>;
}

const GATES = new WeakMap<Database, DbGate>();

function gateFor(database: Database): DbGate {
  const existing = GATES.get(database);

  if (existing) return existing;

  const created: DbGate = { inflight: new Set(), active: 0, waiting: [] };

  GATES.set(database, created);

  return created;
}

async function acquire(database: Database): Promise<void> {
  const gate = gateFor(database);

  if (gate.active < CONCURRENCY) {
    gate.active++;

    return;
  }

  const { promise, resolve } = Promise.withResolvers<void>();

  gate.waiting.push(resolve);

  await promise;
}

function release(database: Database): void {
  const gate = gateFor(database);
  const next = gate.waiting.shift();

  if (next) {
    next();

    return;
  }

  gate.active--;
}

function setting<T extends z.ZodType>(
  database: Database,
  key: string,
  schema: T,
): z.infer<T> | null {
  const stored = db.getSetting(database, key);

  if (!stored) return null;

  try {
    const parsed = schema.safeParse(JSON.parse(stored));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function reserveCall(database: Database): boolean {
  const rawCap = Number.parseInt(config.get("LLM_DAILY_CAP"), 10);
  const cap = Number.isFinite(rawCap) && rawCap >= 0 ? rawCap : 300;
  const day = new Date().toISOString().slice(0, 10);

  const reserve = database.transaction((): boolean => {
    const current = setting(database, DAY_KEY, DaySchema);
    const count = current && current.day === day ? current.count : 0;

    if (count >= cap) return false;

    db.setSetting(database, DAY_KEY, JSON.stringify({ day, count: count + 1 }));

    return true;
  });

  return reserve.immediate();
}

function recordUsage(database: Database, ok: boolean, usage?: LlmUsage): void {
  const current = aiUsage(database);

  const next: AiUsage = {
    calls: current.calls + 1,
    ok: current.ok + (ok ? 1 : 0),
    failed: current.failed + (ok ? 0 : 1),
    prompt_tokens: current.prompt_tokens + (usage?.prompt_tokens ?? 0),
    completion_tokens: current.completion_tokens + (usage?.completion_tokens ?? 0),
    since: current.since || Math.floor(Date.now() / 1000),
  };

  db.setSetting(database, USAGE_KEY, JSON.stringify(next));
}

function dealWaitMs(): number {
  const value = Number.parseInt(config.get("LLM_DEAL_WAIT_MS"), 10);

  return Number.isFinite(value) && value >= 0 ? value : 2500;
}

export function hintFor(
  database: Database,
  item: { metadata: Metadata | string | null | undefined },
): CardHint | null {
  const metadata = parseMetadata(item.metadata);

  if (aiActive(database)) {
    const llm = LlmSuggestionSchema.safeParse(metadata[LLM_HINT_KEY]);

    if (llm.success) return { verdict: llm.data.verdict, reason: llm.data.reason, by: "ai" };
  }

  const history = HistoryHintSchema.safeParse(metadata[HISTORY_HINT_KEY]);

  if (history.success)
    return { verdict: history.data.verdict, reason: history.data.reason, by: "history" };

  return null;
}

export function aiUsage(database: Database): AiUsage {
  return setting(database, USAGE_KEY, UsageSchema) ?? ZERO_USAGE;
}

async function fetchHint(database: Database, fullname: string, chat?: ChatOverride): Promise<void> {
  const raw = db.getItem(database, fullname);

  if (!raw || raw.status !== "inbox") return;
  const metadata = parseMetadata(raw.metadata);

  if (LlmSuggestionSchema.safeParse(metadata[LLM_HINT_KEY]).success) return;

  if (!aiActive(database)) return;

  if (!reserveCall(database)) return;
  const item: Item = { ...raw, metadata };
  const started = Date.now();
  const result = await suggest(item, chat ? { chat } : {});

  track(database, "srv_ai_call", {
    fullname,
    data: {
      ok: result !== null,
      ms: Date.now() - started,
      prompt_tokens: result?.usage?.prompt_tokens,
      completion_tokens: result?.usage?.completion_tokens,
    },
  });

  if (!result) {
    recordUsage(database, false);

    return;
  }

  recordUsage(database, true, result.usage);
  const fresh = db.getItem(database, fullname);

  if (!fresh || fresh.status !== "inbox") return;

  const freshMetadata = MetadataSchema.parse({
    ...parseMetadata(fresh.metadata),
    [LLM_HINT_KEY]: result.suggestion,
  });

  db.writeItemMetadata(database, fresh, freshMetadata);
}

export interface PrefetchOptions {
  waitMs?: number;
  chat?: ChatOverride;
}

export async function prefetchHints(
  database: Database,
  fullnames: string[],
  opts: PrefetchOptions = {},
): Promise<void> {
  const gate = gateFor(database);
  const pending = [...new Set(fullnames.filter(Boolean))].filter((id) => !gate.inflight.has(id));

  if (!pending.length) return;

  for (const id of pending) gate.inflight.add(id);

  const waitMs = opts.waitMs ?? dealWaitMs();

  const worker = async (): Promise<void> => {
    while (pending.length) {
      const id = pending.shift();

      if (id === undefined) break;

      await acquire(database);

      try {
        await fetchHint(database, id, opts.chat);
      } catch {}

      release(database);
      gate.inflight.delete(id);
    }
  };

  const work = Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker()),
  ).then(() => undefined);

  await Promise.race([work, Bun.sleep(waitMs)]);
}
