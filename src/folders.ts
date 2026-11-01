import { z } from "zod";
import type { Database } from "bun:sqlite";
import { getItem, withTransaction } from "./db.ts";
import { parseMetadata, type Item, type RawItem } from "./models.ts";

type FolderQuery = z.infer<typeof FolderQuerySchema>;

const FolderQuerySchema = z
  .object({
    source: z.string().optional(),
    kind: z.string().optional(),
    status: z.string().optional(),
    tag: z.union([z.string(), z.array(z.string())]).optional(),
    tags_all: z.boolean().optional(),
    subreddit: z
      .union([z.string(), z.array(z.string())])
      .transform((value) => (Array.isArray(value) ? value : [value]))
      .optional(),
    author: z.string().optional(),
    has: z.string().optional(),
    q: z.string().optional(),
    nsfw: z.boolean().optional(),
    hide_nsfw: z.boolean().optional(),
    is_saved: z.boolean().optional(),
    before: z.coerce.number().nullish(),
    after: z.coerce.number().nullish(),
  })
  .catch({});

type FolderRow = { id: number; name: string; query_def: string };

type FullnameRow = { fullname: string };

function itemPredicate(query: FolderQuery): [string, (string | number)[]] {
  const filters: string[] = [];
  const params: (string | number)[] = [];

  if (query.source) {
    filters.push("i.source=?");
    params.push(query.source);
  }

  if (query.kind) {
    filters.push("i.kind=?");
    params.push(query.kind);
  }

  if (query.status) {
    filters.push("i.status=?");
    params.push(query.status);
  }

  if (query.tag) {
    const tags = Array.isArray(query.tag) ? query.tag : [query.tag];

    if (query.tags_all) {
      for (const tag of tags) {
        filters.push("EXISTS (SELECT 1 FROM json_each(i.metadata, '$.tags') WHERE value=?)");
        params.push(tag);
      }
    } else if (tags.length) {
      filters.push(
        `EXISTS (SELECT 1 FROM json_each(i.metadata, '$.tags') WHERE value IN (${tags.map(() => "?").join(",")}))`,
      );
      params.push(...tags);
    }
  }

  if (query.subreddit?.length) {
    filters.push(
      `json_extract(i.metadata, '$.subreddit') COLLATE NOCASE IN (${query.subreddit.map(() => "?").join(",")})`,
    );
    params.push(...query.subreddit);
  }

  if (query.author) {
    filters.push("i.author=? COLLATE NOCASE");
    params.push(query.author);
  }

  if (query.has === "video" || query.has === "media") filters.push("i.url != ''");
  else if (query.has === "body") filters.push("i.body != ''");
  else if (query.has === "image")
    filters.push(
      "(i.url LIKE '%.jpg' OR i.url LIKE '%.png' OR i.url LIKE '%.gif' OR i.url LIKE '%.webp' OR json_extract(i.metadata, '$.gallery') IS NOT NULL)",
    );

  if (query.q) {
    filters.push("(i.search_text LIKE ? OR i.title LIKE ?)");
    params.push(`%${query.q}%`, `%${query.q}%`);
  }

  const nsfw =
    "(EXISTS (SELECT 1 FROM json_each(i.metadata, '$.tags') WHERE value IN ('nsfw_erotic','nsfw_talk','nsfw_other')) OR COALESCE(json_extract(i.metadata, '$.over_18'),0)=1)";

  if (query.nsfw) filters.push(nsfw);
  else if (query.hide_nsfw) filters.push(`NOT ${nsfw}`);

  if (query.is_saved !== undefined) {
    filters.push("i.is_saved=?");
    params.push(query.is_saved ? 1 : 0);
  }

  const before = query.before ?? undefined;
  const after = query.after ?? undefined;

  if (before !== undefined || after !== undefined) {
    filters.push("i.created_utc>0");
  }

  if (before !== undefined) {
    filters.push("i.created_utc<?");
    params.push(before);
  }

  if (after !== undefined) {
    filters.push("i.created_utc>?");
    params.push(after);
  }

  return [filters.length ? filters.join(" AND ") : "1=1", params];
}

