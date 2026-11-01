import type { Database } from "bun:sqlite";
import { setTags, withTransaction } from "./db.ts";
import {
  BROWSER_HOST_TAG_MAP,
  BROWSER_KEYWORD_TAGS,
  KEYWORD_TAGS,
  SUBREDDIT_TAGS,
  firefoxTags,
  hackernewsTags,
  redditTags,
  youtubeTags,
} from "./categorize.ts";
import { isAvailable, suggest } from "./assist/llm.ts";
import { parseMetadata, type Item, type RawItem } from "./models.ts";

export const VALID_SUGGESTION_STATUSES = ["pending", "applied", "rejected", "dismissed"] as const;

const DISCOVERY_MIN_COUNT = 2;

export interface Suggestion {
  id: number;
  fullname: string;
  suggested_tag: string;
  source: string;
  reason: string;
  status: string;
  created_utc: number;
  resolved_utc: number | null;
  item_title?: string | null;
  item_source?: string | null;
}

export function createSuggestion(
  db: Database,
  fullname: string,
  tag: string,
  source = "rule",
  reason = "",
): number | null {
  const normalized = tag.trim().toLowerCase().slice(0, 40);

  if (!normalized) return null;

  const existing = db
    .query(
      "SELECT id FROM tag_suggestions WHERE fullname=? AND suggested_tag=? AND status IN ('pending','applied')",
    )
    .get(fullname, normalized);

  if (existing) return null;
  db.query(
    "INSERT INTO tag_suggestions(fullname,suggested_tag,source,reason,status,created_utc) VALUES(?,?,?,?,'pending',?)",
  ).run(fullname, normalized, source, (reason || "").slice(0, 200), Math.floor(Date.now() / 1000));

  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}

export function listSuggestions(
  db: Database,
  opts: { status?: string; tag?: string; sourceType?: string; limit?: number } = {},
): Suggestion[] {
  const filters = ["s.status=?"];
  const params: (string | number)[] = [opts.status ?? "pending"];

  if (opts.tag) {
    filters.push("s.suggested_tag=?");
    params.push(opts.tag.trim().toLowerCase().slice(0, 40));
  }

  if (opts.sourceType) {
    filters.push("s.source=?");
    params.push(opts.sourceType);
  }

  const limit = opts.limit ? " LIMIT ?" : "";

  if (opts.limit) params.push(Math.trunc(opts.limit));

  return db
    .query(
      `SELECT s.id,s.fullname,s.suggested_tag,s.source,s.reason,s.status,s.created_utc,s.resolved_utc,i.title AS item_title,i.source AS item_source FROM tag_suggestions s LEFT JOIN items i ON i.fullname=s.fullname WHERE ${filters.join(" AND ")} ORDER BY s.created_utc DESC${limit}`,
    )
    .all(...params) as Suggestion[];
}

export function suggestionCounts(
  db: Database,
  opts: { status?: string } = {},
): Record<string, number> {
  const rows = db
    .query(
      "SELECT suggested_tag,COUNT(*) AS c FROM tag_suggestions WHERE status=? GROUP BY suggested_tag ORDER BY c DESC",
    )
    .all(opts.status ?? "pending") as Array<{ suggested_tag: string; c: number }>;

  return Object.fromEntries(rows.map(({ suggested_tag, c }) => [suggested_tag, c]));
}

function pending(db: Database, id: number): Suggestion | null {
  return db
    .query("SELECT * FROM tag_suggestions WHERE id=? AND status='pending'")
    .get(id) as Suggestion | null;
}

export function acceptSuggestion(
  db: Database,
  id: number,
): (Suggestion & { result_tags: string[] }) | null {
  const row = pending(db, id);

  if (!row) return null;
  let result: (Suggestion & { result_tags: string[] }) | null = null;
  withTransaction(db, () => {
    const tags = setTags(db, row.fullname, { add: [row.suggested_tag] });

    if (tags === null) return;
    const resolved = Math.floor(Date.now() / 1000);
    db.query("UPDATE tag_suggestions SET status='applied',resolved_utc=? WHERE id=?").run(
      resolved,
      id,
    );
    result = { ...row, status: "applied", resolved_utc: resolved, result_tags: tags };
  });

  return result;
}

