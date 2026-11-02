import { z } from "zod";
import { Database } from "bun:sqlite";
import * as config from "../config.ts";
import { VALID_CATEGORIES } from "../categorize.ts";
import * as db from "../db.ts";
import { request } from "../_http.ts";
import {
  ItemSchema,
  LlmSuggestionSchema,
  MetadataSchema,
  RawItemSchema,
  parseMetadata,
  type Item,
} from "../models.ts";
import { aiConfigured } from "./consent.ts";

const SYSTEM =
  'You help someone with ADHD triage a backlog of saved content. For the given item, decide whether it is worth KEEPING or can be SKIPPED (archived), and propose 1-5 short lowercase topical tags. Be decisive and brief. Respond with ONLY compact JSON of the form {"verdict":"keep"|"skip","reason":"<one short sentence>","tags":["tag1","tag2"]}.';

const CLASSIFY_SYSTEM =
  'You categorize a saved video into exactly one processing area for someone with ADHD:\n- listenable: audio-first (music, albums, podcasts, long talks) — playable in the background.\n- watch: needs your eyes (tutorials, vlogs, visual demos, short clips).\n- wotagei: an idol-event glowstick/penlight performance.\n- unknown: genuinely unclear.\nRespond with ONLY compact JSON: {"category":"listenable"|"watch"|"wotagei"|"unknown","reason":"<short>"}.';

const ChatResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
    })
    .optional(),
});

const CategorySchema = z.object({
  category: z.enum(["listenable", "watch", "wotagei", "unknown"]),
  reason: z.string().max(200),
});

const NameRowSchema = z.object({ fullname: z.string() });

interface ChatPayload {
  messages: Array<{ role: string; content: string }>;
  temperature: number;
  stream: boolean;
  model?: string;
  reasoning_effort?: string;
  thinking?: { type: string };
}

interface ChatHeaders {
  [name: string]: string;
  "Content-Type": "application/json";
  "User-Agent": string;
}

export type Suggestion = z.infer<typeof LlmSuggestionSchema>;

type Category = (typeof VALID_CATEGORIES)[number];

export interface SuggestInboxResult {
  available: boolean;
  annotated: number;
  scanned?: number;
}

export interface ClassifySourceResult {
  available: boolean;
  classified: number;
  scanned?: number;
  by_category?: Record<Category, number>;
}

export function isAvailable(): boolean {
  return aiConfigured();
}

export interface LlmUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

function llmTimeout(): number {
  const seconds = Number.parseInt(config.get("LLM_TIMEOUT_S"), 10);

  return Number.isFinite(seconds) && seconds > 0 ? seconds : 12;
}

function itemText(item: Item): string {
  const metadata = parseMetadata(item.metadata);
  const parts = [`Source: ${item.source}`, `Title: ${item.title}`];

  if (item.author) parts.push(`Author: ${item.author}`);

  if (metadata.subreddit) parts.push(`Subreddit: ${metadata.subreddit}`);

  if (metadata.channel) parts.push(`Channel: ${metadata.channel}`);

  if (item.url) parts.push(`URL: ${item.url}`);
  const body = (item.body || "").slice(0, 500);

  if (body) parts.push(`Body: ${body}`);

  return parts.join("\n");
}

async function chat(
  messages: Array<{ role: string; content: string }>,
  backend: "local" | "fireworks" = "local",
  timeout = llmTimeout(),
): Promise<{ content: string; usage?: LlmUsage }> {
  const fireworks = backend === "fireworks";

  const base = (
    fireworks
      ? config.get("FIREWORKS_BASE_URL") || "https://api.fireworks.ai/inference/v1"
      : config.get("LLM_BASE_URL")
  ).replace(/\/+$/, "");

  const model = fireworks
    ? config.get("FIREWORKS_CLASSIFY_MODEL") || "accounts/fireworks/models/qwen3p7-plus"
    : config.get("LLM_MODEL");

  const payload: ChatPayload = { messages, temperature: 0.2, stream: false };

  if (model) payload.model = model;

  if (fireworks) payload.reasoning_effort = "none";
  else if (config.get("LLM_DISABLE_THINKING") === "1") payload.thinking = { type: "disabled" };
  const localBase = new URL(base);

  const allowLoopback =
    !fireworks &&
    localBase.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(localBase.hostname.replace(/^\[|\]$/g, ""));

  const headers: ChatHeaders = {
    "Content-Type": "application/json",
    "User-Agent": config.get("USER_AGENT"),
  };

  if (fireworks) headers.Authorization = `Bearer ${config.get("FIREWORKS_API_KEY")}`;
  else if (config.get("LLM_API_KEY")) headers.Authorization = `Bearer ${config.get("LLM_API_KEY")}`;

  const [, , raw] = await request(`${base}/chat/completions`, {
    method: "POST",
    data: JSON.stringify(payload),
    headers,
    timeout,
    allowLoopback,
  });

  const response: unknown = JSON.parse(new TextDecoder().decode(raw));
  const parsed = ChatResponseSchema.parse(response);
  const content = parsed.choices[0]?.message.content;

  if (!content) throw new Error("invalid chat completion response");

  const usage = parsed.usage
    ? {
        prompt_tokens: parsed.usage.prompt_tokens ?? 0,
        completion_tokens: parsed.usage.completion_tokens ?? 0,
      }
    : undefined;

  return { content, usage };
}