export interface FolderEvaluation {
  folder_name?: string;
  total?: number;
  matched?: number;
  newly_assigned?: number;
  cleared?: number;
  dry_run?: boolean;
  error?: string;
}

export function evaluateFolder(
  db: Database,
  folderId: number,
  opts: { dryRun?: boolean } = {},
): FolderEvaluation {
  const folder = db
    .query<FolderRow, [number]>("SELECT id,name,query_def FROM folders WHERE id=?")
    .get(folderId);

  if (!folder) return { error: `folder ${folderId} not found` };
  let query: FolderQuery = {};

  try {
    query = FolderQuerySchema.parse(JSON.parse(folder.query_def));
  } catch {
    query = {};
  }

  const [where, params] = itemPredicate(query);

  const matched = db
    .query<FullnameRow, (string | number)[]>(`SELECT fullname FROM items i WHERE ${where}`)
    .all(...params)
    .map((row) => row.fullname);

  const dryRun = opts.dryRun ?? false;

  if (dryRun) return { folder_name: folder.name, matched: matched.length, dry_run: true };

  const current = db
    .query<FullnameRow, [string]>(
      "SELECT fullname FROM items WHERE json_extract(metadata,'$.folder')=?",
    )
    .all(folder.name)
    .map((row) => row.fullname);

  const matchedSet = new Set(matched);
  const currentSet = new Set(current);
  const added = matched.filter((fullname) => !currentSet.has(fullname));
  const cleared = current.filter((fullname) => !matchedSet.has(fullname));
  withTransaction(db, () => {
    for (const fullname of added) {
      const item = getItem(db, fullname);

      if (!item) continue;
      const metadata = parseMetadata(item.metadata);
      metadata.folder = folder.name;
      db.query("UPDATE items SET metadata=? WHERE fullname=?").run(
        JSON.stringify(metadata),
        fullname,
      );
    }

    for (const fullname of cleared) {
      const item = getItem(db, fullname);

      if (!item) continue;
      const metadata = parseMetadata(item.metadata);
      delete metadata.folder;
      db.query("UPDATE items SET metadata=? WHERE fullname=?").run(
        JSON.stringify(metadata),
        fullname,
      );
    }

    db.query("UPDATE folders SET updated_utc=? WHERE id=?").run(
      Math.floor(Date.now() / 1000),
      folderId,
    );
  });

  return {
    folder_name: folder.name,
    total: matched.length,
    matched: matched.length,
    newly_assigned: added.length,
    cleared: cleared.length,
    dry_run: false,
  };
}

export function evaluateAllFolders(
  db: Database,
  opts: { dryRun?: boolean } = {},
): FolderEvaluation[] {
  const folders = db.query<{ id: number }, []>("SELECT id FROM folders ORDER BY id").all();

  return folders.map(({ id }) => evaluateFolder(db, id, opts));
}

export function evaluateFolders(
  db: Database,
  folderId?: number,
  opts: { dryRun?: boolean } = {},
): FolderEvaluation[] {
  return folderId === undefined
    ? evaluateAllFolders(db, opts)
    : [evaluateFolder(db, folderId, opts)];
}

export function itemsByFolder(
  db: Database,
  name: string,
  opts: { limit?: number; offset?: number } = {},
): Item[] {
  const rows = db
    .query<RawItem, [string, number, number]>(
      "SELECT * FROM items WHERE json_extract(metadata,'$.folder')=? ORDER BY last_seen_utc DESC LIMIT ? OFFSET ?",
    )
    .all(name, opts.limit ?? 50, opts.offset ?? 0);

  return rows.map((item) => ({ ...item, metadata: parseMetadata(item.metadata) }));
}