export function rejectSuggestion(db: Database, id: number): Suggestion | null {
  const row = pending(db, id);

  if (!row) return null;
  const resolved = Math.floor(Date.now() / 1000);
  db.query("UPDATE tag_suggestions SET status='rejected',resolved_utc=? WHERE id=?").run(
    resolved,
    id,
  );

  return { ...row, status: "rejected", resolved_utc: resolved };
}

export function acceptAllSuggestions(db: Database, opts: { tag?: string } = {}): number {
  const params: string[] = [];
  let where = "status='pending'";

  if (opts.tag) {
    where += " AND suggested_tag=?";
    params.push(opts.tag.trim().toLowerCase().slice(0, 40));
  }

  const rows = db
    .query(`SELECT id,fullname,suggested_tag FROM tag_suggestions WHERE ${where}`)
    .all(...params) as Array<{ id: number; fullname: string; suggested_tag: string }>;

  let count = 0;
  withTransaction(db, () => {
    const resolved = Math.floor(Date.now() / 1000);

    for (const row of rows)
      if (setTags(db, row.fullname, { add: [row.suggested_tag] }) !== null) {
        db.query("UPDATE tag_suggestions SET status='applied',resolved_utc=? WHERE id=?").run(
          resolved,
          row.id,
        );
        count++;
      }
  });

  return count;
}

export function rejectAllSuggestions(db: Database, opts: { tag?: string } = {}): number {
  const params: (string | number)[] = [Math.floor(Date.now() / 1000)];
  let where = "status='pending'";

  if (opts.tag) {
    where += " AND suggested_tag=?";
    params.push(opts.tag.trim().toLowerCase().slice(0, 40));
  }

  return db
    .query(`UPDATE tag_suggestions SET status='rejected',resolved_utc=? WHERE ${where}`)
    .run(...params).changes;
}

interface TaggerInput {
  title?: string;
  url?: string;
  metadata?: Item["metadata"];
}

type ItemTagger = (item: TaggerInput) => string[];

const TAGGERS = {
  reddit: (item: TaggerInput) => redditTags(item),
  youtube: (item: TaggerInput) => youtubeTags(item),
  firefox: (item: TaggerInput) => firefoxTags(item),
  hackernews: (item: TaggerInput) => hackernewsTags(item),
} satisfies Record<string, ItemTagger>;

type TaggerSource = keyof typeof TAGGERS;

function isTaggerSource(source: string): source is TaggerSource {
  return Object.hasOwn(TAGGERS, source);
}

export function suggestFromRuleMatches(
  db: Database,
  opts: { source?: string; limit?: number; retry?: boolean } = {},
) {
  const sources = opts.source ? [opts.source] : ["reddit", "youtube", "firefox", "hackernews"];
  let queued = 0;
  const byTag: Record<string, number> = {};
  withTransaction(db, () => {
    for (const source of sources) {
      if (!isTaggerSource(source)) continue;
      const tagger = TAGGERS[source];
      const where = ["source=?"];
      const params: (string | number)[] = [source];

      if (!opts.retry)
        where.push(
          "(json_extract(metadata,'$.tags') IS NULL OR json_extract(metadata,'$.tags')=json('[]'))",
        );
      const limit = opts.limit ? " LIMIT ?" : "";

      if (opts.limit) params.push(Math.trunc(opts.limit));

      const rows = db
        .query(
          `SELECT fullname,title,url,metadata FROM items WHERE ${where.join(" AND ")} ORDER BY last_seen_utc DESC${limit}`,
        )
        .all(...params) as Array<{
        fullname: string;
        title: string;
        url: string;
        metadata: string;
      }>;

      for (const row of rows)
        for (const tag of tagger({
          title: row.title,
          url: row.url,
          metadata: parseMetadata(row.metadata),
        })) {
          if (
            createSuggestion(
              db,
              row.fullname,
              tag,
              "rule",
              `Auto-detected by ${source} heuristic rules`,
            )
          ) {
            queued++;
            byTag[tag] = (byTag[tag] ?? 0) + 1;
          }
        }
    }
  });

  return { queued, by_tag: byTag, source: opts.source ?? "all" };
}

