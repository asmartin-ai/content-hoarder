import type { RawItem } from "./models.ts";
import type { Database } from "bun:sqlite";
import * as db from "./db.ts";
import { HttpError, request } from "./_http.ts";
import * as z from "zod";

export interface ThreadComment {
  id: string;
  author: string;
  text: string;
  points: number;
  created_utc: number;
  depth: number;
  children?: ThreadComment[];
}

const numeric = z.union([z.number(), z.string()]).nullable().optional();

interface AlgoliaComment {
  id?: string | number;
  author?: string | null;
  text?: string | null;
  points?: number | string | null;
  created_at_i?: number | string | null;
  children?: AlgoliaComment[];
}

const commentSchema: z.ZodType<AlgoliaComment> = z.lazy(() =>
  z.object({
    id: z.union([z.string(), z.number()]).optional(),
    author: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
    points: numeric,
    created_at_i: numeric,
    children: z.array(commentSchema).optional(),
  }),
);

const numberField = (value: number | string | null | undefined): number => {
  const parsed = Number(value ?? 0);

  return Number.isFinite(parsed) ? parsed : 0;
};

function sortedChildren(children: AlgoliaComment[], sort: string): AlgoliaComment[] {
  if (sort === "top")
    return [...children].sort((a, b) => numberField(b.points) - numberField(a.points));

  if (sort === "new")
    return [...children].sort((a, b) => numberField(b.created_at_i) - numberField(a.created_at_i));

  return children;
}

function extractComments(children: AlgoliaComment[], depth: number, sort: string): ThreadComment[] {
  const effectiveSort = sort === "best" ? "top" : sort;

  return sortedChildren(children, effectiveSort).map((child) => {
    const comment: ThreadComment = {
      id: String(child.id ?? ""),
      author: child.author ?? "",
      text: child.text ?? "",
      points: numberField(child.points),
      created_utc: numberField(child.created_at_i),
      depth,
    };

    const nested = extractComments(child.children ?? [], depth + 1, effectiveSort);

    if (nested.length) comment.children = nested;

    return comment;
  });
}

const storySchema = z.object({
  type: z.string().optional(),
  id: z.union([z.string(), z.number()]).optional(),
  title: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  points: numeric,
  text: z.string().nullable().optional(),
  created_at_i: numeric,
  children: z.array(commentSchema).optional(),
});

interface ThreadPost {
  id: string;
  title: string;
  url: string;
  author: string;
  points: number;
  selftext: string;
  created_utc: number;
}

interface ParsedThreadResult {
  post?: ThreadPost;
  comments?: ThreadComment[];
  cached?: boolean;
  item_fullname?: string;
  item_kind?: string;
  sort?: string;
  error?: string;
}

interface ThreadHydrateResult {
  status: string;
  message?: string;
}

export function parseThread(rawJson: string, item: RawItem, sort = "top"): ParsedThreadResult {
  let value: unknown;

  try {
    value = JSON.parse(rawJson);
  } catch {
    return {
      error: "could not parse thread JSON",
      item_fullname: item.fullname,
      item_kind: item.kind,
      sort,
    };
  }

  const parsed = storySchema.safeParse(value);

  if (!parsed.success || parsed.data.type !== "story")
    return {
      error: "not a story-type Algolia response",
      item_fullname: item.fullname,
      item_kind: item.kind,
      sort,
    };
  const data = parsed.data;

  const post: ThreadPost = {
    id: String(data.id ?? ""),
    title: data.title || item.title,
    url: data.url ?? "",
    author: data.author ?? "",
    points: numberField(data.points),
    selftext: data.text || "",
    created_utc: numberField(data.created_at_i),
  };

  return {
    post,
    comments: extractComments(data.children ?? [], 1, sort),
    cached: true,
    item_fullname: item.fullname,
    item_kind: item.kind,
    sort,
  };
}

export function getThread(
  database: Database,
  fullname: string,
  sort = "top",
): ParsedThreadResult | null {
  const item = db.getItem(database, fullname);

  if (!item) return null;
  const cache = db.getRedditThread(database, fullname);

  if (cache?.thread_json) return parseThread(cache.thread_json, item, sort);

  return { comments: [], cached: false, item_fullname: fullname, item_kind: item.kind, sort };
}

export async function hydrateIfMissing(
  database: Database,
  fullname: string,
  fetchText?: (url: string) => Promise<string | null>,
): Promise<ThreadHydrateResult> {
  if (db.getRedditThread(database, fullname)?.thread_json) return { status: "cached" };
  const sourceId = fullname.split(":", 2)[1];

  if (!sourceId)
    return { status: "error", message: `invalid fullname: ${JSON.stringify(fullname)}` };
  const url = `https://hn.algolia.com/api/v1/items/${encodeURIComponent(sourceId)}`;

  const fetch =
    fetchText ??
    (async (target: string) => {
      try {
        const [status, , body] = await request(target, {
          method: "GET",
          timeout: 10,
          retries: 3,
          backoff: 1.5,
          userAgent: "content-hoarder/hn-thread",
        });

        return status === 200 ? new TextDecoder().decode(body) : null;
      } catch (error) {
        if (error instanceof HttpError) return null;
        throw error;
      }
    });

  let raw: string | null;

  try {
    raw = await fetch(url);
  } catch {
    return { status: "error", message: "fetch failed" };
  }

  if (!raw) return { status: "not_found" };
  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    return { status: "error", message: "invalid JSON from Algolia" };
  }

  const parsed = storySchema.safeParse(value);

  if (!parsed.success || parsed.data.type !== "story") return { status: "not_found" };
  db.setRedditThread(database, fullname, raw, Math.floor(Date.now() / 1000));

  return { status: "hydrated" };
}
