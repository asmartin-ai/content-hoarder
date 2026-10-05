import { z } from "zod";
import { Database } from "bun:sqlite";
import * as config from "../config.ts";
import { VALID_CATEGORIES } from "../categorize.ts";
import * as db from "../db.ts";
import { request } from "../_http.ts";
import { ItemSchema, MetadataSchema, RawItemSchema, parseMetadata, type Item } from "../models.ts";

const SYSTEM =
  'You help someone with ADHD triage a backlog of saved content. For the given item, decide whether it is worth KEEPING or can be SKIPPED (archived), and propose 1-5 short lowercase topical tags. Be decisive and brief. Respond with ONLY compact JSON of the form {"verdict":"keep"|"skip","reason":"<one short sentence>","tags":["tag1","tag2"]}.';

const CLASSIFY_SYSTEM =
  'You categorize a saved video into exactly one processing area for someone with ADHD:\n- listenable: audio-first (music, albums, podcasts, long talks) — playable in the background.\n- watch: needs your eyes (tutorials, vlogs, visual demos, short clips).\n- wotagei: an idol-event glowstick/penlight performance.\n- unknown: genuinely unclear.\nRespond with ONLY compact JSON: {"category":"listenable"|"watch"|"wotagei"|"unknown","reason":"<short>"}.';

const SuggestionSchema = z.object({
  verdict: z.enum(["keep", "skip"]),
  reason: z.string().max(200),
  tags: z.array(z.string()).max(5),
});

const ChatResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })),
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
}

interface ChatHeaders {
  [name: string]: string;
  "Content-Type": "application/json";
  "User-Agent": string;
}

export type Suggestion = z.infer<typeof SuggestionSchema>;

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
  return Boolean(config.get("LLM_BASE_URL"));
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
  timeout = 60,
): Promise<string> {
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

  return content;
}

function parseSuggestion(text: string): Suggestion | null {
  const match = /\{.*\}/s.exec(text);

  if (!match) return null;

  try {
    const value: unknown = JSON.parse(match[0]);
    const parsed = SuggestionSchema.safeParse(value);

    return parsed.success
      ? {
          ...parsed.data,
          tags: parsed.data.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean),
        }
      : null;
  } catch {
    return null;
  }
}

export function suggest(item: Item): Promise<Suggestion | null>;
export function suggest(
  database: Database,
  opts?: { source?: string; limit?: number },
): Promise<SuggestInboxResult>;
export async function suggest(
  subject: Item | Database,
  opts: { source?: string; limit?: number } = {},
): Promise<Suggestion | SuggestInboxResult | null> {
  if (subject instanceof Database) return suggestInbox(subject, opts);

  if (!isAvailable()) return null;

  try {
    return parseSuggestion(
      await chat([
        { role: "system", content: SYSTEM },
        { role: "user", content: itemText(subject) },
      ]),
    );
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
  const suggestion = await suggest(item);

  if (!suggestion) return null;
  const metadata = MetadataSchema.parse({ ...parseMetadata(item.metadata), llm: suggestion });
  database
    .query("UPDATE items SET metadata=? WHERE fullname=?")
    .run(JSON.stringify(metadata), fullname);

  return suggestion;
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

function parseCategory(
  text: string,
): { category: (typeof VALID_CATEGORIES)[number]; reason: string } | null {
  const match = /\{.*\}/s.exec(text);

  if (!match) return null;

  try {
    const value: unknown = JSON.parse(match[0]);
    const parsed = CategorySchema.safeParse(value);

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

type ChatOverride = (messages: Array<{ role: string; content: string }>) => Promise<string>;

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
      : await chat(
          [
            { role: "system", content: CLASSIFY_SYSTEM },
            { role: "user", content: itemText(item) },
          ],
          backend === "fireworks" ? "fireworks" : "local",
        );

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