export function suggestFromDiscovery(
  db: Database,
  opts: { limit?: number; minCount?: number } = {},
) {
  const minCount = opts.minCount ?? DISCOVERY_MIN_COUNT;
  const suggestions: Record<string, string[]> = {};
  let queued = 0;

  const rows = db
    .query(
      "SELECT fullname,title,source,metadata FROM items WHERE source='reddit' AND (json_extract(metadata,'$.tags') IS NULL OR json_extract(metadata,'$.tags')=json('[]')) AND json_extract(metadata,'$.subreddit') IS NOT NULL ORDER BY last_seen_utc DESC",
    )
    .all() as Array<{ fullname: string; title: string; source: string; metadata: string }>;

  const bySub = new Map<string, typeof rows>();

  for (const row of rows) {
    const subreddit = String(parseMetadata(row.metadata).subreddit ?? "").toLowerCase();

    if (subreddit) bySub.set(subreddit, [...(bySub.get(subreddit) ?? []), row]);
  }

  withTransaction(db, () => {
    for (const [subreddit, items] of [...bySub]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, opts.limit ?? 100)) {
      if (SUBREDDIT_TAGS[subreddit] || items.length < minCount) continue;

      const haystack = `${subreddit} ${items
        .slice(0, 3)
        .map((item) => item.title.slice(0, 80))
        .join(" ")}`;

      for (const [tag, pattern] of KEYWORD_TAGS)
        if (pattern.test(haystack)) {
          if (
            createSuggestion(
              db,
              items[0]!.fullname,
              tag,
              "discovery",
              `r/${subreddit} appears ${items.length}x among untagged items — suggest '${tag}' tag`,
            )
          ) {
            queued++;
            (suggestions[tag] ??= []).push(subreddit);
          }

          break;
        }
    }

    const browserRows = db
      .query(
        "SELECT fullname,title,source,metadata FROM items WHERE source IN ('firefox','hackernews') AND (json_extract(metadata,'$.tags') IS NULL OR json_extract(metadata,'$.tags')=json('[]')) ORDER BY last_seen_utc DESC",
      )
      .all() as typeof rows;

    const byDomain = new Map<string, typeof browserRows>();

    for (const row of browserRows) {
      const domain = String(parseMetadata(row.metadata).domain ?? "").toLowerCase();

      if (domain) byDomain.set(domain, [...(byDomain.get(domain) ?? []), row]);
    }

    for (const [domain, items] of [...byDomain]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, opts.limit ?? 100)) {
      if (
        items.length < minCount ||
        Object.keys(BROWSER_HOST_TAG_MAP).some((host) => domain.includes(host))
      )
        continue;

      const sampleTitles = items
        .map((item) => item.title)
        .join(" ")
        .slice(0, 500);

      for (const [tag, pattern] of BROWSER_KEYWORD_TAGS)
        if (pattern.test(sampleTitles)) {
          if (
            createSuggestion(
              db,
              items[0]!.fullname,
              tag,
              "discovery",
              `${domain} appears ${items.length}x among untagged browser items — suggest '${tag}'`,
            )
          ) {
            queued++;
            (suggestions[tag] ??= []).push(domain);
          }

          break;
        }
    }
  });

  return { queued, discovered: suggestions };
}

export async function suggestFromLlm(db: Database, opts: { limit?: number; source?: string } = {}) {
  if (!isAvailable()) return { available: false, queued: 0 };

  const clauses = [
    "status='inbox'",
    "(json_extract(metadata,'$.tags') IS NULL OR json_extract(metadata,'$.tags')=json('[]'))",
    "fullname NOT IN (SELECT fullname FROM tag_suggestions WHERE source='ai' AND status='pending')",
  ];

  const params: (string | number)[] = [];

  if (opts.source) {
    clauses.push("source=?");
    params.push(opts.source);
  }

  const limit = opts.limit ? " LIMIT ?" : "";

  if (opts.limit) params.push(Math.trunc(opts.limit));

  const rows = db
    .query(`SELECT * FROM items WHERE ${clauses.join(" AND ")} ORDER BY last_seen_utc DESC${limit}`)
    .all(...params) as RawItem[];

  const proposals: Array<{ fullname: string; tag: string; reason: string }> = [];

  for (const row of rows) {
    const item: Item = { ...row, metadata: parseMetadata(row.metadata) };
    const proposal = await suggest(item);

    if (!proposal) continue;

    for (const tag of proposal.tags)
      proposals.push({
        fullname: row.fullname,
        tag,
        reason: `LLM suggestion: ${proposal.reason.slice(0, 120)}`,
      });
  }

  let queued = 0;
  withTransaction(db, () => {
    for (const proposal of proposals)
      if (createSuggestion(db, proposal.fullname, proposal.tag, "ai", proposal.reason)) queued++;
  });

  return { available: true, queued, scanned: rows.length };
}
