/**
 * SQLite data layer: schema, FTS5 search, non-destructive upserts, and triage.
 * Multi-statement writes use `withTransaction`; single-statement writes use
 * SQLite autocommit. Queries use positional `?` bindings.
 */

import * as z from "zod";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database, type SQLQueryBindings } from "bun:sqlite";

import * as config from "./config.ts";
import {
  buildSearchText,
  ITEM_FIELDS,
  NSFW_TAGS,
  parseMetadata,
  RawItemSchema,
  VALID_STATUSES,
  type Item,
  type Metadata,
  type JsonValue,
  type RawItem,
} from "./models.ts";
import { FILTER_TAGS, VALID_CATEGORIES } from "./categorize.ts";
import { sidFromPermalink } from "./connectors/reddit.ts";

type CountRow = { c: number | string | null };

export const PROCESSING_TAGS = ["listenable", "watch", "wotagei"] as const;

const _FOLDER_QUERY_SCHEMA = z
  .object({
    source: z.string().optional(),
    kind: z.string().optional(),
    status: z.string().optional(),
    tag: z.union([z.string(), z.array(z.string())]).optional(),
    tags_all: z.boolean().optional(),
    subreddit: z.union([z.string(), z.array(z.string())]).optional(),
    author: z.string().optional(),
    has: z.string().optional(),
    q: z.string().optional(),
    nsfw: z.boolean().optional(),
    hide_nsfw: z.boolean().optional(),
    is_saved: z.boolean().optional(),
    before: z.coerce.number().optional(),
    after: z.coerce.number().optional(),
  })
  .catchall(z.json());

export type FolderQueryDefinition = z.infer<typeof _FOLDER_QUERY_SCHEMA>;

type FolderSqlRow = {
  id: number;
  name: string;
  query_def: string;
  description: string;
  created_utc: number;
  updated_utc: number | null;
};

type Folder = Omit<FolderSqlRow, "query_def"> & { query_def: FolderQueryDefinition };

const _TAG_LIST_SCHEMA = z.array(z.string());

type UnsaveSkipped = {
  non_reddit: number;
  already_unsaved: number;
  invalid_id: number;
  already_queued: number;
};

type TagUnsaveSample = {
  fullname: string;
  reddit_id: string;
  title: string;
  subreddit: string | null;
  kind: string;
  created_utc: number;
  saved_utc: number;
  first_seen_utc: number;
};

type SnoozeResult = {
  total: number;
  applied: boolean;
  until_utc: number;
  window_days: number;
  snoozed_wave: number | null;
  decayed_at: number | null;
  escalated: string[];
  snoozed: string[];
  sample: string[];
};

type UnsnoozeResult = {
  total: number;
  applied: boolean;
  snoozed_wave: number | null;
  sample: string[];
};

type DecayResult = {
  total: number;
  applied: boolean;
  decayed_at: number | null;
  label: string | null;
  by_tag: Record<string, number>;
  by_subreddit: Record<string, number>;
  age_bands: { "<1y": number; "1-2y": number; "2-4y": number; ">=4y": number };
  sample: string[];
};

type DecayFullnamesResult = {
  total: number;
  applied: boolean;
  decayed_at: number | null;
  label: string | null;
  sample: string[];
};

type UndecayResult = { total: number; applied: boolean; sample: string[] };

type DeleteItemsResult = {
  total: number;
  applied: boolean;
  threads_deleted: number;
  unsave_enqueued: number;
  sample: string[];
};

type RedditStats = {
  total: number;
  by_kind: Record<string, number>;
  by_status: Record<string, number>;
  by_tag: Record<string, number>;
  top_subreddits: Array<{ subreddit: string; count: number }>;
  distinct_subreddits: number;
  nsfw: number;
  with_media: number;
  by_year: Array<{ year: number; count: number }>;
};

type LightCounts = { total: number; inbox: number; by_status: Record<string, number> };

type FullCounts = LightCounts & {
  by_source: Record<string, number>;
  by_kind: Record<string, number>;
  processed_this_week: number;
  with_url: number;
  distinct_sources: number;
};

export type TagUnsavePreview = {
  tag: string;
  matched: number;
  eligible: number;
  enqueued: number;
  skipped: UnsaveSkipped;
  sample: TagUnsaveSample[];
  fullnames: string[];
  truncated: boolean;
};

export type TagUnsaveResult = TagUnsavePreview & { dry_run: boolean };

export interface CountByKey {
  [key: string]: number;
}

type RedditCommentDedupeResult = { removed: number; status_moved: number; requeued: number };

type PulseCounts = { new_today: number; cleared_today: number; swept_recent: number };
// ---------------------------------------------------------------------------
// Schema (keep in sync with models.ITEM_FIELDS)
// ---------------------------------------------------------------------------

/**
 * SQLite schema. All per-source facts that are not first-class
 * columns (score, over_18, duration, permalink, media_status,
 * subreddit, …) live in the `metadata` JSON blob — the items
 * table itself is deliberately lean.
 */
const _SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
    fullname        TEXT PRIMARY KEY,
    source          TEXT NOT NULL,
    source_id       TEXT NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'item',
    title           TEXT NOT NULL DEFAULT '',
    body            TEXT NOT NULL DEFAULT '',
    url             TEXT NOT NULL DEFAULT '',
    author          TEXT NOT NULL DEFAULT '',
    created_utc     INTEGER NOT NULL DEFAULT 0,
    saved_utc       INTEGER NOT NULL DEFAULT 0,
    is_saved        INTEGER NOT NULL DEFAULT 1,
    first_seen_utc  INTEGER NOT NULL,
    last_seen_utc   INTEGER NOT NULL,
    hydrated_at     INTEGER,
    status          TEXT NOT NULL DEFAULT 'inbox',
    processed_utc   INTEGER,
    status_prev     TEXT,
    search_text     TEXT NOT NULL DEFAULT '',
    metadata        TEXT NOT NULL DEFAULT '{}',
    raw_json        TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_items_source       ON items(source);
CREATE INDEX IF NOT EXISTS idx_items_status       ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_last_seen    ON items(last_seen_utc);
CREATE INDEX IF NOT EXISTS idx_items_created      ON items(created_utc);
CREATE INDEX IF NOT EXISTS idx_items_saved_status ON items(is_saved, status);
CREATE INDEX IF NOT EXISTS idx_items_status_seen  ON items(status, first_seen_utc);
-- Recency-ordered browse within a status/source filter: the
-- single-column indexes forced SQLite to sort every matching row
-- (a full pass over the status bucket) before LIMIT/OFFSET could
-- apply. The composite keeps the scan in feed order instead.
CREATE INDEX IF NOT EXISTS idx_items_status_last_seen ON items(status, last_seen_utc);
CREATE INDEX IF NOT EXISTS idx_items_source_last_seen ON items(source, last_seen_utc);
CREATE INDEX IF NOT EXISTS idx_items_source_first_seen ON items(source, first_seen_utc);