function extractJson<T>(text: string, schema: z.ZodType<T>): T | null {
  const match = /\{.*\}/s.exec(text);

  if (!match) return null;

  try {
    const value: unknown = JSON.parse(match[0]);
    const parsed = schema.safeParse(value);

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseSuggestion(text: string): Suggestion | null {
  const parsed = extractJson(text, LlmSuggestionSchema);

  return parsed
    ? { ...parsed, tags: parsed.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean) }
    : null;
}

export interface SuggestResult {
  suggestion: Suggestion & { model: string; at: number };
  usage?: LlmUsage;
}

export async function suggest(
  item: Item,
  opts: { chat?: ChatOverride } = {},
): Promise<SuggestResult | null> {
  if (!isAvailable()) return null;

  try {
    const messages = [
      { role: "system", content: SYSTEM },
      { role: "user", content: itemText(item) },
    ];

    let suggestion: Suggestion | null;
    let usage: LlmUsage | undefined;

    if (opts.chat) {
      suggestion = parseSuggestion(await opts.chat(messages));
    } else {
      const response = await chat(messages);

      suggestion = parseSuggestion(response.content);
      usage = response.usage;
    }

    if (!suggestion) return null;

    const result: SuggestResult = {
      suggestion: {
        ...suggestion,
        model: config.get("LLM_MODEL"),
        at: Math.floor(Date.now() / 1000),
      },
    };

    if (usage) result.usage = usage;

    return result;
  } catch {
    return null;
  }
}

export async function suggestAndStore(
  database: Database,
  fullname: string,
): Promise<Suggestion | null> {
  const item = db.getPublicItem(database, fullname);

  if (!item) return null;
  const result = await suggest(item);

  if (!result) return null;
  const fresh = db.getItem(database, fullname);

  if (!fresh) return null;

  const metadata = MetadataSchema.parse({
    ...parseMetadata(fresh.metadata),
    llm: result.suggestion,
  });

  db.writeItemMetadata(database, fresh, metadata);

  return result.suggestion;
}

export async function suggestInbox(
  database: Database,
  opts: { source?: string; limit?: number } = {},
): Promise<SuggestInboxResult> {
  if (!isAvailable()) return { available: false, annotated: 0 };
  const query = `SELECT fullname FROM items WHERE status='inbox'${opts.source ? " AND source=?" : ""} LIMIT ?`;

  const rows = (
    opts.source
      ? database.query(query).all(opts.source, Math.trunc(opts.limit ?? 20))
      : database.query(query).all(Math.trunc(opts.limit ?? 20))
  ).map((row) => NameRowSchema.parse(row));

  let annotated = 0;

  for (const row of rows) if (await suggestAndStore(database, row.fullname)) annotated++;

  return { available: true, annotated, scanned: rows.length };
}

const parseCategory = (text: string): { category: Category; reason: string } | null =>
  extractJson(text, CategorySchema);

export type ChatOverride = (messages: Array<{ role: string; content: string }>) => Promise<string>;

export async function classify(
  item: Item,
  opts: { backend?: string; chat?: ChatOverride } = {},
): Promise<{ category: (typeof VALID_CATEGORIES)[number]; reason: string } | null> {
  const backend = opts.backend ?? "local";

  if (backend === "fireworks" && !config.get("FIREWORKS_API_KEY")) return null;

  if (backend !== "fireworks" && !isAvailable()) return null;

  try {
    const content = opts.chat
      ? await opts.chat([
          { role: "system", content: CLASSIFY_SYSTEM },
          { role: "user", content: itemText(item) },
        ])
      : (
          await chat(
            [
              { role: "system", content: CLASSIFY_SYSTEM },
              { role: "user", content: itemText(item) },
            ],
            backend === "fireworks" ? "fireworks" : "local",
          )
        ).content;

    return parseCategory(content);
  } catch {
    return null;
  }
}

export async function classifySource(
  database: Database,
  source = "youtube",
  opts: { limit?: number; retry?: boolean; backend?: string; chat?: ChatOverride } = {},
): Promise<ClassifySourceResult> {
  const backend = opts.backend ?? "local";

  if (
    (backend === "fireworks" && !config.get("FIREWORKS_API_KEY")) ||
    (backend !== "fireworks" && !isAvailable())
  )
    return { available: false, classified: 0 };

  const unresolved = opts.retry
    ? ""
    : " AND (json_extract(metadata,'$.category') IS NULL OR json_extract(metadata,'$.category')='unknown')";

  const limit = opts.limit ? " LIMIT ?" : "";

  const rawRows = opts.limit
    ? database
        .query(
          `SELECT * FROM items WHERE source=?${unresolved} ORDER BY last_seen_utc DESC${limit}`,
        )
        .all(source, Math.trunc(opts.limit))
    : database
        .query(`SELECT * FROM items WHERE source=?${unresolved} ORDER BY last_seen_utc DESC`)
        .all(source);

  const rows = rawRows.map((row) => {
    const raw = RawItemSchema.parse(row);

    return ItemSchema.parse({
      ...raw,
      metadata: MetadataSchema.parse(parseMetadata(raw.metadata)),
    });
  });

  const counts: Record<Category, number> = { listenable: 0, watch: 0, wotagei: 0, unknown: 0 };
  let classified = 0;

  for (const row of rows) {
    const result = await classify(row, { backend, chat: opts.chat });

    if (!result) continue;
    counts[result.category] = (counts[result.category] ?? 0) + 1;
    classified++;
    const metadata = db.metadataWithCategoryTag(row.metadata, result.category);
    metadata.category_source = "llm";
    database
      .query("UPDATE items SET metadata=? WHERE fullname=?")
      .run(JSON.stringify(metadata), row.fullname);
  }

  return { available: true, classified, scanned: rows.length, by_category: counts };
}
