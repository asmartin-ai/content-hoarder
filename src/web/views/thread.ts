/**
 * The cached top comment for a Reddit card. Reads only the `reddit_threads`
 * cache (never the network); any miss or odd shape yields null.
 */

import type { Database } from "bun:sqlite";
import * as z from "zod";
import * as db from "../../db.ts";
import type { Item } from "../../models.ts";
import { submissionFullname } from "../../reddit_hydrate.ts";
import { isRemovedText } from "../../static/core/util.js";

export type TopComment = { author: string; score: number; body: string };

const BODY_LIMIT = 600;

// A Reddit thread listing: [postListing, commentsListing].
const ListingSchema = z.object({
  data: z.object({
    children: z.array(z.object({ kind: z.string().optional().catch(undefined), data: z.json() })),
  }),
});

const ThreadSchema = z.array(ListingSchema).min(2);

const CommentSchema = z.object({
  id: z.string().optional().catch(undefined),
  name: z.string().optional().catch(undefined),
  author: z.string().catch(""),
  body: z.string().catch(""),
  score: z.number().catch(0),
  stickied: z.boolean().catch(false),
});

function cachedThread(database: Database, item: Item): string | null {
  // A saved comment's own key may hold only its permalink subtree; the
  // submission (`t3_`) key holds the whole post thread (AGENTS.md gotcha #9).
  const keys =
    item.kind === "comment"
      ? [submissionFullname(item.metadata.permalink), item.fullname]
      : [item.fullname];

  for (const key of keys) {
    if (!key) continue;
    const cached = db.getRedditThread(database, key);

    if (cached?.thread_json) return cached.thread_json;
  }

  return null;
}

function decodeEntities(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Highest-score visible top-level comment from the cached thread, or null. */
export function topComment(database: Database, item: Item): TopComment | null {
  if (item.source !== "reddit") return null;
  let threadJson: string | null;

  try {
    threadJson = cachedThread(database, item);
  } catch {
    return null;
  }

  if (!threadJson) return null;
  let decoded: z.infer<typeof ThreadSchema>;

  try {
    const parsed = ThreadSchema.safeParse(JSON.parse(threadJson));

    if (!parsed.success) return null;
    decoded = parsed.data;
  } catch {
    return null;
  }

  const savedId = item.source_id.replace(/^t1_/, "");
  let best: TopComment | null = null;

  for (const child of decoded[1]?.data.children ?? []) {
    if (child.kind !== "t1") continue;
    const comment = CommentSchema.safeParse(child.data);

    if (!comment.success) continue;
    const c = comment.data;
    const id = c.id ?? (c.name ?? "").replace(/^t1_/, "");
    const body = c.body.trim();

    if (c.stickied || id === savedId || !body || isRemovedText(body)) continue;

    if (!c.author || c.author === "[deleted]") continue;

    if (best && best.score >= c.score) continue;
    const text = decodeEntities(body);

    best = {
      author: c.author,
      score: c.score,
      body: text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT).trimEnd()}…` : text,
    };
  }

  return best;
}