-- Sort-key indexes. db.orderClause sorts by these EXPRESSIONS
-- (NULLIF hides undated rows, CAST normalizes JSON numbers), so a
-- plain-column index is unusable and every sorted browse used to
-- scan+sort the whole table. Each index matches its expression
-- exactly; keep the two in sync.
CREATE INDEX IF NOT EXISTS idx_items_created_nz    ON items(NULLIF(created_utc, 0));
CREATE INDEX IF NOT EXISTS idx_items_saved_nz      ON items(NULLIF(saved_utc, 0));
CREATE INDEX IF NOT EXISTS idx_items_score         ON items(CAST(json_extract(metadata, '$.score') AS INTEGER));
CREATE INDEX IF NOT EXISTS idx_items_triage_score  ON items(CAST(json_extract(metadata, '$.triage_score') AS REAL));
CREATE INDEX IF NOT EXISTS idx_items_author_nocase ON items(author COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_items_subreddit_nocase ON items(json_extract(metadata, '$.subreddit') COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS auth_tokens (
    service       TEXT PRIMARY KEY,
    access_token  TEXT,
    refresh_token TEXT,
    token_type    TEXT,
    scope         TEXT,
    expires_at    INTEGER,
    username      TEXT,
    updated_utc   INTEGER
);

CREATE TABLE IF NOT EXISTS reddit_unsave (
    fullname     TEXT PRIMARY KEY,                 -- items.fullname, e.g. "reddit:t3_abc123"
    reddit_id    TEXT NOT NULL,                    -- the t3_/t1_ fullname the API wants (== items.source_id)
    state        TEXT NOT NULL DEFAULT 'pending',  -- pending | done | failed
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT,
    enqueued_utc INTEGER NOT NULL,
    updated_utc  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_reddit_unsave_state ON reddit_unsave(state);

CREATE TABLE IF NOT EXISTS reddit_threads (
    fullname    TEXT PRIMARY KEY,   -- items.fullname, e.g. "reddit:t3_abc123"
    thread_json TEXT NOT NULL,      -- raw Reddit <permalink>.json (post + comment tree)
    hydrated_at INTEGER             -- when the thread was fetched/cached
);

CREATE TABLE IF NOT EXISTS tag_suggestions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    fullname        TEXT NOT NULL,
    suggested_tag   TEXT NOT NULL,
    source          TEXT NOT NULL DEFAULT 'rule',  -- 'rule' | 'ai' | 'user' | 'discovery'
    reason          TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'applied' | 'rejected' | 'dismissed'
    created_utc     INTEGER NOT NULL,
    resolved_utc    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tag_suggestions_status      ON tag_suggestions(status);
CREATE INDEX IF NOT EXISTS idx_tag_suggestions_fullname    ON tag_suggestions(fullname);
CREATE INDEX IF NOT EXISTS idx_tag_suggestions_tag_status  ON tag_suggestions(suggested_tag, status);

CREATE TABLE IF NOT EXISTS folders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL UNIQUE,
    query_def       TEXT NOT NULL DEFAULT '{}',
    description     TEXT NOT NULL DEFAULT '',
    created_utc     INTEGER NOT NULL,
    updated_utc     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_items_folder ON items(
    json_extract(metadata, '$.folder')
);

CREATE TABLE IF NOT EXISTS user_tags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE
);
`;

/**
 * FTS5 external-content indexes over `items`. `items_fts` is the
 * strict-match index (default tokenizer); `items_trgm` is the
 * fuzzy trigram index. The `items_ai/ad/au` triggers are the
 * durability contract — every items write stays in sync through
 * them, so no code path may write items outside these tables.
 * (`items_au` is installed by `_ensureUpdateTrigger`, not this
 * schema string, so an upgraded DB picks up its WHEN guard.)
 *
 * Rebuild rule (AGENTS.md #1): after ANY schema change to the
 * mirrored columns or the FTS tables themselves, rebuild via
 * `INSERT INTO tbl(tbl) VALUES('rebuild')` — NEVER
 * INSERT…SELECT — gated by the `fts_built` settings marker
 * (bump `_FTS_VERSION`).
 */
const _FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
    fullname, title, body, author, url, search_text,
    content='items', content_rowid='rowid'
);

CREATE VIRTUAL TABLE IF NOT EXISTS items_trgm USING fts5(
    search_text,
    content='items', content_rowid='rowid', tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
    INSERT INTO items_fts(rowid, fullname, title, body, author, url, search_text)
        VALUES (new.rowid, new.fullname, new.title, new.body, new.author, new.url, new.search_text);
    INSERT INTO items_trgm(rowid, search_text) VALUES (new.rowid, new.search_text);
END;

CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, fullname, title, body, author, url, search_text)
        VALUES ('delete', old.rowid, old.fullname, old.title, old.body, old.author, old.url, old.search_text);
    INSERT INTO items_trgm(items_trgm, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
END;

`;

// The UPDATE trigger is re-created below when an upgraded DB still
// carries the unguarded definition (CREATE TRIGGER IF NOT EXISTS
// would otherwise leave it in place forever).
const _AU_TRIGGER_GUARD = "OLD.search_text IS NOT NEW.search_text";

const _AU_TRIGGER_SQL = `
CREATE TRIGGER items_au AFTER UPDATE ON items
WHEN OLD.search_text IS NOT NEW.search_text
  OR OLD.fullname IS NOT NEW.fullname
  OR OLD.url IS NOT NEW.url
  OR OLD.title IS NOT NEW.title
  OR OLD.body IS NOT NEW.body
  OR OLD.author IS NOT NEW.author
BEGIN
    INSERT INTO items_fts(items_fts, rowid, fullname, title, body, author, url, search_text)
        VALUES ('delete', old.rowid, old.fullname, old.title, old.body, old.author, old.url, old.search_text);
    INSERT INTO items_trgm(items_trgm, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
    INSERT INTO items_fts(rowid, fullname, title, body, author, url, search_text)
        VALUES (new.rowid, new.fullname, new.title, new.body, new.author, new.url, new.search_text);
    INSERT INTO items_trgm(rowid, search_text) VALUES (new.rowid, new.search_text);
END;
`;

const _INSERT_SQL = `INSERT INTO items (${ITEM_FIELDS.join(", ")}) VALUES (${ITEM_FIELDS.map(() => "?").join(", ")})`;

const _UPDATE_SQL = `UPDATE items SET ${ITEM_FIELDS.filter((f) => f !== "fullname")
  .map((f) => `${f}=?`)
  .join(", ")} WHERE fullname=?`;

// Sort keys allowed for search/browse (whitelist; rowid tiebreaker
// added by `orderClause`). Values may be a bare column or a SQL
// expression (e.g. json_extract for a metadata field).
const _SORT_COLUMNS = {
  last_seen_utc: "last_seen_utc",
  first_seen_utc: "first_seen_utc",
  // NULLIF(...,0): undated items (created_utc/saved_utc == 0,
  // common for sparse Reddit imports) are treated as unknown and
  // sorted LAST in either direction.
  created_utc: "NULLIF(created_utc, 0)",
  saved_utc: "NULLIF(saved_utc, 0)",
  title: "title",
  status: "status",
  source: "source",
  duration: "CAST(json_extract(metadata, '$.duration') AS INTEGER)",
  position: "CAST(json_extract(metadata, '$.position') AS INTEGER)", // YouTube playlist order
  score: "CAST(json_extract(metadata, '$.score') AS INTEGER)", // Reddit upvotes
  smart: "CAST(json_extract(metadata, '$.triage_score') AS REAL)", // learned likely-to-process (Epic 10)
  subreddit: "json_extract(metadata, '$.subreddit')", // Reddit subreddit (A–Z)
  kind: "kind",
} satisfies Record<string, string>;

function isSortKey(value: string): value is keyof typeof _SORT_COLUMNS {
  return Object.hasOwn(_SORT_COLUMNS, value);
}

// ---------------------------------------------------------------------------
// Statement helpers
// ---------------------------------------------------------------------------

function rows<T extends object>(db: Database, sql: string, params: SQLQueryBindings[] = []): T[] {
  return db.query<T, SQLQueryBindings[]>(sql).all(...params);
}

function row<T extends object>(
  db: Database,
  sql: string,
  params: SQLQueryBindings[] = [],
): T | null {
  return db.query<T, SQLQueryBindings[]>(sql).get(...params);
}

function run(db: Database, sql: string, params: SQLQueryBindings[] = []): number {
  return Number(db.query(sql).run(...params).changes);
}

/** Scalar `SELECT COUNT(*)`-style result (aliased `AS c`). */
function scalar(db: Database, sql: string, params: SQLQueryBindings[] = []): number {
  const result = row<CountRow>(db, sql, params);

  return Number(result?.c ?? 0);
}

/**
 * Preserve all-or-nothing writes; Bun's transaction wrapper uses savepoints
 * for nested calls, so a higher-level transition can include these helpers.
 */
export function withTransaction<T>(db: Database, fn: () => T): T {
  return db.transaction(fn)();
}

// ---------------------------------------------------------------------------
// Connection / init
// ---------------------------------------------------------------------------

export function connect(path?: string): Database {
  /** Open (creating dirs as needed), configure, and initialize the database. */
  const p = path ?? config.dbPath();

  if (p !== ":memory:") {
    const parent = dirname(resolve(p));

    if (parent) mkdirSync(parent, { recursive: true });
  }

  const db = new Database(p);
  // A scheduled `reddit-unsave --drain` writes the same DB as a
  // running `serve`; wait out a brief writer lock instead of
  // failing with "database is locked". Must precede the WAL
  // switch: the one-time rollback->WAL upgrade on a brand-new DB
  // takes a brief exclusive lock, so concurrent first-connects
  // (e.g. a service worker prefetching / + /triage + /pulse)
  // would otherwise 500 here without a busy_timeout to wait it
  // out.
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  initDb(db);

  return db;
}

export function initDb(db: Database): void {
  /** Create tables, FTS indexes, and triggers (idempotent). */
  db.exec(_SCHEMA);
  const userTagColumns = rows<{ name: string }>(db, "PRAGMA table_info(user_tags)");

  const hasLegacyTimestamps = userTagColumns.some(
    (column) => column.name === "created_utc" || column.name === "updated_utc",
  );

  if (hasLegacyTimestamps) {
    withTransaction(db, () => {
      db.exec("CREATE TEMP TABLE user_tags_migration AS SELECT id, name FROM user_tags");
      db.exec("DROP TABLE user_tags");
      db.exec(`CREATE TABLE user_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
      )`);
      db.exec("INSERT INTO user_tags (id, name) SELECT id, name FROM user_tags_migration");
      db.exec("DROP TABLE user_tags_migration");
    });
  }

  db.exec(_FTS_SCHEMA);
  _ensureUpdateTrigger(db);
  // Functional index so sorting by video length (metadata.duration)
  // stays cheap at scale.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_items_duration " +
      "ON items(CAST(json_extract(metadata, '$.duration') AS INTEGER))",
  );
  _ensureFtsBuilt(db);
  // NOTE: normalizeProcessingTags() is a one-time legacy backfill —
  // it scans every category-tagged item (~120ms on the live DB).
  // initDb() runs on EVERY connection (see connect()), so the
  // backfill must NOT live here. It runs once from the `init-db`
  // CLI command; going forward setCategory()/mergeUpsert() keep the
  // tag mirror in sync.
}

function _ensureUpdateTrigger(db: Database): void {
  /**
   * Install the guarded UPDATE trigger. A legacy DB carries the
   * unguarded `items_au` that rewrote both FTS indexes on every
   * write; `CREATE TRIGGER IF NOT EXISTS` cannot replace it, so
   * compare the stored definition and recreate when stale.
   * Skipping unchanged text is exact — the trigger mirrors only
   * these six columns into the indexes.
   */
  const existing = row<{ sql: string | null }>(
    db,
    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='items_au'",
  );

  if (existing?.sql?.includes(_AU_TRIGGER_GUARD)) return;
  db.exec("DROP TRIGGER IF EXISTS items_au");
  db.exec(_AU_TRIGGER_SQL);
}

// Bump when an FTS table is added/changed so upgraded DBs rebuild
// once — a boolean marker could never re-trigger (items_trgm
// arrived after some DBs set it, silently leaving their fuzzy
// index empty).
const _FTS_VERSION = 2;

function _ensureFtsBuilt(db: Database): void {
  /**
   * One-time rebuild of the external-content FTS indexes, gated by
   * a version marker. The marker stores the version last built;
   * legacy boolean-'1' DBs rebuild exactly once after upgrade
   * (populating any FTS table added since), then store
   * _FTS_VERSION.
   */
  const markerRow = row<{ value: string | null }>(
    db,
    "SELECT value FROM settings WHERE key='fts_built'",
  );

  const marker = Number.parseInt(String(markerRow?.value ?? "0"), 10) || 0;

  if (marker >= _FTS_VERSION) return;
  const hasRows = scalar(db, "SELECT EXISTS(SELECT 1 FROM items) AS c");

  if (hasRows) {
    db.exec("INSERT INTO items_fts(items_fts) VALUES('rebuild')");
    db.exec("INSERT INTO items_trgm(items_trgm) VALUES('rebuild')");
  }

  run(db, "INSERT OR REPLACE INTO settings(key, value) VALUES('fts_built', ?)", [
    String(_FTS_VERSION),
  ]);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function getSetting(db: Database, key: string, dflt: string | null = null): string | null {
  const r = row<{ value: string | null }>(db, "SELECT value FROM settings WHERE key=?", [key]);

  return r ? String(r.value) : dflt;
}

export function setSetting(db: Database, key: string, value: string): void {
  run(db, "INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)", [key, String(value)]);
}

const _SAVED_ORDER_KEY = "reddit_saved_order_top" satisfies string; // highest synthetic saved_utc rank allocated so far

/**
 * Reserve a contiguous block of `n` synthetic `saved_utc` ranks
 * ABOVE every block allocated before, and return the block's TOP
 * value; callers assign `top, top-1, …, top-(n-1)` in
 * newest-saved-first order.
 *
 * Reddit exposes no real per-item save time, so saved_utc is
 * synthesized from export/listing ROW ORDER. A persistent
 * monotonic anchor — `max(now, last_top + n)` — keeps "sort by
 * saved newest" coherent across imports AND cookie syncs made at
 * different times (no disjoint bands), while staying ~wall-clock
 * (it only rises above `now` when ingests cluster), so the "saved
 * Xd ago" display stays sane.
 */
export function allocateSavedOrder(db: Database, n: number): number {
  const lastTop = Number(getSetting(db, _SAVED_ORDER_KEY, "0") || 0);
  const top = Math.max(Math.floor(Date.now() / 1000), lastTop + Math.max(n, 0));
  setSetting(db, _SAVED_ORDER_KEY, String(top));

  return top;
}

const _DECAY_WAVE_KEY = "decay_wave_seq"; // highest decay-wave id allocated so far (monotonic)

const _SNOOZE_WAVE_KEY = "snooze_wave_seq"; // highest snooze-wave id allocated so far (monotonic)

/**
 * Reserve a UNIQUE monotonic decay-wave id and return it (mirrors
 * `allocateSavedOrder`). Each `decay` apply gets a distinct id
 * even when two calls land in the same wall-clock second —
 * `max(now, last + 1)` guarantees a strictly increasing value —
 * so a per-wave UNDO selects exactly one wave instead of every
 * wave sharing that second (the same-second collision bug).
 * Stays ~wall-clock (only rises above `now` when waves cluster
 * within a second), so the value is still usable as a "~when
 * decayed" stamp for `is:decayed` / `swept_recent`.
 */
export function allocateDecayWave(db: Database, now: number): number {
  const last = Number(getSetting(db, _DECAY_WAVE_KEY, "0") || 0);
  const wave = Math.max(now, last + 1);
  setSetting(db, _DECAY_WAVE_KEY, String(wave));

  return wave;
}

/**
 * Reserve a UNIQUE monotonic snooze-wave id. Mirrors
 * `allocateDecayWave` so an undo can target exactly one snooze
 * wave even when multiple snoozes happen in the same wall-clock
 * second.
 */
export function allocateSnoozeWave(db: Database, now: number): number {
  const last = Number(getSetting(db, _SNOOZE_WAVE_KEY, "0") || 0);
  const wave = Math.max(now, last + 1);
  setSetting(db, _SNOOZE_WAVE_KEY, String(wave));

  return wave;
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

/** Validate a SQLite items row and retain its serialized JSON columns. */
function rowToRaw(r: RawItem): RawItem {
  return RawItemSchema.parse(r);
}

/** Validate a SQLite items row and parse metadata for API consumers. */
function rowToPublic(r: RawItem): Item {
  const raw = rowToRaw(r);

  return { ...raw, metadata: parseMetadata(raw.metadata) };
}

function publicByFullname(db: Database, fullname: string): Item | null {
  const r = row<RawItem>(db, "SELECT * FROM items WHERE fullname=?", [fullname]);

  return r ? rowToPublic(r) : null;
}

function itemExists(db: Database, fullname: string): boolean {
  return (
    row<{ one: number }>(db, "SELECT 1 AS one FROM items WHERE fullname=?", [fullname]) !== null
  );
}

export function getItem(db: Database, fullname: string): RawItem | null {
  const r = row<RawItem>(db, "SELECT * FROM items WHERE fullname=?", [fullname]);

  return r ? rowToRaw(r) : null;
}

export function getPublicItem(db: Database, fullname: string): Item | null {
  return publicByFullname(db, fullname);
}

/** Coerce metadata.tags to a stable, de-duplicated string list. */
function tagList(value: JsonValue | undefined): string[] {
  const result = _TAG_LIST_SCHEMA.safeParse(value);

  return result.success ? [...new Set(result.data)] : [];
}

/**
 * Dual-write: mirror `category` into `metadata.tags` so
 * single-select processing areas filter through the multi-label
 * tag rail. This is the **intended bridge** (see the categorize
 * module docstring), not a legacy shim. Preserves unrelated
 * (non-processing) tags.
 */
export function metadataWithCategoryTag(
  metadata: Metadata | string | null | undefined,
  category: string,
): Metadata {
  const md = parseMetadata(metadata);
  const cat = (category || "").trim().toLowerCase();

  const tags = tagList(md.tags).filter(
    (tag) => !PROCESSING_TAGS.some((processingTag) => processingTag === tag),
  );

  if (PROCESSING_TAGS.some((processingTag) => processingTag === cat)) tags.push(cat);
  md.tags = tags;

  if (cat) md.category = cat;

  return md;
}

/**
 * The ONLY write path for `items.metadata` plus the `search_text`
 * mirror the external-content FTS indexes read (AGENTS.md rebuild
 * rule: no code path may write items without keeping both columns
 * in step). Pass `lastSeenUtc` only when the caller may move the
 * item in the feed; omit it to leave `last_seen_utc` untouched.
 */
export function writeItemMetadata(
  db: Database,
  item: RawItem,
  metadata: Metadata,
  lastSeenUtc?: number | null,
): void {
  const searchText = buildSearchText(item, metadata);

  if (lastSeenUtc === undefined || lastSeenUtc === null) {
    run(db, "UPDATE items SET metadata=?, search_text=? WHERE fullname=?", [
      JSON.stringify(metadata),
      searchText,
      item.fullname,
    ]);
  } else {
    run(db, "UPDATE items SET metadata=?, search_text=?, last_seen_utc=? WHERE fullname=?", [
      JSON.stringify(metadata),
      searchText,
      lastSeenUtc,
      item.fullname,
    ]);
  }
}

function updateMetadata(db: Database, item: RawItem, metadata: Metadata): void {
  const lastSeen = Number(item.last_seen_utc || Math.floor(Date.now() / 1000));

  writeItemMetadata(db, item, metadata, lastSeen);
}

/**
 * Shallow-merge `updates` into an item's metadata (+ rebuild
 * search_text) WITHOUT touching last_seen_utc, so a background
 * backfill (e.g. lazy thumbnail capture) never reorders the
 * feed. Skips falsy values; `onlyIfMissing` skips keys already
 * set truthy. Returns true iff a write happened. Caller commits.
 */
export function patchItemMetadata(
  db: Database,
  fullname: string,
  updates: Metadata,
  opts: { onlyIfMissing?: boolean } = {},
): boolean {
  const onlyIfMissing = opts.onlyIfMissing ?? false;
  const r = row<RawItem>(db, "SELECT * FROM items WHERE fullname=?", [fullname]);

  if (!r) return false;
  const item = rowToRaw(r);
  const md = parseMetadata(item.metadata);
  let changed = false;

  for (const [k, v] of Object.entries(updates)) {
    if (
      v === null ||
      v === undefined ||
      v === "" ||
      (Array.isArray(v) && v.length === 0) ||
      JSON.stringify(v) === "{}"
    ) {
      continue;
    }

    if (onlyIfMissing && md[k]) continue;

    if (md[k] !== v) {
      md[k] = v;
      changed = true;
    }
  }

  if (!changed) return false;
  writeItemMetadata(db, item, md);

  return true;
}

/**
 * Set `metadata.category` (single-select) and keep the
 * dual-write tag mirror in sync. See `metadataWithCategoryTag`
 * and the categorize module docstring for the three-system
 * taxonomy model.
 */
export function setCategory(db: Database, fullname: string, category: string): boolean {
  const item = getItem(db, fullname);

  if (!item) return false;
  const md = metadataWithCategoryTag(item.metadata, category);
  updateMetadata(db, item, md);

  return true;
}

function normUserTag(tag: string): string {
  /**
   * Normalize a user-entered tag: stripped + lowercased (to
   * match the curated vocabulary and avoid case-duplicate tags),
   * capped to a sane length.
   */
  return tag.trim().toLowerCase().slice(0, 40);
}

/**
 * Add/remove **user** tags on an item, non-destructively.
 *
 * Manual tags live in `metadata.tags` (the displayed list) AND
 * are stamped in `metadata.tags_manual` so the pipeline
 * (`categorize` re-tag / `mergeUpsert` re-import) can't clobber
 * them — the stamp is re-unioned wherever tags get rewritten.
 * Heuristic/programmatic tags are stamped separately in
 * `metadata.tags_auto` by `setAutoTags`, so future
 * sorting/filtering can distinguish human vs auto tags. Rebuilds
 * `search_text` but does NOT move `last_seen_utc` (a tag edit
 * shouldn't reorder the feed). Returns the resulting tag list, or
 * `null` if the item is missing. Caller commits.
 */
export function setTags(
  db: Database,
  fullname: string,
  opts: { add?: string[]; remove?: string[] } = {},
): string[] | null {
  const addTags = (opts.add ?? []).map((t) => normUserTag(t)).filter((s) => s);

  const removeTags = new Set((opts.remove ?? []).map((t) => normUserTag(t)).filter((s) => s));

  const item = getItem(db, fullname);

  if (!item) return null;
  const md = parseMetadata(item.metadata);
  const tags = tagList(md.tags);
  const manual = tagList(md.tags_manual);
  let changed = false;

  for (const t of addTags) {
    if (!manual.includes(t)) {
      manual.push(t);
      changed = true;
    }

    if (!tags.includes(t)) {
      tags.push(t);
      changed = true;
    }
  }

  if (removeTags.size) {
    const kept = tags.filter((t) => !removeTags.has(t));
    const keptManual = manual.filter((t) => !removeTags.has(t));

    if (kept.length !== tags.length || keptManual.length !== manual.length) {
      tags.length = 0;
      tags.push(...kept);
      manual.length = 0;
      manual.push(...keptManual);
      changed = true;
    }
  }

  if (changed) {
    md.tags = tags;

    if (manual.length) md.tags_manual = manual;
    else delete md.tags_manual;
    writeItemMetadata(db, item, md);
  }

  return tags;
}

/**
 * Replace an item's programmatic/heuristic tag stamp.
 *
 * `metadata.tags_auto` records the auto-generated subset, while
 * `metadata.tags` remains the displayed/searchable union of
 * preserved base tags + auto + manual tags. Clearing auto tags
 * (`tags=[]`) removes `tags_auto` and leaves any preserved tags
 * and `tags_manual` entries visible. This is intentionally
 * separate from `setTags`, which is the human edit path.
 * Returns the resulting displayed tag list, or `null` if the
 * item is missing. Caller commits.
 */
export function setAutoTags(
  db: Database,
  fullname: string,
  tags: string[],
  opts: { preserveTags?: string[]; lastSeenUtc?: number | null } = {},
): string[] | null {
  const item = getItem(db, fullname);

  if (!item) return null;
  const md = parseMetadata(item.metadata);
  const preserved = tagList(opts.preserveTags);
  const auto = tagList(tags);
  const manual = tagList(md.tags_manual);
  const final: string[] = [];

  for (const source of [preserved, auto, manual]) {
    for (const tag of source) {
      if (!final.includes(tag)) final.push(tag);
    }
  }

  if (final.length) md.tags = final;
  else delete md.tags;

  if (auto.length) md.tags_auto = auto;
  else delete md.tags_auto;

  writeItemMetadata(db, item, md, opts.lastSeenUtc);

  return final;
}

/**
 * One-time backfill: ensure the category→tag dual-write is
 * populated for rows that have a `metadata.category` but may be
 * missing the tag mirror. Idempotent — safe to re-run. Runs once
 * from the `init-db` CLI command (NOT per-connection — see
 * `initDb`).
 */
export function normalizeProcessingTags(db: Database): number {
  return withTransaction(db, () => {
    const candidates = rows<RawItem>(
      db,
      "SELECT * FROM items WHERE json_extract(metadata, '$.category') IS NOT NULL",
    );

    let changed = 0;

    for (const candidate of candidates) {
      const item = rowToRaw(candidate);
      const before = parseMetadata(item.metadata);

      const after = metadataWithCategoryTag(before, String(before.category || ""));

      if (JSON.stringify(after) !== JSON.stringify(before)) {
        updateMetadata(db, item, after);
        changed += 1;
      }
    }

    return changed;
  });
}

// ---------------------------------------------------------------------------
// Body / Obsidian-derived metadata
// ---------------------------------------------------------------------------

const _WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

// A leading ':' (namespaced tag), '/' or word char before '#'
// means the '#' is part of a URL/path/mention, not an inline tag.
const _INLINE_TAG_RE = /(?<![:/\w])#([\w-/]+)/g;

/** Metadata derived from an Obsidian note body. */
function obsidianBodyMetadata(body: string): Metadata {
  const wikilinks: string[] = [];

  for (const m of body.matchAll(_WIKILINK_RE)) {
    const target = (m[1] ?? "").split("#")[0]!.split("|")[0]!.trim();

    if (target && !wikilinks.includes(target)) wikilinks.push(target);
  }

  const tags: string[] = [];

  for (const m of body.matchAll(_INLINE_TAG_RE)) {
    const t = m[1]!;

    if (!tags.includes(t)) tags.push(t);
  }

  return { tags, wikilinks };
}

/**
 * Set an item's body, update search text, and mark it as
 * user-edited. Direct UPDATE mirrors the user-state helpers:
 * callers commit, and the existing items_au trigger keeps FTS in
 * sync.
 */
export function setBody(db: Database, fullname: string, body: string): Item | null {
  const prev = getItem(db, fullname);

  if (!prev) return null;
  const text = String(body || "");
  const item: RawItem = { ...prev, body: text };
  const md = parseMetadata(prev.metadata);
  md.body_edited_at = Math.floor(Date.now() / 1000);

  if (prev.source === "obsidian") {
    const derived = obsidianBodyMetadata(text);
    const manual = tagList(md.tags_manual);
    const tags = tagList(derived.tags);

    for (const t of manual) {
      if (!tags.includes(t)) tags.push(t);
    }

    md.tags = tags;
    md.wikilinks = derived.wikilinks ?? [];
  }

  run(db, "UPDATE items SET body=?, metadata=?, search_text=? WHERE fullname=?", [
    text,
    JSON.stringify(md),
    buildSearchText(item, md),
    fullname,
  ]);

  return publicByFullname(db, fullname);
}
// ---------------------------------------------------------------------------
// Upsert (non-destructive overlay)
// ---------------------------------------------------------------------------

const _OVERLAY_FIELDS = ["title", "body", "url", "author"] as const;

const _TIME_FIELDS = ["created_utc", "saved_utc"] as const;

const _USER_STATE_METADATA_KEYS = new Set([
  "karakeep_id",
  "decayed_at",
  "decay_label",
  "snoozed_until",
  "snoozed_wave",
  "snooze_count",
]);

/**
 * Column values for a brand-new row: derive the category tag
 * mirror, serialize metadata, and build the FTS search blob.
 */
function insertValues(
  item: RawItem,
  incomingMd: Metadata,
  incomingCategory: string,
): SQLQueryBindings[] {
  const finalMd = incomingCategory
    ? metadataWithCategoryTag(incomingMd, incomingCategory)
    : incomingMd;

  const toInsert: RawItem = {
    ...item,
    metadata: JSON.stringify(finalMd),
    search_text: buildSearchText(item, finalMd),
  };

  return ITEM_FIELDS.map((field) => toInsert[field] ?? null);
}

/** Chunked multi-row INSERT: one JS-to-SQLite call per chunk
 * instead of one per row. Statement dispatch and Bun's per-call
 * parameter marshalling dominate bulk import time — the b-tree
 * writes, FTS triggers included, are the smaller half. */
const _INSERT_CHUNK = 250;

function insertChunkSql(n: number): string {
  const row = `(${ITEM_FIELDS.map(() => "?").join(",")})`;

  return (
    `INSERT INTO items (${ITEM_FIELDS.join(",")}) VALUES ` +
    Array.from({ length: n }, () => row).join(",")
  );
}

/**
 * Insert a new item, or non-destructively overlay onto an
 * existing one. Returns `"inserted"` or `"updated"`. Never
 * overwrites user/triage state (`status`, `processed_utc`,
 * `status_prev`, `is_saved`, `metadata.karakeep_id`) and
 * never moves `first_seen_utc` forward.
 *
 * Merge contract (pinned by test_merge_upsert_tags_semantics
 * — port exactly):
 *
 * - title/body/url/author overlay ONLY when the incoming
 *   value is truthy, and body NEVER overlays when
 *   `metadata.body_edited_at` is set (user edits are
 *   durable);
 * - created_utc/saved_utc update only when the incoming
 *   value is truthy;
 * - kind upgrades from ""/"item"/null, never downgrades;
 * - metadata shallow-merges (incoming non-empty values
 *   win; prior keys kept), but USER_STATE_METADATA_KEYS
 *   on the stored row are preserved (decay/snooze/karakeep
 *   state is local user state, not re-importable);
 * - tags UNION-merge ONLY when the incoming item carries a
 *   category (the category mirror needs prior tags kept);
 *   otherwise incoming tags REPLACE existing ones wholesale
 *   — re-tag passes recompute from scratch and rely on
 *   this. A future partial-tags caller would clobber e.g.
 *   NSFW tags: change deliberately (with tests) or send
 *   category alongside;
 * - after the merge the category mirror is (re)derived and
 *   stamped tags_auto/tags_manual are re-unioned into
 *   `tags`, so any tag rewrite above can't drop them;
 * - first_seen_utc/status/processed_utc/status_prev/is_saved
 *   are preserved (local triage state); last_seen_utc
 *   follows the incoming row or now.
 */
export function mergeUpsert(db: Database, item: RawItem): string {
  const incomingMd = parseMetadata(item.metadata);
  const incomingCategory = incomingMd.category ?? "";

  // New rows are the common case during an import, and the merge
  // below is unreachable for them — probe existence instead of
  // materializing + schema-validating the whole row (body,
  // metadata, raw_json) only to throw it away.
  const existing = itemExists(db, item.fullname) ? getItem(db, item.fullname) : null;

  if (existing === null) {
    run(db, _INSERT_SQL, insertValues(item, incomingMd, incomingCategory));

    return "inserted";
  }

  mergeOnto(db, item, incomingMd, incomingCategory, existing);

  return "updated";
}

/** Non-destructive overlay of `item` onto a stored row (see the merge
 * contract on `mergeUpsert`). */
function mergeOnto(
  db: Database,
  item: RawItem,
  incomingMd: Metadata,
  incomingCategory: string,
  existing: RawItem,
): void {
  const merged: RawItem = { ...existing };
  const emd = parseMetadata(existing.metadata);

  for (const field of _OVERLAY_FIELDS) {
    if (field === "body" && emd.body_edited_at) continue;

    if (item[field]) merged[field] = item[field];
  }

  for (const field of _TIME_FIELDS) {
    if (item[field]) merged[field] = item[field];
  }

  if (item.kind && (existing.kind === "" || existing.kind === "item")) {
    merged.kind = item.kind;
  }

  for (const [key, value] of Object.entries(incomingMd)) {
    if (_USER_STATE_METADATA_KEYS.has(key) && key in emd) continue;

    if (key === "tags" && incomingCategory) {
      const tags = tagList(emd.tags);

      for (const tag of tagList(value)) {
        if (!tags.includes(tag)) tags.push(tag);
      }

      emd.tags = tags;
      continue;
    }

    if (
      value === null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0) ||
      JSON.stringify(value) === "{}"
    ) {
      continue;
    }

    emd[key] = value;
  }

  let finalMd = emd;

  if (incomingCategory) {
    finalMd = metadataWithCategoryTag(emd, incomingCategory);
  } else if (emd.category) {
    finalMd = metadataWithCategoryTag(emd, emd.category);
  }

  const stamped = [...tagList(finalMd.tags_auto), ...tagList(finalMd.tags_manual)];

  if (stamped.length) {
    const tags = tagList(finalMd.tags);

    for (const tag of stamped) {
      if (!tags.includes(tag)) tags.push(tag);
    }

    finalMd.tags = tags;
  }

  merged.metadata = JSON.stringify(finalMd);

  if (item.hydrated_at) merged.hydrated_at = item.hydrated_at;
  merged.first_seen_utc = existing.first_seen_utc;
  merged.last_seen_utc = item.last_seen_utc || Math.floor(Date.now() / 1000);
  merged.status = existing.status;
  merged.processed_utc = existing.processed_utc;
  merged.status_prev = existing.status_prev;
  merged.is_saved = existing.is_saved;
  merged.search_text = buildSearchText(merged, finalMd);

  const values = ITEM_FIELDS.filter((field) => field !== "fullname").map(
    (field) => merged[field] ?? null,
  );

  values.push(merged.fullname);
  run(db, _UPDATE_SQL, values);
}

export interface MergeBatchResult {
  inserted: number;
  updated: number;
  errors: { fullname: string; message: string }[];
}

/**
 * Batch form of `mergeUpsert` for imports. Rows the DB has never
 * seen are inserted with one multi-row statement per chunk —
 * per-row statement dispatch dominates a bulk import far more
 * than the b-tree work does. Everything else (existing rows,
 * fullnames repeated inside the batch) replays `mergeUpsert`
 * exactly, so merge semantics stay identical.
 *
 * Caller owns the transaction. A chunk that fails is replayed row
 * by row so one malformed item reports its own error without
 * losing its neighbours.
 */
export function mergeUpsertMany(db: Database, items: RawItem[]): MergeBatchResult {
  const result: MergeBatchResult = { inserted: 0, updated: 0, errors: [] };

  if (!items.length) return result;

  const occurrences = new Map<string, number>();

  for (const item of items) {
    occurrences.set(item.fullname, (occurrences.get(item.fullname) ?? 0) + 1);
  }

  const stored = new Map<string, RawItem>();
  const unique = items.filter((item) => occurrences.get(item.fullname) === 1);

  for (let start = 0; start < unique.length; start += _INSERT_CHUNK) {
    const names = unique.slice(start, start + _INSERT_CHUNK).map((item) => item.fullname);
    const placeholders = names.map(() => "?").join(",");

    for (const r of rows<RawItem>(
      db,
      `SELECT * FROM items WHERE fullname IN (${placeholders})`,
      names,
    )) {
      stored.set(r.fullname, rowToRaw(r));
    }
  }

  const fresh: RawItem[] = [];

  for (const item of items) {
    if (occurrences.get(item.fullname) === 1 && !stored.has(item.fullname)) {
      fresh.push(item);
      continue;
    }

    try {
      const existing = stored.get(item.fullname);

      if (existing) {
        const incomingMd = parseMetadata(item.metadata);

        mergeOnto(db, item, incomingMd, incomingMd.category ?? "", existing);
        result.updated += 1;
      } else {
        // Repeated inside this batch (or inserted concurrently):
        // replay the single-item sequence so the merge contract
        // applies to the earlier copy.
        const outcome = mergeUpsert(db, item);

        result[outcome === "inserted" ? "inserted" : "updated"] += 1;
      }
    } catch (exc) {
      result.errors.push({
        fullname: item.fullname,
        message: exc instanceof Error ? exc.message : String(exc),
      });
    }
  }

  for (let start = 0; start < fresh.length; start += _INSERT_CHUNK) {
    const chunk = fresh.slice(start, start + _INSERT_CHUNK);
    const values: SQLQueryBindings[] = [];

    for (const item of chunk) {
      const md = parseMetadata(item.metadata);

      values.push(...insertValues(item, md, md.category ?? ""));
    }

    try {
      run(db, insertChunkSql(chunk.length), values);
      result.inserted += chunk.length;
    } catch {
      for (const item of chunk) {
        try {
          const outcome = mergeUpsert(db, item);

          result[outcome === "inserted" ? "inserted" : "updated"] += 1;
        } catch (exc) {
          result.errors.push({
            fullname: item.fullname,
            message: exc instanceof Error ? exc.message : String(exc),
          });
        }
      }
    }
  }

  return result;
}

export type ItemPatch = Partial<
  Pick<
    RawItem,
    "kind" | "title" | "body" | "url" | "author" | "created_utc" | "saved_utc" | "hydrated_at"
  >
> & { metadata?: Metadata };

export function patchItem(db: Database, fullname: string, patch: ItemPatch): boolean {
  const existing = getItem(db, fullname);

  if (!existing) return false;
  const metadata = { ...parseMetadata(existing.metadata), ...patch.metadata };
  mergeUpsert(db, { ...existing, ...patch, fullname, metadata: JSON.stringify(metadata) });

  return true;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Build a safe FTS5 MATCH expression.
 *
 * - Each bare token is quoted so FTS5 operator keywords
 *   (OR/AND/NOT/NEAR) are treated as literals, not syntax.
 * - `exact` phrases are added as FTS5 phrase terms (also
 *   quoted, inner quotes doubled).
 * - `exclude` terms are appended as `NOT "term"` clauses.
 *
 * IMPORTANT: the caller must ensure there is at least one
 * *positive* term (either `q` tokens or `exact`). FTS5
 * rejects queries that contain only NOTs.
 */
function ftsQuery(q: string, opts: { exact?: string[]; exclude?: string[] } = {}): string {
  const exact = opts.exact ?? [];
  const exclude = opts.exclude ?? [];

  const toks = (q || "").split(/\W+/u).filter((t) => t);
  const parts: string[] = toks.map((t) => `"${t}"`);

  for (const phrase of exact) {
    const p = (phrase || "").trim();

    if (!p) continue;
    parts.push(`"${p.replaceAll('"', '""')}"`);
  }

  if (!parts.length) return "";

  let out = parts.join(" ");

  for (const term of exclude) {
    for (const t of (term || "").split(/\W+/u).filter((x) => x)) {
      out += ` NOT "${t.replaceAll('"', '""')}"`;
    }
  }

  return out;
}

/**
 * (AND, OR) expressions over the query's overlapping
 * 3-grams; ("", "") if < 3 chars.
 *
 * AND ≈ "contains the typed string" — the tight default
 * for fuzzy search (partial words and trailing typos still
 * match via substring). OR matches ANY single gram and is
 * junk unless rank-ordered — it exists only as the
 * typo-rescue fallback when the tight pass finds nothing
 * (became user-visible when fuzzy went default-on: an
 * OR-only match made every bare search return one-gram
 * noise in recency order).
 */
function trigramExprs(q: string): [string, string] {
  const s = (q || "").trim().toLowerCase();

  if (s.length < 3) return ["", ""];
  const grams = new Set<string>();

  for (let i = 0; i < s.length - 2; i += 1) grams.add(s.slice(i, i + 3));

  const quoted = [...grams].sort().map((g) => `"${g.replaceAll('"', '""')}"`);

  return [quoted.join(" AND "), quoted.join(" OR ")];
}

function orderClause(sort: string | undefined, order: string | undefined, alias = ""): string {
  const a = alias ? `${alias}.` : "";

  if (sort === "shuffle") {
    // "Mixed-content" browse (Epic 10): interleave sources
    // round-robin so a page is a varied MIX instead of
    // grouped/recency. Deterministic (nth-item-of-each-source,
    // then source) so infinite-scroll pages don't dup/skip —
    // unlike ORDER BY RANDOM().
    return (
      `ORDER BY row_number() OVER (PARTITION BY ${a}source ` +
      `ORDER BY ${a}first_seen_utc DESC, ${a}rowid), ${a}source`
    );
  }

  const sortKey = sort ?? "";
  const col = isSortKey(sortKey) ? _SORT_COLUMNS[sortKey] : _SORT_COLUMNS.last_seen_utc;
  const direction = (order || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  // Expression sort keys (json_extract/CAST) must not be
  // table-alias-prefixed, and NULLs (e.g. videos with no
  // duration) should sort last in either direction.
  const isExpr = col.includes("(");
  const colSql = isExpr ? col : `${a}${col}`;
  const nulls = isExpr ? " NULLS LAST" : "";

  return `ORDER BY ${colSql} ${direction}${nulls}, ${a}rowid ${direction}`;
}

export interface SearchOpts {
  source?: string | string[] | null;
  kind?: string | string[] | null;
  status?: string | string[] | null;
  category?: string | null;
  tags?: string[] | null;
  tagsAll?: boolean;
  subreddit?: string | string[] | null;
  author?: string | string[] | null;
  isSaved?: number | null;
  nsfw?: boolean;
  hideNsfw?: boolean;
  decayed?: boolean;
  swept?: boolean;
  snoozed?: boolean;
  hideSnoozed?: boolean;
  deleted?: boolean;
  hasMedia?: string | string[] | null;
  before?: number | null;
  after?: number | null;
  scoreMin?: number | null;
  scoreMax?: number | null;
  exact?: string[] | null;
  exclude?: string[] | null;
  openInFirefox?: boolean;
  ocr?: boolean;
  includeConsolidated?: boolean;
  fuzzy?: boolean;
  sort?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

/**
 * Search/browse items. Empty `q` => filtered recency list.
 *
 * FTS path (positive term present): MATCH on items_fts (or
 * items_trgm when `fuzzy` with no exact/exclude), all other
 * filters applied in SQL on the joined items row. When the
 * tight trigram pass is empty ON PAGE ONE, an OR-of-grams
 * rescue runs rank-ordered (bm25) so near-misses surface —
 * gated to offset 0: on deeper pages an empty tight result
 * means the real matches are simply exhausted.
 *
 * No positive term (operator-only or `-exclude`-only
 * query): plain filtered SELECT; excludes become
 * `LOWER(search_text) NOT LIKE` scans so they are never
 * silently dropped.
 */
export function searchItems(db: Database, q: string = "", opts: SearchOpts = {}): Item[] {
  const filters: string[] = [];
  const params: SQLQueryBindings[] = [];

  const addFilters = (alias: string): void => {
    const a = alias ? `${alias}.` : "";

    const {
      source,
      kind,
      status,
      category,
      tags,
      tagsAll,
      subreddit,
      author,
      isSaved,
      nsfw,
      hideNsfw,
      decayed,
      swept,
      snoozed,
      hideSnoozed,
      deleted,
      hasMedia,
      before,
      after,
      scoreMin,
      scoreMax,
      openInFirefox,
      ocr,
      includeConsolidated,
    } = opts;

    if (source) {
      if (Array.isArray(source)) {
        const ph = source.map(() => "?").join(",");
        filters.push(`${a}source IN (${ph})`);
        params.push(...source);
      } else {
        filters.push(`${a}source = ?`);
        params.push(source);
      }
    }

    if (kind) {
      if (Array.isArray(kind)) {
        const ph = kind.map(() => "?").join(",");
        filters.push(`${a}kind IN (${ph})`);
        params.push(...kind);
      } else {
        filters.push(`${a}kind = ?`);
        params.push(kind);
      }
    }

    if (status) {
      if (Array.isArray(status)) {
        const ph = status.map(() => "?").join(",");
        filters.push(`${a}status IN (${ph})`);
        params.push(...status);
      } else {
        filters.push(`${a}status = ?`);
        params.push(status);
      }
    }

    if (category) {
      if (PROCESSING_TAGS.some((processingTag) => processingTag === category)) {
        filters.push(
          `(json_extract(${a}metadata, '$.category') = ? OR ` +
            `EXISTS (SELECT 1 FROM json_each(${a}metadata, '$.tags') WHERE value = ?))`,
        );
        params.push(category, category);
      } else {
        filters.push(`json_extract(${a}metadata, '$.category') = ?`);
        params.push(category);
      }
    }

    if (tags?.length) {
      if (tagsAll) {
        // AND: require membership for every tag.
        for (const t of tags) {
          filters.push(`EXISTS (SELECT 1 FROM json_each(${a}metadata, '$.tags') WHERE value = ?)`);
          params.push(t);
        }
      } else {
        // OR: match any selected tag.
        const ph = tags.map(() => "?").join(",");
        filters.push(
          `EXISTS (SELECT 1 FROM json_each(${a}metadata, '$.tags') WHERE value IN (${ph}))`,
        );
        params.push(...tags);
      }
    }

    // An item is NSFW if it carries an NSFW tag OR Reddit
    // flagged it over_18. The UI blurs/badges on over_18
    // alone (render.js isNsfw), but the over_18 flag is too
    // sparse for categorize to reliably tag (gitignored
    // subreddit rules), so a tag-only filter left
    // over_18-but-untagged items visible under "Hide NSFW"
    // (Epic 13 P2). COALESCE keeps an absent over_18 from
    // NULL-propagating through `NOT (… OR …)` and hiding
    // SFW rows.
    let nsfwPred = "";

    if (nsfw || hideNsfw) {
      const ph = NSFW_TAGS.map(() => "?").join(",");
      nsfwPred =
        `(EXISTS (SELECT 1 FROM json_each(${a}metadata, '$.tags') WHERE value IN (${ph}))` +
        ` OR COALESCE(json_extract(${a}metadata, '$.over_18'), 0) = 1)`;
    }

    if (nsfw) {
      filters.push(nsfwPred);
      params.push(...NSFW_TAGS);
    }

    if (hideNsfw) {
      filters.push(`NOT ${nsfwPred}`); // exact inverse of the include filter above
      params.push(...NSFW_TAGS);
    }

    if (hasMedia) {
      // has:video|image|gallery — facet over metadata.media_type.
      // "video" means reddit-hosted video ('reddit_video');
      // external embeds keep media_type='link'.
      if (Array.isArray(hasMedia)) {
        const mapped = hasMedia.map((h) => (h === "video" ? "reddit_video" : h));
        const ph = mapped.map(() => "?").join(",");
        filters.push(`json_extract(${a}metadata, '$.media_type') IN (${ph})`);
        params.push(...mapped);
      } else {
        const mt = hasMedia === "video" ? "reddit_video" : hasMedia;
        filters.push(`json_extract(${a}metadata, '$.media_type') = ?`);
        params.push(mt);
      }
    }

    if (decayed) {
      // decayed (is:decayed): the item carries a decay-wave stamp (see decay).
      filters.push(`json_extract(${a}metadata, '$.decayed_at') IS NOT NULL`);
    }

    if (swept) {
      // swept (is:swept): decayed in the labeled initial backfill pass specifically.
      filters.push(`json_extract(${a}metadata, '$.decay_label') = 'swept'`);
    }

    if (snoozed) {
      // snoozed (is:snoozed): currently hidden from triage until a future UTC.
      filters.push(`json_extract(${a}metadata, '$.snoozed_until') > ?`);
      params.push(Math.floor(Date.now() / 1000));
    }

    if (hideSnoozed && !snoozed) {
      filters.push(
        `(json_extract(${a}metadata, '$.snoozed_until') IS NULL ` +
          `OR json_extract(${a}metadata, '$.snoozed_until') <= ?)`,
      );
      params.push(Math.floor(Date.now() / 1000));
    }

    if (deleted) {
      // deleted (is:deleted): media probed gone (scan-deleted-media).
      // media_status is the durable SSOT — the mirrored `deleted`
      // tag is wiped by a categorize retag.
      filters.push(`json_extract(${a}metadata, '$.media_status') = 'gone'`);
    }

    if (ocr) {
      // ocr (is:ocr): items carrying non-empty metadata.ocr_text.
      // Matches by truthy non-empty string (SQLite's json_extract
      // returns NULL for missing keys, so a plain `<> ''` filter
      // would match every row with no ocr_text key — the explicit
      // IS NOT NULL gate keeps ocr-less rows out of the result).
      filters.push(
        `json_extract(${a}metadata, '$.ocr_text') IS NOT NULL ` +
          `AND CAST(json_extract(${a}metadata, '$.ocr_text') AS TEXT) <> ''`,
      );
    }

    if (subreddit) {
      if (Array.isArray(subreddit)) {
        const ph = subreddit.map(() => "?").join(",");
        // COLLATE belongs on the left operand: on the IN expression
        // it only tags the result, leaving the comparisons BINARY
        // and the NOCASE index unusable.
        filters.push(`json_extract(${a}metadata, '$.subreddit') COLLATE NOCASE IN (${ph})`);
        params.push(...subreddit);
      } else {
        filters.push(`json_extract(${a}metadata, '$.subreddit') = ? COLLATE NOCASE`);
        params.push(subreddit);
      }
    }

    if (author) {
      // author is a first-class column (filled for reddit/HN);
      // matched case-insensitively to mirror subreddit. Drives the
      // `author:` operator + the bare `u/<user>` shorthand.
      if (Array.isArray(author)) {
        const ph = author.map(() => "?").join(",");
        filters.push(`${a}author COLLATE NOCASE IN (${ph})`);
        params.push(...author);
      } else {
        filters.push(`${a}author = ? COLLATE NOCASE`);
        params.push(author);
      }
    }

    if ((before !== undefined && before !== null) || (after !== undefined && after !== null)) {
      // created_utc=0 means "unknown" for many sparse imports;
      // avoid treating 0 as "ancient" when date filters are active.
      filters.push(`${a}created_utc > 0`);
    }

    if (before !== undefined && before !== null) {
      filters.push(`${a}created_utc < ?`);
      params.push(Number(before));
    }

    if (after !== undefined && after !== null) {
      filters.push(`${a}created_utc >= ?`);
      params.push(Number(after));
    }

    if (
      (scoreMin !== undefined && scoreMin !== null) ||
      (scoreMax !== undefined && scoreMax !== null)
    ) {
      // Exclude NULL scores when a score filter is active.
      filters.push(`json_extract(${a}metadata, '$.score') IS NOT NULL`);
      const scoreExpr = `CAST(json_extract(${a}metadata, '$.score') AS INTEGER)`;

      if (scoreMin !== undefined && scoreMin !== null) {
        filters.push(`${scoreExpr} >= ?`);
        params.push(Number(scoreMin));
      }

      if (scoreMax !== undefined && scoreMax !== null) {
        filters.push(`${scoreExpr} <= ?`);
        params.push(Number(scoreMax));
      }
    }

    if (isSaved !== undefined && isSaved !== null) {
      filters.push(`${a}is_saved = ?`);
      params.push(Number(isSaved));
    }

    if (openInFirefox) {
      // the "📑 Firefox tabs" batch (json true -> json_extract returns 1)
      filters.push(`json_extract(${a}metadata, '$.open_in_firefox') = 1`);
    }

    if (!includeConsolidated) {
      filters.push(`json_extract(${a}metadata, '$.consolidated_into') IS NULL`);
    }
  };

  const query = (q || "").trim();
  const exact = opts.exact ?? [];
  const exclude = opts.exclude ?? [];

  let matchExpr = "";
  let ftsTable = "";
  let fuzzyRescue = ""; // OR-of-trigrams typo fallback; only ever run rank-ordered

  // FTS5 requires at least one positive term; if the query is
  // only operators/negations, fall back to the plain filtered
  // SELECT path.
  const hasPositive = Boolean(query) || Boolean(exact);

  if (hasPositive) {
    if (opts.fuzzy && query && !exact.length && !exclude.length) {
      const [andExpr, orExpr] = trigramExprs(query);

      if (andExpr) {
        matchExpr = andExpr;
        ftsTable = "items_trgm";

        if (orExpr !== andExpr) {
          // >1 gram, a rescue pass is meaningful
          fuzzyRescue = orExpr;
        }
      }
    }

    if (!matchExpr) {
      // exact (or fuzzy fell back for short queries)
      matchExpr = ftsQuery(query, { exact, exclude });
      ftsTable = "items_fts";
    }
  }

  const limit = Number(opts.limit ?? 50);
  const offset = Number(opts.offset ?? 0);

  if (matchExpr && ftsTable) {
    addFilters("i");
    const where = [`${ftsTable} MATCH ?`, ...filters].join(" AND ");

    const sqlBase =
      `SELECT i.* FROM items i JOIN ${ftsTable} ON ${ftsTable}.rowid = i.rowid ` +
      `WHERE ${where} {order} LIMIT ? OFFSET ?`;

    const bind: SQLQueryBindings[] = [matchExpr];

    for (const param of params) bind.push(param);
    bind.push(limit, offset);

    let result = rows<RawItem>(
      db,
      sqlBase.replace("{order}", orderClause(opts.sort, opts.order, "i")),
      bind,
    );

    if (!result.length && fuzzyRescue && !offset) {
      // Tight pass empty ON PAGE ONE -> genuine typo territory:
      // match any gram, best trigram overlap first (bm25 rank),
      // so near-misses surface and junk sinks. Gated to offset 0:
      // on deeper pages an empty tight result means the real
      // matches are simply exhausted — rescuing there would append
      // unrelated one-gram noise after the genuine results
      // (pagination/infinite-scroll bug).
      bind[0] = fuzzyRescue;
      result = rows<RawItem>(
        db,
        sqlBase.replace("{order}", "ORDER BY rank, i.last_seen_utc DESC"),
        bind,
      );
    }

    return result.map(rowToPublic);
  }

  addFilters("");

  // No positive FTS term to hang a NOT off of (e.g. a
  // `-term`-only query), so apply the negations as plain
  // search_text exclusions instead — otherwise they'd be
  // silently dropped. (`\W+` tokens are word-chars only, so
  // escape just LIKE's `_`.)
  for (const term of exclude) {
    for (const tk of (term || "").split(/\W+/u).filter((t) => t)) {
      const esc = tk
        .toLowerCase()
        .replaceAll("\\", "\\\\")
        .replaceAll("_", "\\_")
        .replaceAll("%", "\\%");

      filters.push(`LOWER(search_text) NOT LIKE ? ESCAPE '\\'`);
      params.push(`%${esc}%`);
    }
  }

  if (opts.sort === "shuffle" && offset + limit <= _SHUFFLE_MERGE_MAX) {
    return shufflePage(db, filters, params, limit, offset);
  }

  const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";

  const sql = `SELECT * FROM items${where} ${orderClause(opts.sort, opts.order)} LIMIT ? OFFSET ?`;

  const bind: SQLQueryBindings[] = [...params, limit, offset];

  return rows<RawItem>(db, sql, bind).map(rowToPublic);
}

/** Page size beyond which a shuffle page re-reads more rowids per
 * source than one full scan would (see `shufflePage`). */
const _SHUFFLE_MERGE_MAX = 2_000;

/**
 * `sort=shuffle` interleaves the sources round-robin, each ordered
 * by recency — a transpose of per-source sequences. The window
 * function form makes SQLite rank every row before LIMIT can apply
 * (full scan + two sorts, ~100ms per page); transposing instead
 * reads only the first `offset + limit` rowids of each source and
 * walks the diagonal. Same order, same rows.
 *
 * Only shallow pages merge: past `_SHUFFLE_MERGE_MAX` the per-source
 * previews together exceed one scan, so the window query (which pays
 * that scan once) is the cheaper way to reach the page.
 */
function shufflePage(
  db: Database,
  filters: string[],
  params: SQLQueryBindings[],
  limit: number,
  offset: number,
): Item[] {
  const take = offset + limit;

  // Source discovery ignores the filters on purpose: this is a
  // skip-scan over the source index, and a source with no matching
  // rows simply contributes none.
  const sources = rows<{ source: string }>(db, "SELECT DISTINCT source FROM items")
    .map((r) => String(r.source))
    .sort();

  const where = filters.length ? ` WHERE ${filters.join(" AND ")} AND` : " WHERE";
  const previews = new Map<string, number[]>();

  for (const source of sources) {
    previews.set(
      source,
      rows<{ rowid: number }>(
        db,
        `SELECT rowid FROM items${where} source=? ` +
          "ORDER BY first_seen_utc DESC, rowid DESC LIMIT ?",
        [...params, source, take],
      ).map((r) => Number(r.rowid)),
    );
  }

  const picked: number[] = [];
  let streamed = 0;

  for (let nth = 0; picked.length < limit; nth += 1) {
    let advanced = false;

    for (const source of sources) {
      const preview = previews.get(source) ?? [];

      if (nth >= preview.length) continue;
      advanced = true;

      if (streamed >= offset) picked.push(preview[nth]!);

      streamed += 1;

      if (picked.length >= limit) break;
    }

    if (!advanced) break;
  }

  if (!picked.length) return [];

  const placeholders = picked.map(() => "?").join(",");

  const found = rows<RawItem & { rowid: number }>(
    db,
    `SELECT rowid, * FROM items WHERE rowid IN (${placeholders})`,
    picked,
  );

  const byRowid = new Map(found.map((r) => [Number(r.rowid), r]));

  return picked.flatMap((rowid) => {
    const r = byRowid.get(rowid);

    return r ? [rowToPublic(r)] : [];
  });
}

/**
 * Return up to `n` items — the triage batch (default: smart
 * inbox).
 *
 * `mode='smart'` (Epic 10) interleaves likely-to-be-processed
 * items with recent ones instead of a flat shuffle: ~`smartMix`
 * of the batch is sampled from the top of `metadata.triage_score`
 * (written by triage_score.learn), the rest from the
 * newest-synced, topped up randomly when either pool runs short.
 * Sampling from a pool (5x oversample) rather than taking the
 * strict top keeps repeat batches varied. Falls back to pure
 * random when no scores exist yet.
 */
export function getRandomBatch(
  db: Database,
  n = 20,
  opts: {
    source?: string | null;
    category?: string | null;
    tags?: string[] | null;
    unprocessed?: boolean;
    mode?: string;
    smartMix?: number;
  } = {},
): Item[] {
  const unprocessed = opts.unprocessed ?? true;
  const smartMix = opts.smartMix ?? 0.5;

  const filters: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (unprocessed) {
    filters.push("status = 'inbox'");
    filters.push(
      "(json_extract(metadata, '$.snoozed_until') IS NULL " +
        "OR json_extract(metadata, '$.snoozed_until') <= ?)",
    );
    params.push(Math.floor(Date.now() / 1000));
  }

  if (opts.source) {
    filters.push("source = ?");
    params.push(opts.source);
  }

  if (opts.category) {
    if (PROCESSING_TAGS.some((processingTag) => processingTag === opts.category)) {
      filters.push(
        "(" +
          "json_extract(metadata, '$.category') = ? OR " +
          "EXISTS (SELECT 1 FROM json_each(metadata, '$.tags') WHERE value = ?)" +
          ")",
      );
      params.push(opts.category, opts.category);
    } else {
      filters.push("json_extract(metadata, '$.category') = ?");
      params.push(opts.category);
    }
  }

  if (opts.tags?.length) {
    const ph = opts.tags.map(() => "?").join(",");
    filters.push(`EXISTS (SELECT 1 FROM json_each(metadata, '$.tags') WHERE value IN (${ph}))`);
    params.push(...opts.tags);
  }

  const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";

  const mode = (opts.mode || "smart").trim().toLowerCase();

  const safeMode = ["smart", "recent", "random"].includes(mode) ? mode : "smart";

  if (safeMode === "random") {
    const sql = `SELECT * FROM items${where} ORDER BY RANDOM() LIMIT ?`;

    return rows<RawItem>(db, sql, [...params, n]).map(rowToPublic);
  }

  if (safeMode === "recent") {
    const sql = `SELECT * FROM items${where} ORDER BY first_seen_utc DESC, rowid DESC LIMIT ?`;

    return rows<RawItem>(db, sql, [...params, n]).map(rowToPublic);
  }

  const count = Math.max(1, Math.round(n));
  const kScore = Math.max(1, Math.round(count * smartMix));
  const kRecent = Math.max(0, count - kScore);

  const scoreWhere =
    where + (where ? " AND " : " WHERE ") + "json_extract(metadata, '$.triage_score') IS NOT NULL";

  // Without statistics SQLite prices the status bucket as tiny and
  // sorts every inbox row (~25ms per deck request). Scanning the
  // triage-score index instead stops as soon as the pool is full
  // (~0.1ms). Only the unfiltered deck takes the hint: a narrowing
  // filter's own index is the better entry point there.
  const scoreScan =
    opts.source || opts.category || opts.tags?.length ? "" : " INDEXED BY idx_items_triage_score";

  const scorePool = rows<RawItem>(
    db,
    `SELECT * FROM items${scoreScan}${scoreWhere} ` +
      // CAST matches _SORT_COLUMNS.smart and the index expression.
      `ORDER BY CAST(json_extract(metadata, '$.triage_score') AS REAL) DESC LIMIT ?`,
    [...params, kScore * 5],
  );

  const recentPool = rows<RawItem>(
    db,
    `SELECT * FROM items${where} ORDER BY first_seen_utc DESC LIMIT ?`,
    [...params, kRecent * 5],
  );

  const picked = new Map<string, RawItem>();

  for (const [pool, k] of [
    [scorePool, kScore],
    [recentPool, kRecent],
  ] as const) {
    const fresh = pool.filter((r) => !picked.has(String(r.fullname)));

    for (const r of sample(fresh, Math.min(k, fresh.length))) {
      picked.set(String(r.fullname), r);
    }
  }

  if (picked.size < count) {
    // Top up randomly (small inboxes, missing scores).
    const ph = [...picked.keys()].map(() => "?").join(",");

    const sql =
      `SELECT * FROM items${where}` +
      (where ? " AND " : " WHERE ") +
      (ph ? `fullname NOT IN (${ph}) ` : "") +
      `ORDER BY RANDOM() LIMIT ?`;

    const extra = rows<RawItem>(db, sql, [...params, ...picked.keys(), count - picked.size]);

    for (const r of extra) picked.set(String(r.fullname), r);
  }

  const out = [...picked.values()];
  shuffle(out);

  return out.slice(0, count).map(rowToPublic);
}

/** Random sample without replacement (mirrors random.sample). */
function sample<T>(xs: T[], k: number): T[] {
  const copy = [...xs];

  for (let i = 0; i < k && copy.length; i += 1) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }

  return copy.slice(0, Math.min(k, xs.length));
}

/** In-place Fisher-Yates (mirrors random.shuffle). */
function shuffle<T>(xs: T[]): void {
  for (let i = xs.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
}
// ---------------------------------------------------------------------------
// Reddit unsave queue
// ---------------------------------------------------------------------------

/** Whether marking a reddit item 'done' should queue it for unsaving on Reddit. */
export function unsaveEnabled(db: Database): boolean {
  return getSetting(db, "reddit_unsave_on_done", "0") === "1";
}

/**
 * Queue a reddit post/comment for unsaving (idempotent).
 * No-op for non-reddit items.
 *
 * The reddit_id stored is items.source_id, which already
 * carries the t3_/t1_ prefix the Reddit API wants. Does
 * NOT commit — the caller commits with the status change.
 */
export function enqueueUnsave(db: Database, fullname: string): void {
  const r = row<{ source: string; source_id: string }>(
    db,
    "SELECT source, source_id FROM items WHERE fullname=?",
    [fullname],
  );

  if (!r || r.source !== "reddit") return;
  const sid = String(r.source_id);

  if (!sid.startsWith("t1_") && !sid.startsWith("t3_")) return;
  const now = Math.floor(Date.now() / 1000);
  run(
    db,
    "INSERT INTO reddit_unsave(fullname, reddit_id, state, enqueued_utc) " +
      "VALUES(?, ?, 'pending', ?) " +
      // attempts/last_error reset: a re-Done item gets a fresh chance even if a prior
      // run exhausted its MAX_ATTEMPTS and parked it as 'failed'.
      "ON CONFLICT(fullname) DO UPDATE SET state='pending', attempts=0, last_error=NULL, " +
      "updated_utc=excluded.enqueued_utc",
    [fullname, sid, now],
  );
}

/** Drop a still-pending unsave (a 'done' undone before the drain ran). Caller commits. */
export function dequeueUnsave(db: Database, fullname: string): void {
  run(db, "DELETE FROM reddit_unsave WHERE fullname=? AND state='pending'", [fullname]);
}

/**
 * Backfill: queue every reddit post/comment already marked 'done'
 * for unsaving.
 *
 * Enabling the feature does not retroactively enqueue past Dones;
 * this is the opt-in one-time seed. Items already queued are left
 * untouched. Returns the number added.
 */
export function enqueueExistingDone(db: Database): number {
  const now = Math.floor(Date.now() / 1000);
  const before = scalar(db, "SELECT COUNT(*) AS c FROM reddit_unsave");
  run(
    db,
    "INSERT INTO reddit_unsave(fullname, reddit_id, state, enqueued_utc) " +
      "SELECT fullname, source_id, 'pending', ? FROM items " +
      "WHERE source='reddit' AND status='done' " +
      "AND (source_id LIKE 't3\\_%' ESCAPE '\\' OR source_id LIKE 't1\\_%' ESCAPE '\\') " +
      "ON CONFLICT(fullname) DO NOTHING",
    [now],
  );
  const after = scalar(db, "SELECT COUNT(*) AS c FROM reddit_unsave");

  return after - before;
}

/**
 * Heal saved COMMENTS that were ingested (pre-fix) with a ``t3_``
 * (link) prefix instead of ``t1_`` (comment). Reddit's write endpoints
 * 400 on the wrong thing-type, so an unsave of such a row fails forever
 * and parks as ``state='failed'``.
 *
 * The correct id is derived from the item's permalink (a comment
 * permalink carries a second id segment:
 * ``/comments/<post>/<slug>/<comment>/``) via the SAME parser the
 * importer uses, so this can't disagree with ingest. Rewrites every
 * place the wrong id lives so a later re-sync can't re-insert a ``t1_``
 * duplicate of the same comment: ``items.source_id`` **and** the
 * ``fullname`` primary key (``reddit:t3_x`` -> ``reddit:t1_x``), plus
 * the dependent ``reddit_unsave`` (fullname + reddit_id) and
 * ``reddit_threads`` (fullname) rows. ``items_fts`` is kept in sync by
 * the items AFTER UPDATE trigger. A row whose corrected fullname already
 * exists is skipped (no PK collision). Idempotent (fixed rows no longer
 * match ``t3_``). Returns the number of items corrected; commits.
 */
export function repairRedditCommentPrefixes(db: Database): number {
  return withTransaction(db, () => {
    const candidates = rows<{ fullname: string; source_id: string; permalink: string | null }>(
      db,
      "SELECT fullname, source_id, json_extract(metadata, '$.permalink') AS permalink " +
        "FROM items WHERE source='reddit' AND source_id LIKE 't3\\_%' ESCAPE '\\'",
    );

    let fixed = 0;

    for (const candidate of candidates) {
      const correct = sidFromPermalink(String(candidate.permalink || ""));
      // Only act when the permalink resolves to a COMMENT for this exact
      // id (same bare base36, t1_ prefix). A real link/post
      // (correct[:3]=='t3_') or a mismatch is left untouched.
      const sourceId = String(candidate.source_id);

      if (!(correct.startsWith("t1_") && correct.slice(3) === sourceId.slice(3))) {
        continue;
      }

      const oldFullname = String(candidate.fullname);
      const newFullname = `reddit:${correct}`;

      if (
        row<{ exists: number }>(db, "SELECT 1 AS exists FROM items WHERE fullname=?", [newFullname])
      ) {
        continue; // corrected row already exists — don't collide the PK
      }

      run(db, "UPDATE items SET source_id=?, fullname=? WHERE fullname=?", [
        correct,
        newFullname,
        oldFullname,
      ]);
      run(db, "UPDATE reddit_unsave SET fullname=?, reddit_id=? WHERE fullname=?", [
        newFullname,
        correct,
        oldFullname,
      ]);
      run(db, "UPDATE reddit_threads SET fullname=? WHERE fullname=?", [newFullname, oldFullname]);
      fixed += 1;
    }

    return fixed;
  });
}

/**
 * Remove phantom ``t3_`` duplicates of saved COMMENTS that ALSO
 * exist (correctly) as ``t1_``.
 *
 * A pre-fix ingest recorded some saved comments under BOTH the right
 * id (``reddit:t1_x``) and a wrong link-typed id (``reddit:t3_x``). The
 * ``t3_`` twin is bogus: it shows as a duplicate inbox item and 400s on
 * unsave (Reddit rejects the wrong thing-type). This collapses each pair
 * onto the canonical ``t1_`` row:
 *
 * - if the canonical row is still ``inbox`` and the phantom carries a
 *   real triage decision, that decision is moved to the canonical row
 *   (`setStatus`) so a done/archived made on the duplicate isn't lost;
 * - if the phantom was queued for unsave, the REAL comment is queued
 *   instead (so the originally intended unsave finally targets a valid
 *   id);
 * - the phantom's ``items`` row (``items_fts`` auto-cleaned by the
 *   AFTER DELETE trigger), ``reddit_unsave`` row, and ``reddit_threads``
 *   row are deleted.
 *
 * Distinct from `repairRedditCommentPrefixes`, which RENAMES a t3_
 * comment that has NO t1_ twin. Idempotent. Returns
 * `{removed, status_moved, requeued}`; commits.
 */
export function dedupeRedditCommentTwins(db: Database): RedditCommentDedupeResult {
  const candidates = rows<{
    fullname: string;
    source_id: string;
    status: string;
    permalink: string | null;
  }>(
    db,
    "SELECT fullname, source_id, status, json_extract(metadata,'$.permalink') AS permalink " +
      "FROM items WHERE source='reddit' AND source_id LIKE 't3\\_%' ESCAPE '\\'",
  );

  let removed = 0;
  let statusMoved = 0;
  let requeued = 0;

  for (const r of candidates) {
    const correct = sidFromPermalink(String(r.permalink || ""));
    const sourceId = String(r.source_id);

    if (!(correct.startsWith("t1_") && correct.slice(3) === sourceId.slice(3))) {
      continue;
    }

    const twinFullname = `reddit:${correct}`;

    const twin = row<{ status: string }>(db, "SELECT status FROM items WHERE fullname=?", [
      twinFullname,
    ]);

    if (!twin) {
      continue; // no twin -> a true orphan; repair_reddit_comment_prefixes
    }

    const phantom = String(r.fullname);

    if (twin.status === "inbox" && r.status !== "inbox") {
      setStatus(db, twinFullname, String(r.status)); // move the only triage signal onto the real row
      statusMoved += 1;
    }

    if (
      row<{ exists: number }>(db, "SELECT 1 AS exists FROM reddit_unsave WHERE fullname=?", [
        phantom,
      ])
    ) {
      enqueueUnsave(db, twinFullname); // queue the REAL comment (valid id)
      requeued += 1;
    }

    run(db, "DELETE FROM reddit_unsave WHERE fullname=?", [phantom]);
    run(db, "DELETE FROM reddit_threads WHERE fullname=?", [phantom]);
    run(db, "DELETE FROM items WHERE fullname=?", [phantom]);
    removed += 1;
  }

  return { removed, status_moved: statusMoved, requeued };
}

/**
 * Preview local unsave queueing for still-saved reddit items carrying
 * *tag*.
 *
 * No network calls and no writes. The skip buckets are mutually
 * exclusive and ordered so the `eligible` count is exactly the number
 * a confirmed enqueue can add.
 */
export function previewUnsaveByTag(db: Database, tag: string): TagUnsavePreview {
  const clean = String(tag || "").trim();

  const summary: TagUnsavePreview = {
    tag: clean,
    matched: 0,
    eligible: 0,
    enqueued: 0,
    skipped: { non_reddit: 0, already_unsaved: 0, invalid_id: 0, already_queued: 0 },
    sample: [],
    fullnames: [],
    truncated: false,
  };

  if (!clean) return summary;

  const list = rows<{
    fullname: string;
    source: string;
    source_id: string;
    kind: string;
    title: string;
    is_saved: number;
    created_utc: number;
    saved_utc: number;
    first_seen_utc: number;
    subreddit: string | null;
    queued: string | null;
  }>(
    db,
    "SELECT i.fullname, i.source, i.source_id, i.kind, i.title, i.is_saved, " +
      "i.created_utc, i.saved_utc, i.first_seen_utc, " +
      "json_extract(i.metadata, '$.subreddit') AS subreddit, q.fullname AS queued " +
      "FROM items i " +
      "LEFT JOIN reddit_unsave q ON q.fullname = i.fullname " +
      "WHERE EXISTS (SELECT 1 FROM json_each(i.metadata, '$.tags') WHERE value = ?) " +
      "ORDER BY COALESCE(i.saved_utc, i.first_seen_utc, i.created_utc, 0) DESC, i.fullname ASC",
    [clean],
  );

  summary.matched = list.length;

  const fullnames: string[] = [];
  const sampleItems: TagUnsaveSample[] = [];
  const skipped = summary.skipped;

  for (const r of list) {
    if (r.source !== "reddit") {
      skipped.non_reddit += 1;
      continue;
    }

    if (Number(r.is_saved || 0) !== 1) {
      skipped.already_unsaved += 1;
      continue;
    }

    const sid = String(r.source_id || "");

    if (!sid.startsWith("t1_") && !sid.startsWith("t3_")) {
      skipped.invalid_id += 1;
      continue;
    }

    if (r.queued !== null) {
      skipped.already_queued += 1;
      continue;
    }

    fullnames.push(String(r.fullname));

    if (sampleItems.length < 20) {
      sampleItems.push({
        fullname: r.fullname,
        reddit_id: sid,
        title: String(r.title || "").slice(0, 120),
        subreddit: r.subreddit,
        kind: r.kind,
        created_utc: r.created_utc,
        saved_utc: r.saved_utc,
        first_seen_utc: r.first_seen_utc,
      });
    }
  }

  summary.eligible = fullnames.length;
  summary.sample = sampleItems;
  summary.fullnames = fullnames.slice(0, 200);
  summary.truncated = fullnames.length > 200;

  return summary;
}

/**
 * Queue every still-saved reddit item carrying *tag* for unsaving.
 *
 * Idempotent and local-only: existing ``reddit_unsave`` rows are left
 * untouched, and Reddit is contacted only by the separate drain
 * operation. Returns a preview/apply summary with ``enqueued`` set to
 * the number newly inserted.
 */
export function enqueueUnsaveByTag(
  db: Database,
  tag: string,
  opts: { dryRun?: boolean } = {},
): TagUnsaveResult {
  const dryRun = opts.dryRun ?? false;
  const summary = previewUnsaveByTag(db, tag);
  const result = { ...summary, dry_run: dryRun };

  if (dryRun || !summary.eligible) return result;

  const now = Math.floor(Date.now() / 1000);
  run(
    db,
    "INSERT INTO reddit_unsave(fullname, reddit_id, state, enqueued_utc) " +
      "SELECT i.fullname, i.source_id, 'pending', ? " +
      "FROM items i " +
      "WHERE i.source = 'reddit' " +
      "AND i.is_saved = 1 " +
      "AND EXISTS (SELECT 1 FROM json_each(i.metadata, '$.tags') WHERE value = ?) " +
      "AND (i.source_id LIKE 't3\\_%' ESCAPE '\\' OR i.source_id LIKE 't1\\_%' ESCAPE '\\') " +
      "AND NOT EXISTS (SELECT 1 FROM reddit_unsave q WHERE q.fullname = i.fullname) " +
      "ON CONFLICT(fullname) DO NOTHING",
    [now, summary.tag],
  );
  result.enqueued = scalar(db, "SELECT changes() AS c");

  return result;
}

/**
 * Flip ``is_saved`` to 0 for reddit items missing from a fresh saved-list
 * export.
 *
 * ``presentByKind`` maps ``"post"``/``"comment"`` -> the set of
 * ``source_id``s (``t3_``/``t1_`` ids) seen in the export. A DB item
 * still marked saved but absent from the export was un-saved on
 * reddit.com, so we clear ``is_saved`` locally (we do NOT enqueue an
 * unsave — it's already gone server-side).
 *
 * DELTA RECONCILE (the only safe design) — this NEVER touches a row
 * that wasn't itself previously confirmed in a saved-list snapshot.
 * ``is_saved=1`` in this DB is the ``new_item`` default for *every*
 * imported reddit row (bulk Karakeep/GDPR/JSON dumps), not "currently
 * saved on reddit", so a single export can't tell un-saved from
 * never-a-real-save. We therefore only consider rows carrying the
 * ``metadata.saved_seen_utc`` provenance marker (stamped by the
 * saveddit import / a saved-list sync). Consequence: the FIRST snapshot
 * just establishes the baseline (marks rows, un-saves nothing); later
 * snapshots detect genuine drop-outs among previously-seen items.
 * Bulk-imported rows are never reconciled.
 *
 * SAFETY — also Reddit's saved listing caps at ~``cap`` items PER TYPE
 * (links vs comments fetched separately). A type whose export count
 * reaches the cap may be *truncated*, so a missing item could be merely
 * beyond the cap; that type is SKIPPED. Zero-row types are skipped.
 *
 * ``truncatedByKind`` lets the SYNC/IMPORT layer — which actually knows
 * whether the listing was exhausted (walked ``after`` to the end / a
 * complete GDPR export) vs. stopped at a page cap — override the
 * row-count inference (B2). When a kind appears in it, its bool
 * governs: ``true`` skips that type (``skipped='source_truncated'``)
 * regardless of count; ``false`` reconciles even AT/above ``cap`` (so a
 * *complete* export of exactly ``cap`` items is no longer mistaken for
 * a truncated one). When ``null`` or a kind is absent, the legacy
 * ``len(present) >= cap`` inference is used — existing callers are
 * unchanged.
 *
 * Returns ``{kind: {present, capped, skipped, unsaved, fullnames}}``.
 * ``dryRun=true`` previews (computes the would-unsave set) without
 * writing. This is a non-additive, destructive write — back up the DB
 * first.
 */
export interface RedditReconcileKindResult {
  present: number;
  capped: boolean;
  skipped: string | null;
  unsaved: number;
  fullnames: string[];
}

export interface RedditReconcileResult {
  post: RedditReconcileKindResult;
  comment: RedditReconcileKindResult;
}

export function reconcileRedditSaves(
  db: Database,
  presentByKind: Record<"post" | "comment", Set<string>>,
  opts: {
    dryRun?: boolean;
    cap?: number;
    truncatedByKind?: Partial<Record<"post" | "comment", boolean>> | null;
  } = {},
): RedditReconcileResult {
  const dryRun = opts.dryRun ?? false;
  const cap = opts.cap ?? 1000;
  const truncatedByKind = opts.truncatedByKind ?? null;

  const summary: RedditReconcileResult = {
    post: { present: 0, capped: false, skipped: null, unsaved: 0, fullnames: [] },
    comment: { present: 0, capped: false, skipped: null, unsaved: 0, fullnames: [] },
  };

  for (const kind of ["post", "comment"] as const) {
    const present = presentByKind[kind];
    const capReached = present.size >= cap;
    const explicit = truncatedByKind?.[kind];
    const info = summary[kind];
    info.present = present.size;
    info.capped = capReached;

    if (!present.size) {
      info.capped = false;
      info.skipped = "no_export_rows";
    } else if (explicit === true) {
      info.skipped = "source_truncated";
    } else if (explicit === undefined && capReached) {
      info.skipped = "cap_reached";
    }

    if (info.skipped !== null) continue;

    const list = rows<{ fullname: string; source_id: string }>(
      db,
      "SELECT fullname, source_id FROM items " +
        "WHERE source='reddit' AND kind=? AND is_saved=1 " +
        "AND json_extract(metadata, '$.saved_seen_utc') IS NOT NULL",
      [kind],
    );

    const missing = list
      .filter((item) => !present.has(String(item.source_id)))
      .map((item) => String(item.fullname));

    info.unsaved = missing.length;
    info.fullnames = missing;

    if (missing.length && !dryRun) {
      for (const fullname of missing) {
        run(db, "UPDATE items SET is_saved=0 WHERE fullname=?", [fullname]);
      }
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Triage operations
// ---------------------------------------------------------------------------

// Any MANUAL status transition exits transient triage states (see
// decay/undecay and snooze/unsnooze): strip wave marks so
// "stamped == currently decayed/snoozed" holds. ``snooze_count``
// deliberately survives as cumulative history; a manual decision only
// clears the active deferral. One definition for every status writer —
// a future writer that forgets this breaks the invariant silently. No
// json_valid guard needed: the functional duration index makes SQLite
// validate metadata JSON on every write, so a malformed row can never
// exist here (pinned by test_malformed_metadata_cannot_enter_the_db).
const _STRIP_DECAY_SQL =
  "json_remove(metadata, '$.decayed_at', '$.decay_label', " +
  "'$.snoozed_until', '$.snoozed_wave')";

/** Reject a status outside the models-owned domain before any status write. */
function assertStatus(status: string): void {
  if (!VALID_STATUSES.some((validStatus) => validStatus === status)) {
    throw new Error(`invalid status: ${JSON.stringify(status)}`);
  }
}

/**
 * Set an item's triage status; record the previous one for undo.
 *
 * ``queueUnsave`` (default true) controls whether a transition to
 * ``done`` enqueues a Reddit unsave when the opt-in is on. The
 * reconcile path passes false: an item promoted to done *because it
 * was already unsaved on Reddit* must not trigger a redundant no-op
 * unsave write (mirrors `reconcileRedditSaves` — it's already gone
 * server-side).
 */
export function setStatus(
  db: Database,
  fullname: string,
  status: string,
  opts: { queueUnsave?: boolean } = {},
): Item | null {
  const queueUnsave = opts.queueUnsave ?? true;

  assertStatus(status);

  const r = row<{ status: string }>(db, "SELECT status FROM items WHERE fullname=?", [fullname]);

  if (!r) return null;
  const old = String(r.status);

  if (status === old) {
    return publicByFullname(db, fullname); // idempotent; don't clobber status_prev
  }

  const now = Math.floor(Date.now() / 1000);
  const processed = status === "inbox" ? null : now;

  return withTransaction(db, () => {
    run(
      db,
      `UPDATE items SET status=?, status_prev=?, processed_utc=?, ` +
        `metadata=${_STRIP_DECAY_SQL} WHERE fullname=?`,
      [status, old, processed, fullname],
    );

    if (status === "done" && queueUnsave && unsaveEnabled(db)) {
      try {
        // best-effort, local-only — an enqueue hiccup must never fail the status write
        enqueueUnsave(db, fullname);
      } catch {
        // best-effort
      }
    }

    return publicByFullname(db, fullname);
  });
}

/** Revert the most recent status change (single step). */
export function undoStatus(db: Database, fullname: string): Item | null {
  const r = row<{ status_prev: string | null; status: string }>(
    db,
    "SELECT status_prev, status FROM items WHERE fullname=?",
    [fullname],
  );

  if (!r || r.status_prev === null) {
    return publicByFullname(db, fullname);
  }

  const prev = String(r.status_prev);
  const now = Math.floor(Date.now() / 1000);
  const processed = prev === "inbox" ? null : now;

  return withTransaction(db, () => {
    run(
      db,
      `UPDATE items SET status=?, status_prev=NULL, processed_utc=?, ` +
        `metadata=${_STRIP_DECAY_SQL} WHERE fullname=?`,
      [prev, processed, fullname],
    );

    if (r.status === "done") {
      // a Done undone before the drain ran is never sent to Reddit
      dequeueUnsave(db, fullname);
      // NOTE: if the unsave already drained (queue state 'done'), the
      // item is genuinely gone from Reddit Saved — this layer stays
      // offline; the web /undo route attempts the live re-save
      // (reddit_unsave.resave) and surfaces a warning when it fails.
    }

    return publicByFullname(db, fullname);
  });
}

/** Apply a status to many items; returns the number updated. */
export function bulkSetStatus(db: Database, fullnames: string[], status: string): number {
  assertStatus(status);

  const now = Math.floor(Date.now() / 1000);
  const processed = status === "inbox" ? null : now;
  const enqueue = status === "done" && unsaveEnabled(db);
  const changed: string[] = [];
  let count = 0;

  return withTransaction(db, () => {
    for (const fn of fullnames) {
      // `AND status<>?` skips no-op updates so status_prev (single-step
      // undo) is never clobbered by re-applying the same status.
      const n = run(
        db,
        `UPDATE items SET status_prev=status, status=?, processed_utc=?, ` +
          `metadata=${_STRIP_DECAY_SQL} WHERE fullname=? AND status<>?`,
        [status, processed, fn, status],
      );

      count += n;

      if (enqueue && n) changed.push(fn);
    }

    for (const fn of changed) {
      // enqueueUnsave no-ops for non-reddit; best-effort, local-only
      try {
        enqueueUnsave(db, fn);
      } catch {
        // best-effort
      }
    }

    return count;
  });
}

function dedupeFullnames(fullnames: string[] | null | undefined): string[] {
  const trimmed = (fullnames ?? []).map((fn) => String(fn || "").trim());

  return [...new Set(trimmed.filter(Boolean))];
}

function sampleItems(list: Array<{ fullname: string; title: string }>, samples = 5): string[] {
  return list
    .slice(0, samples)
    .map((r) => `${String(r.fullname)}: ${String(r.title || "").slice(0, 60)}`);
}

function inboxRowsForFullnames(db: Database, fullnames: string[]): RawItem[] {
  const fns = dedupeFullnames(fullnames);

  if (!fns.length) throw new Error("fullnames must not be empty");
  const placeholders = fns.map(() => "?").join(",");
  const byFullname = new Map<string, RawItem>();

  for (const r of rows<RawItem>(
    db,
    `SELECT * FROM items WHERE fullname IN (${placeholders})`,
    fns,
  )) {
    const item = rowToRaw(r);
    byFullname.set(item.fullname, item);
  }

  const found: RawItem[] = [];
  const missing: string[] = [];
  const nonInbox: string[] = [];

  for (const fullname of fns) {
    const item = byFullname.get(fullname);

    if (!item) {
      missing.push(fullname);
    } else if (item.status !== "inbox") {
      nonInbox.push(fullname);
    } else {
      found.push(item);
    }
  }

  if (missing.length) {
    throw new Error(`unknown item(s): ${missing.slice(0, 5).join(", ")}`);
  }

  if (nonInbox.length) {
    throw new Error(`can only snooze inbox item(s): ${nonInbox.slice(0, 5).join(", ")}`);
  }

  return found;
}

/**
 * Stamp inbox items as snoozed without changing status.
 *
 * ``metadata.snoozed_until`` hides the item from triage batches until
 * that UTC, and ``metadata.snoozed_wave`` makes one snooze wave
 * reversible via `unsnooze`. ``metadata.snooze_count`` is cumulative:
 * unsnooze and manual decisions do not decrement it. When a snooze
 * would make the count reach ``escalateAfter``, the item silently
 * follows the decay path instead (archived with
 * ``decay_label='snooze-escalated'``), still by direct UPDATE and
 * never via `bulkSetStatus`.
 */
export function snooze(
  db: Database,
  opts: {
    fullnames: string[];
    untilUtc: number;
    windowDays?: number;
    escalateAfter?: number;
    apply?: boolean;
    samples?: number;
  },
): SnoozeResult {
  const windowDays = opts.windowDays ?? 7;
  const escalateAfter = opts.escalateAfter ?? 3;
  const apply = opts.apply ?? false;
  const samples = opts.samples ?? 5;

  if (escalateAfter < 1) {
    throw new Error("escalate_after must be >= 1");
  }

  const list = inboxRowsForFullnames(db, opts.fullnames);
  const toSnooze: string[] = [];
  const escalated: string[] = [];

  for (const r of list) {
    const md = parseMetadata(r.metadata);
    const count = Number(md.snooze_count || 0) + 1;

    if (count >= escalateAfter) escalated.push(String(r.fullname));
    else toSnooze.push(String(r.fullname));
  }

  const res: SnoozeResult = {
    total: list.length,
    applied: false,
    until_utc: Number(opts.untilUtc),
    window_days: windowDays,
    snoozed_wave: null,
    decayed_at: null,
    escalated,
    snoozed: toSnooze,
    sample: sampleItems(list, samples),
  };

  if (!apply) return res;

  withTransaction(db, () => {
    res.applied = true;
    const now = Math.floor(Date.now() / 1000);
    let appliedTotal = 0;

    // SAFETY: no search_text rewrite — snoozed_until, snooze_count and
    // snoozed_wave are absent from models._META_SEARCH_KEYS.
    if (toSnooze.length) {
      const wave = allocateSnoozeWave(db, now);
      const placeholders = toSnooze.map(() => "?").join(",");

      const count = run(
        db,
        "UPDATE items SET metadata=json_set(" +
          "metadata, '$.snoozed_until', ?, " +
          "'$.snooze_count', CAST(COALESCE(json_extract(metadata, '$.snooze_count'), 0) AS INTEGER) + 1, " +
          "'$.snoozed_wave', ?) " +
          `WHERE status='inbox' AND fullname IN (${placeholders})`,
        [Number(opts.untilUtc), wave, ...toSnooze],
      );

      appliedTotal += count;
      res.snoozed_wave = wave;
    }

    if (escalated.length) {
      const wave = allocateDecayWave(db, now);
      const placeholders = escalated.map(() => "?").join(",");

      const count = run(
        db,
        "UPDATE items SET status='archived', status_prev='inbox', processed_utc=?, " +
          "metadata=json_set(" +
          "json_remove(metadata, '$.snoozed_until', '$.snoozed_wave'), " +
          "'$.snooze_count', CAST(COALESCE(json_extract(metadata, '$.snooze_count'), 0) AS INTEGER) + 1, " +
          "'$.decayed_at', ?, '$.decay_label', ?) " +
          `WHERE status='inbox' AND fullname IN (${placeholders})`,
        [now, wave, "snooze-escalated", ...escalated],
      );

      appliedTotal += count;
      res.decayed_at = wave;
    }

    res.total = appliedTotal;
  });

  return res;
}

/**
 * Clear active snooze marks for one wave or explicit inbox items.
 *
 * ``snooze_count`` is intentionally not decremented; it is a
 * cumulative signal used for repeat-snooze escalation. This function
 * never changes status and never touches the Reddit unsave queue.
 */
export function unsnooze(
  db: Database,
  opts: {
    snoozedWave?: number | null;
    fullnames?: string[] | null;
    apply?: boolean;
    samples?: number;
  } = {},
): UnsnoozeResult {
  const snoozedWave = opts.snoozedWave ?? null;
  const fns = dedupeFullnames(opts.fullnames);
  const samples = opts.samples ?? 5;

  if ((snoozedWave === null && !fns.length) || (snoozedWave !== null && fns.length)) {
    throw new Error("select either snoozed_wave or fullnames");
  }

  const clauses = ["status='inbox'", "json_extract(metadata, '$.snoozed_until') IS NOT NULL"];

  const params: SQLQueryBindings[] = [];

  if (snoozedWave !== null) {
    clauses.push("json_extract(metadata, '$.snoozed_wave') = ?");
    params.push(Number(snoozedWave));
  } else {
    const ph = fns.map(() => "?").join(",");
    clauses.push(`fullname IN (${ph})`);
    params.push(...fns);
  }

  const where = clauses.join(" AND ");

  const list = rows<{ fullname: string; title: string }>(
    db,
    `SELECT fullname, title FROM items WHERE ${where} ORDER BY fullname LIMIT ?`,
    [...params, samples],
  );

  const total = scalar(db, `SELECT COUNT(*) AS c FROM items WHERE ${where}`, params);

  const res: UnsnoozeResult = {
    total,
    applied: false,
    snoozed_wave: snoozedWave,
    sample: sampleItems(list, samples),
  };

  // SAFETY: no search_text rewrite — none of the keys this touches
  // (snoozed_until, snoozed_wave) appear in models._META_SEARCH_KEYS, so
  // buildSearchText is unchanged. Matches the Python oracle's UPDATE.
  if (opts.apply) {
    res.applied = true;

    if (total) {
      const n = run(
        db,
        `UPDATE items SET metadata=json_remove(metadata, '$.snoozed_until', '$.snoozed_wave') ` +
          `WHERE ${where}`,
        params,
      );

      res.total = n;
    }
  }

  return res;
}

// Item age: content creation time when known, else when we first synced
// it. (Reddit/YouTube expose no save timestamps, so this is a content-age
// proxy — see the decay docstring.)
const _AGE_EXPR = "(CASE WHEN created_utc > 0 THEN created_utc ELSE first_seen_utc END)";

/**
 * Reversibly bulk-archive inbox items older than ``beforeUtc``.
 *
 * Age uses ``created_utc`` when known, else ``first_seen_utc``.
 * Returns the count affected (or that *would* be affected when
 * ``dryRun``).
 */
export function bankruptcy(
  db: Database,
  beforeUtc: number,
  opts: { source?: string | null; dryRun?: boolean } = {},
): number {
  let where = `status='inbox' AND ${_AGE_EXPR} < ?`;
  const params: SQLQueryBindings[] = [Number(beforeUtc)];

  if (opts.source) {
    where += " AND source = ?";
    params.push(opts.source);
  }

  const n = scalar(db, `SELECT COUNT(*) AS c FROM items WHERE ${where}`, params);

  if (opts.dryRun || n === 0) return n;
  const now = Math.floor(Date.now() / 1000);
  run(
    db,
    `UPDATE items SET status='archived', status_prev='inbox', processed_utc=? ` + `WHERE ${where}`,
    [now, ...params],
  );

  return n;
}

function decayWhere(
  tags: string[] | null,
  subreddits: string[] | null,
  beforeUtc: number | null,
  source: string,
): [string, SQLQueryBindings[]] {
  /**
   * WHERE clause + params for a decay selection: tag/subreddit
   * selectors UNION, age cutoff and source AND. Tag SQL mirrors
   * searchItems' json_each filter.
   */
  const clauses = ["status='inbox'", "source=?"];
  const params: SQLQueryBindings[] = [source];
  const sel: string[] = [];

  if (tags?.length) {
    const ph = tags.map(() => "?").join(",");
    sel.push(`EXISTS (SELECT 1 FROM json_each(metadata, '$.tags') WHERE value IN (${ph}))`);
    params.push(...tags);
  }

  if (subreddits?.length) {
    const ph = subreddits.map(() => "?").join(",");
    sel.push(`lower(json_extract(metadata, '$.subreddit')) IN (${ph})`);
    params.push(...subreddits.map((s) => s.toLowerCase()));
  }

  if (sel.length) {
    clauses.push(`(${sel.join(" OR ")})`);
  }

  if (beforeUtc !== null && beforeUtc !== undefined) {
    clauses.push(`${_AGE_EXPR} < ?`);
    params.push(Number(beforeUtc));
  }

  return [clauses.join(" AND "), params];
}

export interface DecayOpts {
  tags?: string[] | null;
  subreddits?: string[] | null;
  beforeUtc?: number | null;
  source?: string;
  label?: string | null;
  apply?: boolean;
  now?: number;
  topSubs?: number;
  samples?: number;
}

/**
 * Random `r/<sub>: title` preview of the rows a bulk triage
 * operation selected — the dry-run sample `decay`, `undecay` and
 * `deleteItems` all show before anything is applied.
 */
function randomSubredditSamples(
  db: Database,
  where: string,
  params: SQLQueryBindings[],
  samples: number,
): string[] {
  const list = rows<{ subreddit: string | null; title: string }>(
    db,
    `SELECT json_extract(metadata, '$.subreddit') AS subreddit, title FROM items ` +
      `WHERE ${where} ORDER BY RANDOM() LIMIT ?`,
    [...params, samples],
  );

  return list.map((r) => `r/${r.subreddit ?? "?"}: ${r.title.slice(0, 60)}`);
}

/**
 * Guilt-free bulk decay: archive inbox items by tag/subreddit/age,
 * stamped for reversal.
 *
 * The tag-aware successor to `bankruptcy` (PKMS-research adoption,
 * Epic 21): selects ``status='inbox'`` items of ``source`` matching
 * ANY of ``tags``/``subreddits`` (union), optionally older than
 * ``beforeUtc`` (content age — Reddit exposes no save timestamps),
 * and archives them stamping ``metadata.decayed_at``. The stamp is a
 * UNIQUE monotonic wave id (`allocateDecayWave`), not bare ``now`` —
 * so two decays in the same wall-clock second still get distinct
 * stamps and each is one independently reversible "wave" (see
 * `undecay`); it stays ~wall-clock for ``is:decayed``/``swept_recent``.
 * Refuses an unselected decay.
 * ``label`` additionally writes ``metadata.decay_label`` — e.g. the
 * supervised initial backfill uses ``label='swept'`` so its items stay
 * distinguishable from any future rolling decay (queryable via the
 * ``is:swept`` search operator; ``is:decayed`` matches any wave). A
 * label is a marker, NOT a tag: tags get wholesale-replaced by
 * categorize retags, while metadata keys survive both retags and syncs.
 *
 * Deliberately a direct UPDATE like `bankruptcy` — never routed
 * through `bulkSetStatus` — so a mass decay can never enqueue live
 * Reddit unsaves. Dry-run (default) and apply return the same shape;
 * breakdowns are computed before the UPDATE. ``by_tag`` counts
 * membership per selected tag and overlaps by design (an anime+memes
 * item counts under both) — ``total`` is the authoritative distinct-row
 * count, never ``sum(by_tag)``.
 */
export function decay(db: Database, opts: DecayOpts = {}): DecayResult {
  const tags = opts.tags ?? null;
  const subreddits = opts.subreddits ?? null;
  const beforeUtc = opts.beforeUtc ?? null;
  const source = opts.source ?? "reddit";
  const label = opts.label ?? null;
  const apply = opts.apply ?? false;
  const samples = opts.samples ?? 5;
  const topSubs = opts.topSubs ?? 50;

  if (!tags?.length && !subreddits?.length && beforeUtc === null && beforeUtc === undefined) {
    throw new Error("decay needs at least one selector (tags/subreddits/before_utc)");
  }

  const [where, params] = decayWhere(tags, subreddits, beforeUtc ?? null, source);
  const total = scalar(db, `SELECT COUNT(*) AS c FROM items WHERE ${where}`, params);

  const byTag: Record<string, number> = {};

  for (const t of tags ?? []) {
    const n = scalar(
      db,
      `SELECT COUNT(*) AS c FROM items WHERE ${where} AND EXISTS ` +
        "(SELECT 1 FROM json_each(metadata, '$.tags') WHERE value = ?)",
      [...params, t],
    );

    if (n) byTag[t] = n;
  }

  const bySubreddit: Record<string, number> = {};

  for (const r of rows<{ s: string | null; c: number }>(
    db,
    `SELECT COALESCE(lower(json_extract(metadata, '$.subreddit')), '(none)') s, ` +
      `COUNT(*) AS c FROM items WHERE ${where} GROUP BY s ORDER BY c DESC LIMIT ?`,
    [...params, topSubs],
  )) {
    bySubreddit[String(r.s)] = Number(r.c);
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const yr = 365 * 24 * 3600;

  const b = row<{ b0: number | null; b1: number | null; b2: number | null; b3: number | null }>(
    db,
    `SELECT SUM(CASE WHEN ${_AGE_EXPR} >= ? THEN 1 ELSE 0 END) AS b0, ` +
      `SUM(CASE WHEN ${_AGE_EXPR} < ? AND ${_AGE_EXPR} >= ? THEN 1 ELSE 0 END) AS b1, ` +
      `SUM(CASE WHEN ${_AGE_EXPR} < ? AND ${_AGE_EXPR} >= ? THEN 1 ELSE 0 END) AS b2, ` +
      `SUM(CASE WHEN ${_AGE_EXPR} < ? THEN 1 ELSE 0 END) AS b3 FROM items WHERE ${where}`,
    [now - yr, now - yr, now - 2 * yr, now - 2 * yr, now - 4 * yr, now - 4 * yr, ...params],
  );

  const ageBands = {
    "<1y": Number(b?.b0 || 0),
    "1-2y": Number(b?.b1 || 0),
    "2-4y": Number(b?.b2 || 0),
    ">=4y": Number(b?.b3 || 0),
  };

  const sample = randomSubredditSamples(db, where, params, samples);

  const res: DecayResult = {
    total,
    applied: false,
    decayed_at: null,
    label,
    by_tag: byTag,
    by_subreddit: bySubreddit,
    age_bands: ageBands,
    sample,
  };

  if (apply) {
    withTransaction(db, () => {
      res.applied = true;

      if (!total) return;
      const wave = allocateDecayWave(db, now);
      let setMd = "json_set(metadata, '$.decayed_at', ?)";
      let mdParams: SQLQueryBindings[] = [wave];

      if (label) {
        setMd = "json_set(metadata, '$.decayed_at', ?, '$.decay_label', ?)";
        mdParams = [wave, label];
      }

      run(
        db,
        `UPDATE items SET status='archived', status_prev='inbox', processed_utc=?, ` +
          `metadata=${setMd} WHERE ${where}`,
        [now, ...mdParams, ...params],
      );
      res.decayed_at = wave;
    });
  }

  return res;
}

/**
 * Decay explicit inbox items by fullname, using the same reversible
 * stamp shape.
 *
 * This is the exact-selection hook for repeat-snooze escalation. It
 * deliberately uses a direct UPDATE like `decay` and never routes
 * through `bulkSetStatus`, so it cannot enqueue Reddit unsaves.
 */
export function decayFullnames(
  db: Database,
  opts: {
    fullnames: string[];
    label?: string | null;
    apply?: boolean;
    samples?: number;
  },
): DecayFullnamesResult {
  const label = opts.label ?? null;
  const apply = opts.apply ?? false;
  const samples = opts.samples ?? 5;
  const fns = dedupeFullnames(opts.fullnames);

  if (!fns.length) throw new Error("fullnames must not be empty");
  const ph = fns.map(() => "?").join(",");
  const where = `status='inbox' AND fullname IN (${ph})`;

  const list = rows<{ fullname: string; title: string }>(
    db,
    `SELECT fullname, title FROM items WHERE ${where} ORDER BY fullname LIMIT ?`,
    [...fns, samples],
  );

  const total = scalar(db, `SELECT COUNT(*) AS c FROM items WHERE ${where}`, fns);

  const res: DecayFullnamesResult = {
    total,
    applied: false,
    decayed_at: null,
    label,
    sample: sampleItems(list, samples),
  };

  if (apply) {
    withTransaction(db, () => {
      res.applied = true;

      if (!total) return;
      const now = Math.floor(Date.now() / 1000);
      const wave = allocateDecayWave(db, now);

      let setMd =
        "json_set(json_remove(metadata, '$.snoozed_until', '$.snoozed_wave'), " +
        "'$.decayed_at', ?)";

      let mdParams: SQLQueryBindings[] = [wave];

      if (label) {
        setMd =
          "json_set(json_remove(metadata, '$.snoozed_until', '$.snoozed_wave'), " +
          "'$.decayed_at', ?, '$.decay_label', ?)";
        mdParams = [wave, label];
      }

      const count = run(
        db,
        `UPDATE items SET status='archived', status_prev='inbox', processed_utc=?, ` +
          `metadata=${setMd} WHERE ${where}`,
        [now, ...mdParams, ...fns],
      );

      res.total = count;
      res.decayed_at = wave;
    });
  }

  return res;
}

/**
 * Reverse `decay`: return stamped-archived items to the inbox.
 *
 * Selects by the ``metadata.decayed_at`` stamp (the wave id) — NOT
 * ``status_prev``, which is single-step and may have been clobbered
 * since. Items manually re-statused after a decay (e.g. to keep) are
 * skipped by the ``status='archived'`` guard; their stale stamp is
 * harmless (undecay never touches non-archived rows, and a later
 * decay re-stamps). The stamp AND the decay label are REMOVED on
 * restore so the invariant "stamped == currently decayed" holds;
 * ``processed_utc`` returns to NULL (inbox semantics, as setStatus).
 */
export function undecay(
  db: Database,
  opts: {
    decayedAfter?: number | null;
    decayedBefore?: number | null;
    apply?: boolean;
    samples?: number;
  } = {},
): UndecayResult {
  const samples = opts.samples ?? 5;

  const clauses = ["status='archived'", "json_extract(metadata, '$.decayed_at') IS NOT NULL"];

  const params: SQLQueryBindings[] = [];

  if (opts.decayedAfter !== undefined && opts.decayedAfter !== null) {
    clauses.push("json_extract(metadata, '$.decayed_at') >= ?");
    params.push(Number(opts.decayedAfter));
  }

  if (opts.decayedBefore !== undefined && opts.decayedBefore !== null) {
    clauses.push("json_extract(metadata, '$.decayed_at') < ?");
    params.push(Number(opts.decayedBefore));
  }

  const where = clauses.join(" AND ");
  const total = scalar(db, `SELECT COUNT(*) AS c FROM items WHERE ${where}`, params);

  const sample = randomSubredditSamples(db, where, params, samples);

  const res: UndecayResult = { total, applied: false, sample };

  if (opts.apply) {
    res.applied = true;

    if (total) {
      const n = run(
        db,
        `UPDATE items SET status='inbox', status_prev='archived', processed_utc=NULL, ` +
          `metadata=json_remove(metadata, '$.decayed_at', '$.decay_label') WHERE ${where}`,
        params,
      );

      res.total = n;
    }
  }

  return res;
}

export interface DeleteItemsOpts {
  tags?: string[] | null;
  subreddits?: string[] | null;
  beforeUtc?: number | null;
  source?: string;
  status?: string | null;
  swept?: boolean;
  decayed?: boolean;
  fullnames?: string[] | null;
  alsoUnsave?: boolean;
  apply?: boolean;
  samples?: number;
  maxRows?: number;
}

/**
 * Chunked hard-delete of selected `victims` and their dependent rows:
 * cached `reddit_threads` first, then the pending `reddit_unsave`
 * queue (skipped when `clearPendingUnsave` is false because the caller
 * just queued real unsaves for these items), then the item itself.
 * 500 fullnames per statement keeps the binding count well under
 * SQLite's variable limit. Caller owns the transaction; returns the
 * number of `reddit_threads` rows removed.
 */
function deleteVictims(db: Database, victims: string[], clearPendingUnsave: boolean): number {
  let threads = 0;

  for (let i = 0; i < victims.length; i += 500) {
    const chunk = victims.slice(i, i + 500);
    const placeholders = chunk.map(() => "?").join(",");
    threads += run(db, `DELETE FROM reddit_threads WHERE fullname IN (${placeholders})`, chunk);

    if (clearPendingUnsave) {
      run(
        db,
        `DELETE FROM reddit_unsave WHERE fullname IN (${placeholders}) AND state='pending'`,
        chunk,
      );
    }

    run(db, `DELETE FROM items WHERE fullname IN (${placeholders})`, chunk);
  }

  return threads;
}

/**
 * PERMANENTLY delete matching items (and their cached reddit_threads
 * rows).
 *
 * The destructive endpoint of the triage-then-delete flow (Epic 21):
 * e.g. after the swept/ephemeral pass is triaged, ``swept=true,
 * tags=['ephemeral']`` removes the rest for good. Unlike decay this is
 * IRREVERSIBLE at the DB layer — the CLI wraps it in a dry-run-default
 * + double-confirmation + auto-backup + audit-log gate; this function
 * additionally refuses to apply above ``maxRows`` (blast-radius cap).
 *
 * Selector semantics: ``tags``/``subreddits`` union with each other and
 * AND with every other selector (status/swept/decayed/age/fullnames).
 * At least one selector is required — a bare source-wide delete is
 * refused.
 *
 * ``alsoUnsave=true`` enqueues each deleted reddit item into the
 * existing ``reddit_unsave`` queue BEFORE the row vanishes (the queue
 * stores reddit_id, so draining works without the item). Without it,
 * PENDING queue rows for deleted items are removed so a later drain
 * can't unsave something the user only deleted locally; drained
 * history rows are kept as audit.
 */
export function deleteItems(db: Database, opts: DeleteItemsOpts = {}): DeleteItemsResult {
  const tags = opts.tags ?? null;
  const subreddits = opts.subreddits ?? null;
  const beforeUtc = opts.beforeUtc ?? null;
  const source = opts.source ?? "reddit";
  const status = opts.status ?? null;
  const swept = opts.swept ?? false;
  const decayed = opts.decayed ?? false;
  const fullnames = opts.fullnames ?? null;
  const alsoUnsave = opts.alsoUnsave ?? false;
  const apply = opts.apply ?? false;
  const samples = opts.samples ?? 8;
  const maxRows = opts.maxRows ?? 5000;

  if (
    !tags?.length &&
    !subreddits?.length &&
    beforeUtc === null &&
    beforeUtc === undefined &&
    !fullnames?.length &&
    !swept &&
    !decayed &&
    !status
  ) {
    throw new Error("delete_items needs at least one selector");
  }

  const clauses = ["source=?"];
  const params: SQLQueryBindings[] = [source];

  if (fullnames?.length) {
    const ph = fullnames.map(() => "?").join(",");
    clauses.push(`fullname IN (${ph})`);
    params.push(...fullnames);
  }

  if (status) {
    clauses.push("status=?");
    params.push(status);
  }

  if (swept) {
    clauses.push("json_extract(metadata, '$.decay_label') = 'swept'");
  }

  if (decayed) {
    clauses.push("json_extract(metadata, '$.decayed_at') IS NOT NULL");
  }

  const sel: string[] = [];

  if (tags?.length) {
    const ph = tags.map(() => "?").join(",");
    sel.push(`EXISTS (SELECT 1 FROM json_each(metadata, '$.tags') WHERE value IN (${ph}))`);
    params.push(...tags);
  }

  if (subreddits?.length) {
    const ph = subreddits.map(() => "?").join(",");
    sel.push(`lower(json_extract(metadata, '$.subreddit')) IN (${ph})`);
    params.push(...subreddits.map((s) => s.toLowerCase()));
  }

  if (sel.length) {
    clauses.push(`(${sel.join(" OR ")})`);
  }

  if (beforeUtc !== null && beforeUtc !== undefined) {
    clauses.push(`${_AGE_EXPR} < ?`);
    params.push(Number(beforeUtc));
  }

  const where = clauses.join(" AND ");

  const victims = rows<{ fullname: string }>(
    db,
    `SELECT fullname FROM items WHERE ${where}`,
    params,
  ).map((r) => String(r.fullname));

  const total = victims.length;

  const sample = randomSubredditSamples(db, where, params, samples);

  const res: DeleteItemsResult = {
    total,
    applied: false,
    threads_deleted: 0,
    unsave_enqueued: 0,
    sample,
  };

  if (!apply) return res;

  if (total > maxRows) {
    throw new Error(
      `refusing to delete ${total} rows (> max_rows=${maxRows}); ` +
        "raise max_rows deliberately if this is intended",
    );
  }

  res.applied = true;

  if (!total) return res;

  const writes = withTransaction(db, () => {
    let enqueued = 0;

    if (alsoUnsave) {
      const beforeQ = scalar(db, "SELECT COUNT(*) AS c FROM reddit_unsave");

      for (const fullname of victims) {
        enqueueUnsave(db, fullname);
      }

      enqueued = scalar(db, "SELECT COUNT(*) AS c FROM reddit_unsave") - beforeQ;
    }

    return { enqueued, threads: deleteVictims(db, victims, !alsoUnsave) };
  });

  res.threads_deleted = writes.threads;
  res.unsave_enqueued = writes.enqueued;

  return res;
}

/**
 * Permanently purge ``status='done'`` items older than a retention
 * window (Gmail-trash; F15).
 *
 * Items left Done longer than ``done_retention_days`` (setting, default
 * 30) are permanently deleted. Age is measured from ``processed_utc``
 * (when the item entered Done — there is no separate done_at column):
 * an item qualifies when ``processed_utc < now - retention*86400``.
 * ``processed_utc IS NULL`` rows are excluded so an undated Done item is
 * never purged.
 *
 * Like `decay` and `deleteItems`, this is a DIRECT delete — never
 * routed through `bulkSetStatus`/`enqueueUnsave` — so a retention purge
 * MUST NOT enqueue a Reddit unsave. Only ``status='done'`` rows are ever
 * selected; inbox/keep/archived are untouched. Pending ``reddit_unsave``
 * rows for purged items are removed (a local purge should not let a
 * later drain unsave something the user only deleted locally); drained
 * history rows are kept as audit. ``apply=true`` refuses to delete more
 * than ``maxRows`` (blast-radius cap, mirrors `deleteItems` — guards a
 * misconfigured 0-day retention). Dry-run (default) changes nothing.
 * Returns ``{total, applied, retention_days, cutoff, threads_deleted, sample}``.
 */
export interface PurgeDoneResult {
  total: number;
  applied: boolean;
  retention_days: number;
  cutoff: number;
  threads_deleted: number;
  sample: string[];
}

export function purgeDone(
  db: Database,
  opts: { now?: number | null; apply?: boolean; maxRows?: number } = {},
): PurgeDoneResult {
  const apply = opts.apply ?? false;
  const maxRows = opts.maxRows ?? 5000;

  const now = Math.floor(
    opts.now !== undefined && opts.now !== null ? opts.now : Date.now() / 1000,
  );

  const retentionDays = Number(getSetting(db, "done_retention_days", "30") || 30);

  const cutoff = now - retentionDays * 86400;
  const where = "status='done' AND processed_utc IS NOT NULL AND processed_utc < ?";
  const params: SQLQueryBindings[] = [cutoff];

  const total = scalar(db, `SELECT COUNT(*) AS c FROM items WHERE ${where}`, params);

  const sampleList = rows<{ source: string; title: string }>(
    db,
    `SELECT source, title FROM items WHERE ${where} ORDER BY processed_utc LIMIT 5`,
    params,
  );

  const sample = sampleList.map(
    (r) => `${String(r.source)}: ${String(r.title || "").slice(0, 60)}`,
  );

  const res: PurgeDoneResult = {
    total,
    applied: false,
    retention_days: retentionDays,
    cutoff,
    threads_deleted: 0,
    sample,
  };

  if (!apply) return res;

  if (total > maxRows) {
    throw new Error(
      `refusing to purge ${total} done rows (> max_rows=${maxRows}); ` +
        "raise max_rows deliberately if this is intended",
    );
  }

  if (!total) return { ...res, applied: true };

  const victims = rows<{ fullname: string }>(
    db,
    `SELECT fullname FROM items WHERE ${where}`,
    params,
  ).map((r) => String(r.fullname));

  const threadsDeleted = withTransaction(db, () => deleteVictims(db, victims, true));

  return { ...res, applied: true, threads_deleted: threadsDeleted };
}
// ---------------------------------------------------------------------------
// Reddit thread cache (post + comment tree; kept out of
// items.metadata so search stays cheap — the JSON blobs are
// large). See AGENTS.md "Reddit management view".
// ---------------------------------------------------------------------------

/** Return the cached thread JSON and hydration time, or null when absent. */
export function getRedditThread(
  db: Database,
  fullname: string,
): { thread_json: string; hydrated_at: number | null } | null {
  const r = row<{ thread_json: string | Uint8Array; hydrated_at: number | null }>(
    db,
    "SELECT thread_json, hydrated_at FROM reddit_threads WHERE fullname=?",
    [fullname],
  );

  if (!r) return null;
  let threadJson = r.thread_json;

  if (threadJson instanceof Uint8Array) {
    const bytes =
      threadJson.buffer instanceof ArrayBuffer
        ? new Uint8Array(threadJson.buffer, threadJson.byteOffset, threadJson.byteLength)
        : new Uint8Array(threadJson);

    threadJson = new TextDecoder().decode(Bun.gunzipSync(bytes));
  }

  return { thread_json: threadJson, hydrated_at: r.hydrated_at };
}

/** Cache (or replace) a thread JSON blob for an item. Idempotent. */
export function setRedditThread(
  db: Database,
  fullname: string,
  threadJson: string,
  hydratedAt?: number | null,
): void {
  const compressed = Bun.gzipSync(threadJson);

  const threadBlob =
    compressed.buffer instanceof ArrayBuffer
      ? new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength)
      : new Uint8Array(compressed);

  run(
    db,
    "INSERT INTO reddit_threads(fullname, thread_json, hydrated_at) VALUES(?, ?, ?) " +
      "ON CONFLICT(fullname) DO UPDATE SET " +
      "thread_json=excluded.thread_json, hydrated_at=excluded.hydrated_at",
    [
      fullname,
      threadBlob,
      hydratedAt !== undefined && hydratedAt !== null
        ? Number(hydratedAt)
        : Math.floor(Date.now() / 1000),
    ],
  );
}

/** Per-subreddit item counts for reddit items (descending), for the sidebar. */
export function redditSubredditCounts(
  db: Database,
  status?: string | null,
): Array<{ subreddit: string; count: number }> {
  const sub = "json_extract(metadata, '$.subreddit')";
  let where = `source='reddit' AND ${sub} IS NOT NULL AND ${sub} <> ''`;
  const params: SQLQueryBindings[] = [];

  if (status) {
    where += " AND status = ?";
    params.push(status);
  }

  return rows<{ subreddit: string; c: number }>(
    db,
    `SELECT ${sub} AS subreddit, COUNT(*) AS c FROM items WHERE ${where} ` +
      `GROUP BY ${sub} COLLATE NOCASE ORDER BY c DESC, subreddit COLLATE NOCASE ASC`,
    params,
  ).map((r) => ({ subreddit: String(r.subreddit), count: Number(r.c) }));
}

/**
 * Tiny ambient counts for the v3 console (Epic 20: win
 * pebbles, the "· N new" tab slice, the quiet decay line).
 * Deliberately guilt-free: arrivals and clears today, never
 * backlog totals. ``cleared_today`` counts manual triage only
 * — decay-stamped rows are excluded so a bulk decay can never
 * masquerade as a day's worth of cleared items.
 */
export function pulse(db: Database, opts: { now?: number | null } = {}): PulseCounts {
  const now = Math.floor(
    opts.now !== undefined && opts.now !== null ? opts.now : Date.now() / 1000,
  );

  const d = new Date(now * 1000);

  const midnight = Math.floor(
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000,
  );

  const newToday = scalar(db, "SELECT COUNT(*) AS c FROM items WHERE first_seen_utc >= ?", [
    midnight,
  ]);

  const clearedToday = scalar(
    db,
    "SELECT COUNT(*) AS c FROM items WHERE processed_utc >= ? AND status != 'inbox' " +
      "AND json_extract(metadata, '$.decayed_at') IS NULL",
    [midnight],
  );

  const sweptRecent = scalar(
    db,
    "SELECT COUNT(*) AS c FROM items WHERE json_extract(metadata, '$.decayed_at') >= ?",
    [now - 30 * 86400],
  );

  return {
    new_today: newToday,
    cleared_today: clearedToday,
    swept_recent: sweptRecent,
  };
}

// ---------------------------------------------------------------------------
// Folders (Epic 26) — registry + item assignment
// ---------------------------------------------------------------------------

function folderRow(r: FolderSqlRow): Folder {
  let queryDef: FolderQueryDefinition = {};

  try {
    queryDef = _FOLDER_QUERY_SCHEMA.parse(JSON.parse(r.query_def));
  } catch {
    queryDef = {};
  }

  return { ...r, query_def: queryDef };
}

/** All registered folders, ordered by name. */
export function listFolders(db: Database): Folder[] {
  return rows<FolderSqlRow>(
    db,
    "SELECT id, name, query_def, description, created_utc, updated_utc " +
      "FROM folders ORDER BY name COLLATE NOCASE ASC",
  ).map(folderRow);
}

/**
 * Create a folder from a saved-query definition. Returns the created
 * folder. Throws an error on a duplicate name. Names are lowercased
 * for consistency.
 */
export function createFolder(
  db: Database,
  name: string,
  queryDef?: FolderQueryDefinition | null,
  description = "",
): Folder {
  const qd = JSON.stringify(_FOLDER_QUERY_SCHEMA.parse(queryDef ?? {}));
  const now = Math.floor(Date.now() / 1000);
  const normName = name.trim().toLowerCase().slice(0, 100);

  if (!normName) throw new Error("Folder name cannot be empty");

  if (row<{ present: number }>(db, "SELECT 1 AS present FROM folders WHERE name=?", [normName])) {
    throw new Error(`Folder ${JSON.stringify(name)} already exists`);
  }

  run(db, "INSERT INTO folders (name, query_def, description, created_utc) VALUES (?, ?, ?, ?)", [
    normName,
    qd,
    description.trim().slice(0, 200),
    now,
  ]);
  const created = getFolderByName(db, normName);

  if (!created) throw new Error("Folder insert did not persist");

  return created;
}

/** Look up a folder by exact name. */
export function getFolderByName(db: Database, name: string): Folder | null {
  const r = row<FolderSqlRow>(
    db,
    "SELECT id, name, query_def, description, created_utc, updated_utc " +
      "FROM folders WHERE name=?",
    [name.trim().toLowerCase().slice(0, 100)],
  );

  return r ? folderRow(r) : null;
}

/**
 * Delete a folder by id. Returns true if deleted, false if
 * not found. Does NOT clear the folder field from items —
 * they keep their assignment.
 */
export function deleteFolder(db: Database, folderId: number): boolean {
  return run(db, "DELETE FROM folders WHERE id=?", [folderId]) > 0;
}

/** Rename a folder. Returns the updated folder, or null if not found. */
export function renameFolder(db: Database, folderId: number, newName: string): Folder | null {
  const now = Math.floor(Date.now() / 1000);
  const normName = newName.trim().toLowerCase().slice(0, 100);

  if (!normName) throw new Error("Folder name cannot be empty");

  if (
    row<{ present: number }>(db, "SELECT 1 AS present FROM folders WHERE name=? AND id<>?", [
      normName,
      folderId,
    ])
  ) {
    throw new Error(`Folder name ${JSON.stringify(newName)} already exists`);
  }

  const n = run(db, "UPDATE folders SET name=?, updated_utc=? WHERE id=?", [
    normName,
    now,
    folderId,
  ]);

  if (n === 0) return null;

  return getFolderByName(db, newName.trim().slice(0, 100));
}

/**
 * Set or clear `metadata.folder` on an item. Setting it to null clears
 * the field. Returns true if the item was found and updated.
 */
export function setItemFolder(db: Database, fullname: string, folderName: string | null): boolean {
  const r = row<RawItem>(db, "SELECT * FROM items WHERE fullname=?", [fullname]);

  if (!r) return false;
  const item = rowToRaw(r);
  const md = parseMetadata(item.metadata);

  if (folderName) {
    md.folder = folderName.trim().toLowerCase().slice(0, 100);
  } else {
    delete md.folder;
  }
  // SAFETY: no search_text rewrite — `folder` is not a _META_SEARCH_KEYS
  // entry, so the search blob cannot change here. Adding it to that list
  // without routing this through writeItemMetadata would silently desync FTS.

  run(db, "UPDATE items SET metadata=? WHERE fullname=?", [JSON.stringify(md), fullname]);

  return true;
}

/** Number of items assigned to each folder. */
export function folderCounts(db: Database): CountByKey {
  const out: CountByKey = {};

  for (const r of rows<{ folder: string; c: number }>(
    db,
    "SELECT json_extract(metadata, '$.folder') AS folder, COUNT(*) AS c " +
      "FROM items WHERE json_extract(metadata, '$.folder') IS NOT NULL " +
      "GROUP BY folder ORDER BY c DESC",
  )) {
    out[String(r.folder)] = Number(r.c);
  }

  return out;
}

// ---------------------------------------------------------------------------
// User-tag vocabulary (issue #70 / Epic 26)
// ---------------------------------------------------------------------------

/**
 * Rewrite ``metadata.tags_manual``/``tags`` on every item
 * carrying ``old``: ``new`` = rename to, ``null`` = remove the
 * tag entirely.
 *
 * The HUMAN stamp (``tags_manual``) and the displayed UNION
 * (``tags``) are rewritten; the PROGRAMMATIC stamp
 * (``tags_auto``) is left untouched so the rewrite can never
 * bleed into the heuristic path. After the writes,
 * ``search_text`` is rebuilt per row and the external-content
 * trigram FTS index is fully rebuilt
 * (``INSERT INTO items_trgm(items_trgm) VALUES('rebuild')`` —
 * SQLite's canonical FTS5 external-content rebuild command;
 * ``INSERT ... SELECT`` is the documented gotcha to avoid).
 * Returns the count of items whose ``tags_manual`` actually
 * contained ``old`` (0 = no-op + no FTS rebuild). Shared by
 * `renameUserTag` (CH-B4) and the user_tags delete path
 * (issue #70). Caller commits.
 */
function rewriteManualTag(db: Database, old: string, newName: string | null): number {
  const oldTag = normUserTag(old);

  if (!oldTag) return 0;

  const list = rows<RawItem>(
    db,
    "SELECT * FROM items WHERE EXISTS " +
      "(SELECT 1 FROM json_each(metadata, '$.tags_manual') WHERE value = ?)",
    [oldTag],
  );

  if (!list.length) return 0;

  for (const r of list) {
    const item = rowToRaw(r);
    const md = parseMetadata(item.metadata);
    const manual: string[] = [];

    for (const t of tagList(md.tags_manual)) {
      if (t === oldTag) {
        if (newName !== null) manual.push(newName);
      } else {
        manual.push(t);
      }
    }

    const auto = tagList(md.tags_auto);
    const union: string[] = [];

    for (const t of [...manual, ...auto]) {
      if (!union.includes(t)) union.push(t);
    }

    if (manual.length) md.tags_manual = manual;
    else delete md.tags_manual;

    if (union.length) md.tags = union;
    else delete md.tags;
    writeItemMetadata(db, item, md);
  }

  // Rebuild the external-content trigram FTS over search_text so
  // a search for the new name surfaces the renamed items (or
  // drops the removed ones). ``'rebuild'`` is SQLite's canonical
  // FTS5 command for external-content tables (INSERT … SELECT is
  // the gotcha).
  db.exec("INSERT INTO items_trgm(items_trgm) VALUES('rebuild')");

  return list.length;
}

/**
 * Rename a user-entered tag across every item that carries it
 * in ``metadata.tags_manual`` (CH-B4). Returns the count of
 * affected items (0 = no-op + no FTS rebuild). Caller commits.
 */
export function renameUserTag(db: Database, old: string, newName: string): number {
  const oldTag = normUserTag(old);
  const newTag = normUserTag(newName);

  if (!oldTag || !newTag || oldTag === newTag) return 0;

  return rewriteManualTag(db, oldTag, newTag);
}

/**
 * All registered user tags (stable id + display name), ordered
 * by name, each with the count of items currently stamped with
 * it (0 = pre-created empty tag — issue #70 / Epic 26 P3).
 */
export interface UserTag {
  id: number;
  name: string;
  item_count?: number;
}

export function listUserTags(db: Database): UserTag[] {
  return rows<{ id: number; name: string; item_count: number }>(
    db,
    "SELECT ut.id, ut.name, " +
      "(SELECT COUNT(*) FROM items, json_each(items.metadata, '$.tags_manual') je " +
      " WHERE je.value = ut.name) AS item_count " +
      "FROM user_tags ut ORDER BY ut.name COLLATE NOCASE ASC",
  ).map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    item_count: Number(r.item_count),
  }));
}

/** Look up a registered user tag by its stable id. */
export function getUserTag(db: Database, tagId: number): UserTag | null {
  const r = row<{ id: number; name: string }>(db, "SELECT id, name FROM user_tags WHERE id=?", [
    tagId,
  ]);

  return r ? { id: Number(r.id), name: String(r.name) } : null;
}

/**
 * Pre-create a user tag in the vocabulary (issue #70): a
 * 0-item tag gets a stable id + display name to live in
 * before it is applied to any item. Raises on empty or duplicate names.
 */
export function createUserTag(db: Database, name: string): UserTag {
  const norm = normUserTag(name);

  if (!norm) throw new Error("Tag name cannot be empty");

  if (row<{ present: number }>(db, "SELECT 1 AS present FROM user_tags WHERE name=?", [norm])) {
    throw new Error(`User tag ${JSON.stringify(name)} already exists`);
  }

  run(db, "INSERT INTO user_tags (name) VALUES (?)", [norm]);
  const id = Number(row<{ id: number }>(db, "SELECT id FROM user_tags WHERE name=?", [norm])?.id);
  const tag = getUserTag(db, id);

  if (!tag) throw new Error(`created user tag ${JSON.stringify(norm)} not found`);

  return tag;
}

/**
 * Rename a user tag across the vocabulary and item metadata in one
 * transaction. Raises for a missing tag, empty name, or collision.
 */
export function renameUserTagInVocab(db: Database, tagId: number, newName: string): UserTag {
  const existing = getUserTag(db, tagId);

  if (!existing) throw new Error(`user tag ${tagId} not found`);
  const norm = normUserTag(newName);

  if (!norm) throw new Error("Tag name cannot be empty");

  if (norm === existing.name) return existing;

  if (
    row<{ present: number }>(db, "SELECT 1 AS present FROM user_tags WHERE name=? AND id<>?", [
      norm,
      tagId,
    ])
  ) {
    throw new Error(`User tag name ${JSON.stringify(newName)} already exists`);
  }

  return withTransaction(db, () => {
    run(db, "UPDATE user_tags SET name=? WHERE id=?", [norm, tagId]);
    renameUserTag(db, existing.name, norm);
    const renamed = getUserTag(db, tagId);

    if (!renamed) throw new Error(`renamed user tag ${tagId} not found`);

    return renamed;
  });
}

/**
 * Delete a user tag from the vocabulary (issue #70): drops the
 * row AND strips the tag from every item's ``tags_manual``/
 * ``tags`` (same bulk rewrite + FTS rebuild cost as rename —
 * Epic 26 unlocks it cheaply). Returns true if a row was
 * deleted, false if not found. Commits on success; rolls back
 * and re-raises on error.
 */
export function deleteUserTag(db: Database, tagId: number): boolean {
  const existing = getUserTag(db, tagId);

  if (!existing) return false;

  return withTransaction(db, () => {
    rewriteManualTag(db, String(existing.name), null);
    run(db, "DELETE FROM user_tags WHERE id=?", [tagId]);

    return true;
  });
}

/**
 * The user-tag vocabulary: table-registered tags
 * (``user_tags`` — including pre-created empty ones, issue #70)
 * UNION the distinct ``tags_manual`` stamps that `setTags`
 * writes (Epic 26).
 *
 * Registered rows give tags a stable home (id + display name)
 * before or without any item; tags applied before registration
 * (or applied without registering) still surface via the derived
 * union, so nothing that rendered before drops out. Crucially
 * this reads ``tags_manual`` (only user-applied tags), NOT
 * ``tags`` (which also holds the tens-of-thousands of enrich
 * keywords), so surfacing these in the rail stays cheap + clean.
 */
export function userTagVocab(db: Database): string[] {
  const out = rows<{ tag: string }>(
    db,
    "SELECT DISTINCT je.value AS tag " +
      "FROM items, json_each(items.metadata, '$.tags_manual') je",
  ).map((r) => String(r.tag));

  const seen = new Set(out);

  for (const r of rows<{ name: string }>(
    db,
    "SELECT name FROM user_tags ORDER BY name COLLATE NOCASE ASC",
  )) {
    const name = String(r.name);

    if (!seen.has(name)) {
      out.push(name);
      seen.add(name);
    }
  }

  return out;
}

/**
 * Counts for the rail's facet tags (curated `FILTER_TAGS`
 * PLUS user-created tags from `userTagVocab`), descending.
 *
 * ``metadata.tags`` also holds non-facet values (e.g. YouTube
 * per-video keywords from the enrich pass), so the result is
 * restricted to the facet vocabulary — otherwise the browse
 * rail would render tens of thousands of one-off keyword tags.
 * User tags join the vocabulary so a manually-applied tag shows
 * up as a rail facet alongside the curated set (Epic 26).
 * Optionally cross-filtered by source/status so the rail
 * composes with the active source tab + status nav.
 */
export function tagCounts(
  db: Database,
  opts: { source?: string | null; status?: string | null } = {},
): CountByKey {
  const facetTags: string[] = [...FILTER_TAGS];
  const seen = new Set(facetTags);

  for (const t of userTagVocab(db)) {
    // user-created tags join the curated facet vocabulary
    if (!seen.has(t)) {
      facetTags.push(t);
      seen.add(t);
    }
  }

  const placeholders = facetTags.map(() => "?").join(",");
  const where = [`je.value IN (${placeholders})`];
  const params: SQLQueryBindings[] = [...facetTags];

  if (opts.source) {
    where.push("items.source = ?");
    params.push(opts.source);
  }

  if (opts.status) {
    where.push("items.status = ?");
    params.push(opts.status);
  }

  const list = rows<{ tag: string; c: number }>(
    db,
    "SELECT je.value AS tag, COUNT(*) AS c " +
      "FROM items, json_each(items.metadata, '$.tags') je " +
      `WHERE ${where.join(" AND ")} ` +
      "GROUP BY je.value ORDER BY c DESC, je.value COLLATE NOCASE ASC",
    params,
  );

  const out: CountByKey = {};

  for (const r of list) out[String(r.tag)] = Number(r.c);

  return out;
}

/** Reddit-only stats for the management view's stats modal. */
export function redditStats(db: Database): RedditStats {
  const sub = "json_extract(metadata, '$.subreddit')";
  const byKind: Record<string, number> = {};

  for (const r of rows<{ k: string; c: number }>(
    db,
    "SELECT kind AS k, COUNT(*) AS c FROM items WHERE source='reddit' GROUP BY kind",
  )) {
    byKind[String(r.k)] = Number(r.c);
  }

  const byStatus = groupCounts(db, "status", "reddit");

  const topSubs = rows<{ s: string; c: number }>(
    db,
    `SELECT ${sub} AS s, COUNT(*) AS c FROM items ` +
      `WHERE source='reddit' AND ${sub} IS NOT NULL AND ${sub} <> '' ` +
      `GROUP BY ${sub} COLLATE NOCASE ORDER BY c DESC LIMIT 15`,
  ).map((r) => ({ subreddit: String(r.s), count: Number(r.c) }));

  const distinctSubs = scalar(
    db,
    `SELECT COUNT(DISTINCT ${sub} COLLATE NOCASE) AS c FROM items ` +
      `WHERE source='reddit' AND ${sub} IS NOT NULL AND ${sub} <> ''`,
  );

  const nsfw = scalar(
    db,
    "SELECT COUNT(*) AS c FROM items WHERE source='reddit' " +
      "AND json_extract(metadata, '$.over_18') = 1",
  );

  const withMedia = scalar(
    db,
    "SELECT COUNT(*) AS c FROM items WHERE source='reddit' AND url <> ''",
  );

  const byYear = rows<{ y: number; c: number }>(
    db,
    "SELECT CAST(strftime('%Y', created_utc, 'unixepoch') AS INTEGER) AS y, COUNT(*) AS c " +
      "FROM items WHERE source='reddit' AND created_utc > 0 GROUP BY y ORDER BY y",
  ).map((r) => ({ year: Number(r.y), count: Number(r.c) }));

  return {
    total: Object.values(byStatus).reduce((a, b) => a + b, 0), // 0 when there are no reddit items
    by_kind: byKind,
    by_status: byStatus,
    by_tag: tagCounts(db, { source: "reddit" }),
    top_subreddits: topSubs,
    distinct_subreddits: distinctSubs,
    nsfw,
    with_media: withMedia,
    by_year: byYear,
  };
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function groupCounts(
  db: Database,
  column: string,
  source?: string | null,
  status?: string | null,
): CountByKey {
  const filters: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (source) {
    filters.push("source = ?");
    params.push(source);
  }

  if (status) {
    filters.push("status = ?");
    params.push(status);
  }

  const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
  const out: CountByKey = {};

  for (const r of rows<{ k: string | null; c: number }>(
    db,
    `SELECT ${column} AS k, COUNT(*) AS c FROM items${where} GROUP BY ${column} ORDER BY c DESC`,
    params,
  )) {
    out[String(r.k ?? "")] = Number(r.c);
  }

  return out;
}

/**
 * Per-category counts with stable ordering from
 * `VALID_CATEGORIES`.
 *
 * Optional ``source`` / ``status`` cross-filter the counts so the
 * browse category tabs can compose with the active source/status
 * filters while still showing 0-count categories.
 */
export function categoryCounts(
  db: Database,
  opts: { source?: string | null; status?: string | null } = {},
): Array<{ category: string; count: number }> {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (opts.source) {
    where.push("source = ?");
    params.push(opts.source);
  }

  if (opts.status) {
    where.push("status = ?");
    params.push(opts.status);
  }

  let sql = "SELECT json_extract(metadata, '$.category') AS k, COUNT(*) AS c FROM items";

  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  sql += " GROUP BY k";
  const counts: Record<string, number> = {};

  for (const r of rows<{ k: string | null; c: number }>(db, sql, params)) {
    if (r.k) counts[String(r.k)] = Number(r.c);
  }

  return VALID_CATEGORIES.map((cat) => ({
    category: cat,
    count: counts[cat] ?? 0,
  }));
}

/**
 * Per-source counts. With ``status``, ``count`` is that
 * source's items in that status (sources present globally still
 * appear, possibly with 0); ordered by global size so the tab
 * order stays stable as the status filter changes.
 */
export function sourceCounts(
  db: Database,
  status?: string | null,
): Array<{ source: string; count: number }> {
  const list = status
    ? rows<{ source: string; c: number }>(
        db,
        "SELECT source, SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS c " +
          "FROM items GROUP BY source ORDER BY COUNT(*) DESC",
        [status],
      )
    : rows<{ source: string; c: number }>(
        db,
        "SELECT source, COUNT(*) AS c FROM items GROUP BY source ORDER BY c DESC",
      );

  return list.map((r) => ({ source: String(r.source), count: Number(r.c) }));
}

export function getCounts(
  db: Database,
  source?: string | null,
  status?: string | null,
  opts: { light?: boolean } = {},
): LightCounts | FullCounts {
  const filters: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (source) {
    filters.push("source = ?");
    params.push(source);
  }

  if (status) {
    filters.push("status = ?");
    params.push(status);
  }

  const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
  const total = scalar(db, `SELECT COUNT(*) AS c FROM items${where}`, params);
  const byStatus = groupCounts(db, "status", source);

  if (opts.light) {
    // Hot path: the browse rail refreshes status counts after every
    // triage action. It only needs by_status (index-backed, ~3ms) —
    // skip the unindexed full-table scans below (by_kind /
    // processed_this_week / with_url, ~170ms total) that only the
    // Stats modal uses.
    return {
      total,
      inbox: byStatus.inbox ?? 0,
      by_status: byStatus,
    };
  }

  const bySource = groupCounts(db, "source"); // global — drives the Stats modal chart
  const sourceExtra = source ? " AND source = ?" : "";
  const sourceParams = source ? [source] : [];
  const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;

  const processedWeek = scalar(
    db,
    `SELECT COUNT(*) AS c FROM items WHERE processed_utc IS NOT NULL AND processed_utc >= ?${sourceExtra}`,
    [weekAgo, ...sourceParams],
  );

  const withUrl = scalar(
    db,
    `SELECT COUNT(*) AS c FROM items WHERE url <> ''${sourceExtra}`,
    sourceParams,
  );

  return {
    total,
    inbox: byStatus.inbox ?? 0,
    by_source: bySource,
    by_kind: groupCounts(db, "kind", source, status),
    by_status: byStatus,
    processed_this_week: processedWeek,
    with_url: withUrl,
    distinct_sources: Object.keys(bySource).length,
  };
}
