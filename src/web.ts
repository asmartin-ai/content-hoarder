import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, join, normalize, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { Database } from "bun:sqlite";
import { serve, type Server } from "bun";
import { z } from "zod";
import * as config from "./config.ts";
import * as db from "./db.ts";
import { parse } from "./search_query.ts";
import type { Item, JsonValue } from "./models.ts";
import { REGISTRY, dispatch, get } from "./connectors/registry.ts";
import * as categorize from "./categorize.ts";
import * as resurface from "./resurface.ts";
import * as tagSuggest from "./tag_suggest.ts";
import * as folders from "./folders.ts";
import * as dedup from "./dedup.ts";
import * as firefoxTabs from "./firefox_tabs.ts";
import * as redditSync from "./reddit_sync.ts";
import * as redditUnsave from "./reddit_unsave.ts";
import { TrickleDrainer } from "./reddit_trickle.ts";
import * as redditHydrate from "./reddit_hydrate.ts";
import * as redditThread from "./reddit_thread.ts";
import * as hnThread from "./hn_thread.ts";
import * as exportModule from "./export.ts";
import * as llm from "./assist/llm.ts";
import * as pkms from "./bridge/pkms.ts";
import * as mediaStore from "./media_store.ts";
import * as archival from "./archival/service.ts";
import { defaultMediaProviders } from "./archival/providers.ts";
import { importPath } from "./pipeline.ts";
import { resolveYouTubeUrl } from "./youtube.ts";

const STATIC_DIR = join(import.meta.dir, "static");

const TEMPLATE_PATH = join(import.meta.dir, "templates", "index.html");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
} satisfies Record<string, string>;

const ServeOptionsSchema = z.object({
  dbPath: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().optional(),
  tls: z.boolean().optional(),
});

const RetentionBody = z.object({
  retention_days: z
    .union([z.number(), z.string()])
    .transform((value) => Number(value))
    .pipe(z.number().int().min(1).max(3650)),
});

const SearchCountSchema = z.object({ total: z.number() });

const QueueStateSchema = z.object({ state: z.string() });

const PriorStatusSchema = z.object({ status: z.string(), state: z.string().nullable() });

const PurgeVictimSchema = z.object({ fullname: z.string(), source: z.string(), title: z.string() });

const ExistingCountSchema = z.object({ count: z.number() });

const HydrateResponseSchema = z.object({
  status: z.enum([
    "hydrated",
    "archived",
    "cached",
    "no_gallery",
    "not_found",
    "bad_shape",
    "auth_missing",
    "auth_expired",
    "network_error",
    "no_permalink",
    "unavailable",
  ]),
});

const ItemStatusBody = z.object({ status: z.string() });

const SnoozeBody = z.object({
  window_days: z.union([z.number(), z.string()]).optional(),
  until_utc: z.union([z.number(), z.string()]).optional(),
  escalate_after: z.union([z.number(), z.string()]).optional(),
});

const BodyTextRequest = z.object({ body: z.string() });

const CategoryBody = z.object({ category: z.string() });

const TagBody = z.object({
  add: z.array(z.string()).optional(),
  remove: z.array(z.string()).optional(),
  tag: z.string().optional(),
});

const RecoveryBody = z.object({
  fullnames: z.array(z.string()).optional(),
  bulk: z.boolean().optional(),
  archive_today: z.enum(["off", "preview", "apply"]).optional(),
  metadata: z.boolean().optional(),
  confirm_external_archive_today: z.boolean().optional(),
});

const FolderBody = z.object({ folder: z.string().nullable().optional() });

const SnoozeUndoBody = z.object({
  snoozed_wave: z.number().optional(),
  decayed_at: z.number().optional(),
});

const ClusterBody = z.object({ cluster: z.string() });

const ClusterUndoBody = ClusterBody.extend({ decayed_at: z.number() });

const DuplicateResolveBody = z.object({ keep: z.string(), archive: z.array(z.string()) });

const DuplicateUndoBody = z.object({ fullnames: z.array(z.string()).min(1) });

const TagFilterBody = z.object({ tag: z.string().optional() });

const CreateFolderBody = z.object({
  name: z.string(),
  description: z.string().optional(),
  query_def: z
    .object({
      source: z.string().optional(),
      status: z.string().optional(),
      subreddit: z.string().optional(),
      kind: z.string().optional(),
      has: z.string().optional(),
      q: z.string().optional(),
      tag: z.union([z.string(), z.array(z.string())]).optional(),
      tags_all: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});

const RenameFolderBody = z.object({ name: z.string() });

const EvaluateFoldersBody = z.object({ folder_id: z.union([z.number(), z.string()]).optional() });

const EnabledBody = z.object({ enabled: z.boolean() });

const CookieBody = z.object({ cookie: z.string() });

const RedditSyncBody = z.object({
  full: z.boolean().optional(),
  max_pages: z.union([z.number(), z.string()]).optional(),
});

const PurgeBody = z.object({
  expected_total: z.union([z.number(), z.string()]),
  expected_cutoff: z.union([z.number(), z.string()]),
});

const DrainBody = z.object({
  max: z.union([z.number(), z.string()]).optional(),
  limit: z.union([z.number(), z.string()]).optional(),
  live: z.boolean().optional(),
  confirm: z.boolean().optional(),
  yes: z.boolean().optional(),
});

const EnqueueTagBody = z.object({
  tag: z.string(),
  apply: z.boolean().optional(),
  confirm: z.boolean().optional(),
  yes: z.boolean().optional(),
});

const PrepareImportBody = z.object({ url: z.string().optional(), source: z.string().optional() });

const CommitImportBody = z.object({ token: z.string().optional() });

const prepared = new Map<string, { path: string; source: string; expires: number }>();

const RETENTION_SECONDS = 3600;

let selectedDbPath: string | undefined;

let activeDatabasePath: string | undefined;

let activeDatabase: Database | undefined;

// A Done enqueues instantly (db.setStatus); this idle-debounced drainer flushes
// a small capped batch once triage settles, when unsave-on-done is opted in.
let unsaveTrickle: TrickleDrainer | null = null;

function databasePath(): string {
  return selectedDbPath ?? config.dbPath();
}

function json<T>(body: T, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

function connection(): Database {
  const path = databasePath();

  if (!activeDatabase || activeDatabasePath !== path) {
    activeDatabase?.close();
    activeDatabase = db.connect(path);
    activeDatabasePath = path;
  }

  return activeDatabase;
}

function numberParam(value: string | null, fallback: number): number {
  if (value === null || value === "") return fallback;
  const result = Number(value);

  return Number.isInteger(result) ? result : fallback;
}

function numberValue(value: JsonValue | undefined, fallback: number): number {
  const parsed = z.union([z.number().finite(), z.string()]).safeParse(value);

  return parsed.success ? numberParam(String(parsed.data), fallback) : fallback;
}

function bool(value: JsonValue | undefined): boolean {
  return value === true;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

async function objectBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  const value = request.headers.get("content-type")?.includes("application/x-www-form-urlencoded")
    ? Object.fromEntries(new URLSearchParams(await request.text()).entries())
    : await request.json().catch(() => ({}));

  return schema.parse(value);
}

function localHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;

  if (isIP(host) === 4) {
    const [first = 0, second = 0] = host.split(".").map(Number);

    return (
      first === 127 ||
      first === 10 ||
      (first === 192 && second === 168) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 100 && second >= 64 && second <= 127)
    );
  }

  return isIP(host) === 6 && /^(fc|fd|fe[89ab])/i.test(host);
}

function guard(request: Request): Response | null {
  const host = request.headers.get("host") ?? "";
  let hostname: string;

  try {
    hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return json({ error: "forbidden host" }, 403);
  }

  if (!localHost(hostname)) return json({ error: "forbidden host" }, 403);

  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    const origin = request.headers.get("origin");

    if (origin) {
      try {
        if (new URL(origin).host.toLowerCase() !== host.toLowerCase())
          return json({ error: "cross-origin request rejected" }, 403);
      } catch {
        return json({ error: "cross-origin request rejected" }, 403);
      }
    }
  }

  return null;
}

function staticResponse(path: string): Response {
  const rel =
    path === "/manifest.webmanifest" ? "manifest.webmanifest" : path.slice("/static/".length);

  const target = resolve(STATIC_DIR, normalize(rel));

  if (!target.startsWith(`${STATIC_DIR}/`) || !existsSync(target))
    return new Response("not found", { status: 404 });

  const contentType =
    Object.entries(MIME).find(([extension]) => extension === extname(target).toLowerCase())?.[1] ??
    "application/octet-stream";

  return new Response(Bun.file(target), {
    headers: { "Content-Type": contentType },
  });
}

function options(params: URLSearchParams, overrides: Partial<db.SearchOpts> = {}): db.SearchOpts {
  const parsed = parse(params.get("q") ?? "");
  const status = parsed.status ?? params.get("status");

  return {
    source: parsed.source ?? params.get("source"),
    kind: parsed.kind ?? params.get("kind"),
    status,
    category: params.get("category"),
    tags: parsed.tags.length ? parsed.tags : params.getAll("tag"),
    tagsAll: parsed.tagsAll,
    subreddit: parsed.subreddit ?? params.get("subreddit"),
    author: parsed.author ?? params.get("author"),
    isSaved:
      parsed.isSaved ?? (params.has("is_saved") ? numberParam(params.get("is_saved"), 0) : null),
    nsfw: parsed.nsfw,
    hideNsfw: ["1", "true"].includes(params.get("safe") ?? ""),
    decayed: parsed.decayed,
    swept: parsed.swept,
    snoozed: parsed.snoozed,
    hideSnoozed: !parsed.snoozed && status === "inbox",
    deleted: parsed.deleted,
    hasMedia: parsed.has,
    ocr: parsed.ocr,
    openInFirefox:
      parsed.openInFirefox || ["1", "true"].includes(params.get("open_in_firefox") ?? ""),
    before: parsed.before,
    after: parsed.after,
    scoreMin: parsed.scoreMin,
    scoreMax: parsed.scoreMax,
    exact: parsed.exact.length ? parsed.exact : null,
    exclude: parsed.exclude.length ? parsed.exclude : null,
    includeConsolidated: params.get("consolidated") !== "false",
    fuzzy: params.get("exact") !== "1",
    sort: params.get("sort") ?? "last_seen_utc",
    order: params.get("order") === "asc" ? "asc" : "desc",
    limit: clamp(numberParam(params.get("limit"), 50), 1, 500) + 1,
    offset: Math.max(numberParam(params.get("offset"), 0), 0),
    ...overrides,
  };
}

function redditView(item: Item) {
  const metadata = item.metadata;

  return {
    fullname: item.fullname,
    reddit_id: item.source_id,
    kind: item.kind,
    title: item.title,
    body: item.body,
    url: item.url,
    permalink: metadata.permalink ?? "",
    subreddit: metadata.subreddit ?? "",
    author: item.author,
    score: metadata.score ?? 0,
    over_18: metadata.over_18 ? 1 : 0,
    num_comments: metadata.num_comments ?? 0,
    created_utc: item.created_utc,
    saved_utc: item.saved_utc,
    first_seen_utc: item.first_seen_utc,
    is_saved: item.is_saved,
    status: item.status,
    media_type: metadata.media_type ?? "",
    media_url: metadata.media_url ?? "",
    tags: metadata.tags ?? [],
  };
}

function cleanPrepared(): void {
  for (const [token, item] of prepared)
    if (item.expires < Date.now()) {
      try {
        unlinkSync(item.path);
      } catch {
        /* expired staged file was already removed */
      }

      prepared.delete(token);
    }
}

function requestItem(path: string): { fullname: string; action: string | null } | null {
  const match =
    /^\/(?:api\/)?(?:reddit\/)?items\/(.+?)(?:\/(status|snooze|promote|undo|suggest|body|recover|category|tags|folder|hydrate|hydrate-gallery))?$/.exec(
      path,
    );

  if (!match) return null;

  try {
    return { fullname: decodeURIComponent(match[1] ?? ""), action: match[2] ?? null };
  } catch {
    return null;
  }
}

async function handle(request: Request): Promise<Response> {
  const forbidden = guard(request);

  if (forbidden) return forbidden;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === "GET" && path === "/triage") return Response.redirect("/?deck=1", 302);

  if (method === "GET" && path === "/reddit") return Response.redirect("/?source=reddit", 302);

  if (method === "GET" && (path.startsWith("/static/") || path === "/manifest.webmanifest"))
    return staticResponse(path);

  if (method === "GET" && path === "/sw.js")
    return new Response(Bun.file(join(STATIC_DIR, "sw.js")), {
      headers: { "Content-Type": "text/javascript", "Service-Worker-Allowed": "/" },
    });

  if (method === "GET" && (path === "/" || path === "/browse"))
    return new Response(Bun.file(TEMPLATE_PATH), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });

  try {
    if (method === "GET" && path === "/items") {
      const search = options(url.searchParams);
      const count = search.limit ?? 51;

      const rows = db.searchItems(
        connection(),
        parse(url.searchParams.get("q") ?? "").text,
        search,
      );

      return json({ items: rows.slice(0, count - 1), has_more: rows.length >= count });
    }

    const itemRoute = requestItem(path);

    if (method === "GET" && itemRoute && !itemRoute.action) {
      const item = db.getPublicItem(connection(), itemRoute.fullname);

      return item ? json(item) : json({ error: "not found" }, 404);
    }

    if (method === "GET" && path === "/random") {
      const mode = z
        .enum(["smart", "recent", "random"])
        .catch("smart")
        .parse((url.searchParams.get("mode") ?? "smart").trim().toLowerCase());

      return json({
        items: db.getRandomBatch(
          connection(),
          clamp(numberParam(url.searchParams.get("n"), 20), 1, 100),
          {
            source: url.searchParams.get("source") ?? undefined,
            category: url.searchParams.get("category")?.trim().toLowerCase() || undefined,
            tags: url.searchParams
              .getAll("tag")
              .map((tag) => tag.trim().toLowerCase())
              .filter(Boolean),
            unprocessed: url.searchParams.get("unprocessed") !== "0",
            mode,
          },
        ),
      });
    }

    if (method === "GET" && path === "/export") {
      const opts = options(url.searchParams, {
        includeConsolidated: true,
        sort: url.searchParams.get("sort") ?? "created_utc",
        limit: 1_000_000,
        offset: 0,
      });

      const rows = db.searchItems(connection(), parse(url.searchParams.get("q") ?? "").text, opts);
      const records = exportModule.exportRecords(rows);

      if ((url.searchParams.get("format") ?? "csv").toLowerCase() === "json")
        return json({ count: records.length, items: records });

      return new Response(exportModule.toCsv(records), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=content-hoarder-export.csv",
        },
      });
    }

    if (method === "GET" && path === "/sources") {
      return json({
        sources: db.sourceCounts(connection(), url.searchParams.get("status")).map((row) => {
          const connector = REGISTRY[row.source];

          return {
            id: row.source,
            label: connector?.label ?? row.source,
            badge_color: connector?.badgeColor ?? "#888888",
            count: row.count,
          };
        }),
      });
    }

    if (method === "GET" && path === "/categories") {
      const source = url.searchParams.get("source");
      const status = url.searchParams.get("status");
      const counts = db.categoryCounts(connection(), { source, status });

      const totalRow = SearchCountSchema.safeParse(
        connection()
          .query(
            "SELECT COUNT(*) AS total FROM items WHERE source = COALESCE(?, source) AND status = COALESCE(?, status)",
          )
          .get(source, status),
      );

      const total = totalRow.success ? totalRow.data.total : 0;

      return json({
        total,
        categories: counts.map((row) => ({
          id: row.category,
          label: `${row.category[0]?.toUpperCase()}${row.category.slice(1)}`,
          count: row.count,
        })),
      });
    }

    if (method === "GET" && path === "/tags") {
      const tags = db.tagCounts(connection(), {
        source: url.searchParams.get("source"),
        status: url.searchParams.get("status"),
      });

      return json({
        tags,
        total: Object.values(tags).reduce((sum, count) => sum + count, 0),
        groups: categorize.tagGroups(),
      });
    }

    if (method === "GET" && path === "/stats")
      return json(
        db.getCounts(connection(), url.searchParams.get("source"), url.searchParams.get("status"), {
          light: url.searchParams.get("light") === "1",
        }),
      );

    if (method === "GET" && path === "/pulse") return json(db.pulse(connection()));

    if (method === "GET" && path === "/resurface") {
      const card = resurface.candidate(connection());

      return card ? json(card) : new Response(null, { status: 204 });
    }

    if (method === "GET" && path === "/reddit/items") {
      const params = new URLSearchParams(url.searchParams);
      params.set("source", "reddit");

      const opts = options(params, {
        source: "reddit",
        sort: params.get("sort") ?? "first_seen_utc",
        limit: clamp(numberParam(params.get("limit"), 100), 1, 500) + 1,
      });

      const rows = db.searchItems(connection(), parse(params.get("q") ?? "").text, opts);
      const limit = (opts.limit ?? 101) - 1;

      return json({ items: rows.slice(0, limit).map(redditView), has_more: rows.length > limit });
    }

    if (method === "GET" && path === "/reddit/subreddits")
      return json({
        subreddits: db.redditSubredditCounts(connection(), url.searchParams.get("status")),
      });

    if (method === "GET" && path === "/reddit/stats") return json(db.redditStats(connection()));

    if (method === "GET" && path === "/reddit/unsave/status") {
      const database = connection();
      const auth = redditUnsave.getAuth(database);

      return json({
        configured: auth !== null,
        username: auth?.username ?? null,
        enabled: db.unsaveEnabled(database),
        pending: redditUnsave.countPending(database),
        failed: redditUnsave.countFailed(database),
      });
    }

    if (method === "GET" && path === "/tag-suggestions") {
      const settings = {
        status: url.searchParams.get("status") ?? "pending",
        tag: url.searchParams.get("tag") ?? undefined,
        sourceType: url.searchParams.get("source_type") ?? undefined,
        limit: url.searchParams.has("limit")
          ? numberParam(url.searchParams.get("limit"), 0)
          : undefined,
      };

      const suggestions = tagSuggest.listSuggestions(connection(), settings);

      return json({
        suggestions,
        by_tag: tagSuggest.suggestionCounts(connection(), { status: settings.status }),
        total: suggestions.length,
      });
    }

    if (method === "GET" && path === "/folders") {
      const database = connection();
      const entries = db.listFolders(database);
      const counts = db.folderCounts(database);

      return json(entries.map((entry) => ({ ...entry, count: counts[String(entry.name)] ?? 0 })));
    }

    if (method === "GET" && path === "/folders/stats") return json(db.folderCounts(connection()));

    if (method === "GET" && path === "/duplicates") {
      const by = url.searchParams.get("by") ?? "url";
      const status = url.searchParams.get("status") ?? "inbox";

      if (by !== "url" && by !== "title") return json({ error: "by must be url or title" }, 400);

      if (!["inbox", "keep", "archived", "done"].includes(status))
        return json({ error: "invalid status" }, 400);

      return json({ groups: dedup.findGroups(connection(), { by, status }), by, status });
    }

    if (method === "GET" && path.startsWith("/reddit/items/") && path.endsWith("/thread")) {
      const fullname = decodeURIComponent(path.slice("/reddit/items/".length, -"/thread".length));
      const rawSort = url.searchParams.get("sort") ?? "best";
      const sort = ["best", "top", "new"].includes(rawSort) ? rawSort : "best";
      const database = connection();

      const hydrated =
        url.searchParams.get("nofetch") === "1"
          ? null
          : await redditHydrate.hydrateIfMissing(database, fullname);

      const result = redditThread.getThread(database, fullname, sort);

      if (!result) return json({ error: "not found" }, 404);

      return hydrated ? json({ ...result, hydrate_status: hydrated.status }) : json(result);
    }

    if (method === "GET" && path.startsWith("/hackernews/items/") && path.endsWith("/thread")) {
      const fullname = decodeURIComponent(
        path.slice("/hackernews/items/".length, -"/thread".length),
      );

      const rawSort = url.searchParams.get("sort") ?? "top";
      const sort = ["top", "new", "default", "best"].includes(rawSort) ? rawSort : "top";
      const database = connection();

      if (!db.getItem(database, fullname)) return json({ error: "not found" }, 404);

      const hydrated =
        url.searchParams.get("nofetch") === "1"
          ? null
          : await hnThread.hydrateIfMissing(database, fullname);

      const result = hnThread.getThread(database, fullname, sort);

      if (!result) return json({ error: "not found" }, 404);

      return hydrated ? json({ ...result, hydrate_status: hydrated.status }) : json(result);
    }

    if (method === "GET" && path.startsWith("/media/")) {
      const file = mediaStore.pathFor(decodeURIComponent(path.slice("/media/".length)));

      if (!file) return json({ error: "not found" }, 404);

      return new Response(Bun.file(file), {
        headers: {
          "Content-Type": mediaStore.mimeFor(basename(file)),
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    }

    if (itemRoute && method === "POST" && itemRoute.action) {
      const action = itemRoute.action;
      const fullname = itemRoute.fullname;
      const database = connection();

      if (action === "undo" && path.startsWith("/reddit/items/")) {
        if (!db.getItem(database, fullname)) return json({ error: "not found" }, 404);

        const queued = QueueStateSchema.safeParse(
          database.query("SELECT state FROM reddit_unsave WHERE fullname=?").get(fullname),
        );

        if (queued.success && queued.data.state === "done")
          return json({ undone: await redditUnsave.resave(database, fullname), method: "resave" });
        db.dequeueUnsave(database, fullname);
        database.query("UPDATE items SET is_saved=1 WHERE fullname=?").run(fullname);

        return json({ undone: true, method: "dequeued", is_saved: 1 });
      }

      if (action === "status") {
        const body = await objectBody(request, ItemStatusBody);

        try {
          const status = body.status.trim();
          const item = db.setStatus(database, fullname, status);

          if (!item) return json({ error: "not found" }, 404);

          // Arm the unsave trickle when a Reddit item is Done and unsave-on-done
          // is opted in; the flag is read on this same connection.
          if (
            status === "done" &&
            fullname.startsWith("reddit:") &&
            db.getSetting(database, "reddit_unsave_on_done", "0") === "1"
          )
            unsaveTrickle?.noteEnqueue();

          return json(item);
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 400);
        }
      }

      if (action === "undo") {
        const prior = PriorStatusSchema.safeParse(
          database
            .query(
              "SELECT i.status, q.state FROM items i LEFT JOIN reddit_unsave q ON q.fullname=i.fullname WHERE i.fullname=?",
            )
            .get(fullname),
        );

        let item = db.undoStatus(database, fullname);

        if (!item) return json({ error: "not found" }, 404);

        if (
          prior.success &&
          prior.data.status === "done" &&
          prior.data.state === "done" &&
          item.status !== "done"
        ) {
          const saved = await redditUnsave.resave(database, fullname);
          item = db.getPublicItem(database, fullname) ?? item;

          if (!saved)
            return json({
              ...item,
              warning:
                "restored locally, but still unsaved on Reddit (re-save failed — check the session cookie)",
            });
        }

        return json(item);
      }

      if (action === "snooze") {
        const body = await objectBody(request, SnoozeBody);
        const now = Math.floor(Date.now() / 1000);
        const days = numberValue(body.window_days, 7) || 7;

        if (days < 1) return json({ error: "window_days must be >= 1" }, 400);
        let until = numberValue(body.until_utc, 0) || now + days * 86400;

        if (until < now) return json({ error: "until_utc must be in the future" }, 400);
        until = Math.min(until, now + 10 * 365 * 86400);

        try {
          return json(
            db.snooze(database, {
              fullnames: [fullname],
              untilUtc: until,
              windowDays: days,
              escalateAfter: numberValue(body.escalate_after, 3) || 3,
              apply: true,
            }),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          return json({ error: message }, message.startsWith("unknown item") ? 404 : 400);
        }
      }

      if (action === "body") {
        const body = await objectBody(request, BodyTextRequest);
        const item = db.setBody(database, fullname, body.body);

        return item ? json(item) : json({ error: "not found" }, 404);
      }

      if (action === "category") {
        const body = await objectBody(request, CategoryBody);

        const category = z
          .enum(categorize.VALID_CATEGORIES)
          .safeParse(body.category.trim().toLowerCase());

        if (!category.success) return json({ error: "invalid category" }, 400);

        if (!db.getItem(database, fullname)) return json({ error: "not found" }, 404);
        db.setCategory(database, fullname, category.data);

        return json({ fullname, category: category.data });
      }

      if (action === "tags") {
        const body = await objectBody(request, TagBody);
        const add = [...(body.add ?? []), ...(body.tag ? [body.tag] : [])];
        const remove = body.remove ?? [];

        if (!add.length && !remove.length) return json({ error: "no tags given" }, 400);
        const tags = db.setTags(database, fullname, { add, remove });

        return tags ? json({ fullname, tags }) : json({ error: "not found" }, 404);
      }

      if (action === "promote") {
        const item = db.getPublicItem(database, fullname);

        if (!item) return json({ error: "not found" }, 404);

        if (!pkms.isConfigured())
          return json(
            { error: "PKMS not configured (set PKMS_CAPTURE_URL + PKMS_CAPTURE_TOKEN)" },
            400,
          );

        const device = /Mobile|Android|iPhone|iPad/.test(request.headers.get("user-agent") ?? "")
          ? "phone"
          : "desktop";

        const result = await pkms.promote(database, item, { device });

        return json(result, result.status === "failed" ? 502 : 200);
      }

      if (action === "suggest") {
        if (!llm.isAvailable()) return json({ error: "LLM not configured" }, 503);
        const result = await llm.suggestAndStore(database, fullname);

        return result ? json(result) : json({ error: "no suggestion" }, 502);
      }

      if (action === "recover") {
        const body = await objectBody(request, RecoveryBody);
        const mode = body.archive_today ?? "off";
        const metadata = body.metadata ?? true;

        if (body.fullnames || body.bulk) return json({ error: "recover is per-item only" }, 400);

        if (!metadata && mode === "off")
          return json({ error: "recover request has no enabled recovery mode" }, 400);
        const result = metadata ? await archival.recoverOne(database, fullname) : null;

        if (metadata && !result) return json({ error: "not a recoverable reddit item" }, 400);

        if (mode !== "off") {
          if (body.confirm_external_archive_today !== true)
            return json({ error: "archive.today recovery requires explicit confirmation" }, 400);
          const eligibility = archival.archiveTodayMediaEligibility(db.getItem(database, fullname));

          if (!eligibility.eligible)
            return json({ error: "archive.today not eligible", reason: eligibility.reason }, 400);

          const media = await archival.archiveTodayRecoverMedia(database, fullname, {
            providers: defaultMediaProviders(archival.DEFAULT_USER_AGENT, false),
            applyBytes: mode === "apply",
          });

          return json({
            ...result,
            archive_today: media,
            bytes_archived: media.bytes_archived,
            recovered: result?.metadata_recovered || media.result === "hit",
          });
        }

        return json(
          result ?? {
            recovered: false,
            metadata_recovered: false,
            metadata_result: "skipped",
            metadata_reason: "disabled",
            title: null,
            body: null,
            url: null,
            bytes_archived: 0,
          },
        );
      }

      if (action === "hydrate" || action === "hydrate-gallery") {
        const rawResult =
          action === "hydrate"
            ? await redditHydrate.hydrateOne(database, fullname)
            : await redditHydrate.hydrateGallery(database, fullname);

        const result = HydrateResponseSchema.parse(rawResult);

        const success =
          action === "hydrate"
            ? ["hydrated", "archived"].includes(result.status)
            : ["cached", "hydrated", "no_gallery"].includes(result.status);

        const code = success
          ? 200
          : result.status === "not_found"
            ? 404
            : ["no_permalink", "bad_shape"].includes(result.status)
              ? 400
              : ["auth_missing", "auth_expired"].includes(result.status)
                ? 401
                : result.status === "network_error"
                  ? 502
                  : 500;

        return json(result, code);
      }

      if (action === "folder") {
        const body = await objectBody(request, FolderBody);
        const folder = body.folder ?? null;

        return db.setItemFolder(database, fullname, folder)
          ? json({ fullname, folder })
          : json({ error: "not found" }, 404);
      }
    }

    if (method === "POST" && path.startsWith("/reddit/items/") && path.endsWith("/unsave")) {
      const fullname = decodeURIComponent(path.slice("/reddit/items/".length, -"/unsave".length));
      const database = connection();

      if (!db.getItem(database, fullname)) return json({ error: "not found" }, 404);
      db.enqueueUnsave(database, fullname);
      database.query("UPDATE items SET is_saved=0 WHERE fullname=?").run(fullname);

      return json({ queued: true, fullname, is_saved: 0 });
    }

    if (method === "POST" && path.startsWith("/items/") && path.endsWith("/resave")) {
      const fullname = decodeURIComponent(path.slice("/items/".length, -"/resave".length));

      return json({ resaved: await redditUnsave.resave(connection(), fullname) });
    }

    if (method === "POST" && path === "/bulk/status") {
      const body = z
        .object({ fullnames: z.array(z.string()), status: z.string() })
        .parse(await request.json().catch(() => ({})));

      try {
        return json({ updated: db.bulkSetStatus(connection(), body.fullnames, body.status) });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }

    if (method === "POST" && path === "/snooze/undo") {
      const body = await objectBody(request, SnoozeUndoBody);

      if (Number.isInteger(body.snoozed_wave))
        return json(
          db.unsnooze(connection(), { snoozedWave: Number(body.snoozed_wave), apply: true }),
        );

      if (Number.isInteger(body.decayed_at)) {
        const wave = Number(body.decayed_at);

        return json(
          db.undecay(connection(), { decayedAfter: wave, decayedBefore: wave + 1, apply: true }),
        );
      }

      return json({ error: "snoozed_wave or decayed_at required" }, 400);
    }

    if (method === "POST" && path === "/resurface/dismiss") {
      const body = await objectBody(request, ClusterBody);

      try {
        resurface.dismiss(connection(), body.cluster);

        return new Response(null, { status: 204 });
      } catch {
        return json({ error: "unknown cluster" }, 400);
      }
    }

    if (method === "POST" && path === "/resurface/letgo") {
      const body = await objectBody(request, ClusterBody);

      try {
        return json(resurface.letgo(connection(), body.cluster));
      } catch {
        return json({ error: "unknown cluster" }, 400);
      }
    }

    if (method === "POST" && path === "/resurface/letgo/undo") {
      const body = await objectBody(request, ClusterUndoBody);

      try {
        return json(resurface.undoLetgo(connection(), body.cluster, body.decayed_at));
      } catch {
        return json({ error: "unknown cluster" }, 400);
      }
    }

    if (method === "POST" && path === "/duplicates/resolve") {
      const body = await objectBody(request, DuplicateResolveBody);

      return json(dedup.resolveGroup(connection(), body.keep, body.archive));
    }

    if (method === "POST" && path === "/duplicates/undo") {
      const body = await objectBody(request, DuplicateUndoBody);

      return json(dedup.undoResolve(connection(), body.fullnames));
    }

    if (method === "POST" && path === "/tag-suggestions/accept-all") {
      const body = await objectBody(request, TagFilterBody);

      return json({
        accepted: tagSuggest.acceptAllSuggestions(connection(), { tag: body.tag || undefined }),
      });
    }

    if (method === "POST" && path === "/tag-suggestions/reject-all") {
      const body = await objectBody(request, TagFilterBody);

      return json({
        rejected: tagSuggest.rejectAllSuggestions(connection(), { tag: body.tag || undefined }),
      });
    }

    const suggestion = /^\/tag-suggestions\/(\d+)\/(accept|reject)$/.exec(path);

    if (method === "POST" && suggestion) {
      const result =
        suggestion[2] === "accept"
          ? tagSuggest.acceptSuggestion(connection(), Number(suggestion[1]))
          : tagSuggest.rejectSuggestion(connection(), Number(suggestion[1]));

      return result ? json(result) : json({ error: "not found or not pending" }, 404);
    }

    if (method === "POST" && path === "/folders") {
      const body = await objectBody(request, CreateFolderBody);
      const name = body.name.trim();

      if (!name) return json({ error: "name required" }, 400);
      const queryDef = body.query_def ?? null;

      try {
        return json(db.createFolder(connection(), name, queryDef, body.description ?? ""), 201);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 409);
      }
    }

    const folder = /^\/folders\/(\d+)$/.exec(path);

    if (method === "PATCH" && folder) {
      const body = await objectBody(request, RenameFolderBody);

      try {
        const result = db.renameFolder(connection(), Number(folder[1]), body.name);

        return result ? json(result) : json({ error: "not found" }, 404);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 409);
      }
    }

    if (method === "DELETE" && folder)
      return db.deleteFolder(connection(), Number(folder[1]))
        ? json({ deleted: Number(folder[1]) })
        : json({ error: "not found" }, 404);

    if (method === "PATCH" && itemRoute?.action === "folder") {
      const body = await objectBody(request, FolderBody);
      const value = body.folder ?? null;

      return db.setItemFolder(connection(), itemRoute.fullname, value)
        ? json({ fullname: itemRoute.fullname, folder: value })
        : json({ error: "not found" }, 404);
    }

    if (method === "POST" && path === "/folders/evaluate") {
      const body = await objectBody(request, EvaluateFoldersBody);

      if (body.folder_id !== undefined) {
        const id = numberValue(body.folder_id, Number.NaN);

        if (!Number.isInteger(id)) return json({ error: "folder_id must be an integer" }, 400);
        const result = folders.evaluateFolder(connection(), id);

        return json({ results: Array.isArray(result) ? result : [result] });
      }

      return json({ results: folders.evaluateAllFolders(connection()) });
    }

    if (method === "GET" && path === "/settings/done-retention") {
      const database = connection();
      const stored = Number(db.getSetting(database, "done_retention_days", "30") ?? "30");
      const retentionDays = Number.isFinite(stored) && stored >= 1 && stored <= 3650 ? stored : 30;

      if (retentionDays !== stored) db.setSetting(database, "done_retention_days", "30");
      const now = Math.floor(Date.now() / 1000);

      return json({ retention_days: retentionDays, preview: db.purgeDone(database, { now }), now });
    }

    if (method === "POST" && path === "/settings/done-retention") {
      const body = RetentionBody.parse(await request.json().catch(() => ({})));
      const database = connection();
      const now = Math.floor(Date.now() / 1000);
      db.setSetting(database, "done_retention_days", String(body.retention_days));

      return json({
        retention_days: body.retention_days,
        preview: db.purgeDone(database, { now }),
        now,
      });
    }

    if (method === "POST" && path === "/settings/done-retention/purge") return purgeDone(request);

    if (method === "POST" && path === "/reddit/unsave/enable") {
      const body = await objectBody(request, EnabledBody);
      const enabled = body.enabled;
      db.setSetting(connection(), "reddit_unsave_on_done", enabled ? "1" : "0");

      return json({ enabled });
    }

    if (method === "POST" && path === "/reddit/unsave/auth") {
      const body = await objectBody(request, CookieBody);
      const cookie = body.cookie.trim();

      if (!cookie) return json({ ok: false, error: "paste your reddit_session cookie" }, 400);

      try {
        return json({ ok: true, username: await redditUnsave.login(connection(), cookie) });
      } catch (error) {
        return json(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          400,
        );
      }
    }

    if (method === "POST" && path === "/reddit/unsave/drain") return drainUnsave(request);

    if (method === "POST" && path === "/reddit/unsave/enqueue-by-tag")
      return enqueueUnsaveByTag(request);

    if (method === "POST" && path === "/reddit/sync") {
      const body = await objectBody(request, RedditSyncBody);
      const full = body.full ?? false;
      const pages = clamp(numberValue(body.max_pages, 0) || (full ? 50 : 3), 1, 200);

      return json(
        await redditSync.syncSaved(connection(), { maxPages: pages, stopOnKnown: !full }),
      );
    }

    if (method === "POST" && path === "/reddit/sync/auto") {
      const database = connection();

      if (!redditSync.isAutosyncEnabled(database)) return json({ skipped: "disabled" });

      return json(await redditSync.autoSync(database));
    }

    if (method === "POST" && path === "/import/firefox-tabs") return importFirefoxTabs(request);

    if (method === "POST" && path === "/import/prepare") return prepareImport(request);

    if (method === "POST" && path === "/import/commit") return commitImport(request);

    if (method === "POST" && path === "/import") return importUpload(request);
  } catch (error) {
    if (error instanceof z.ZodError)
      return json(
        {
          error: error.issues
            .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
            .join("; "),
        },
        400,
      );

    if (error instanceof SyntaxError) return json({ error: "invalid request body" }, 400);

    return json({ error: error instanceof Error ? error.message : "request failed" }, 500);
  }

  return json({ error: "not found" }, 404);
}

async function purgeDone(request: Request): Promise<Response> {
  const body = await objectBody(request, PurgeBody);
  const expectedTotal = numberValue(body.expected_total, -1);
  const expectedCutoff = numberValue(body.expected_cutoff, -1);

  if (expectedTotal < 0 || expectedCutoff < 0)
    return json({ error: "expected_total and expected_cutoff are required" }, 400);
  const database = connection();
  const now = Math.floor(Date.now() / 1000);
  const plan = db.purgeDone(database, { now });

  if (plan.total !== expectedTotal || plan.cutoff !== expectedCutoff)
    return json(
      { error: "purge preview changed; review the updated count before deleting", preview: plan },
      409,
    );

  if (!plan.total)
    return json({ error: "no Done items currently qualify for purge", preview: plan }, 409);

  const victims = database
    .query(
      "SELECT fullname, source, title FROM items WHERE status='done' AND processed_utc IS NOT NULL AND processed_utc < ? ORDER BY processed_utc",
    )
    .all(plan.cutoff)
    .map((row) => PurgeVictimSchema.parse(row));

  const backupPath = join(
    dirname(databasePath()),
    `app.backup-pre-purge-done-${new Date().toISOString().replaceAll(":", "-")}.db`,
  );

  await Bun.write(backupPath, database.serialize());
  const purged = db.purgeDone(database, { now, apply: true });
  const preview = db.purgeDone(database, { now });

  const audit = {
    ts: Math.floor(Date.now() / 1000),
    op: "purge_done",
    retention_days: purged.retention_days,
    cutoff: purged.cutoff,
    total: purged.total,
    threads_deleted: purged.threads_deleted,
    backup: backupPath,
    victims: victims.slice(0, 200).map((row) => ({
      fullname: row.fullname,
      source: row.source,
      title: row.title.slice(0, 80),
    })),
  };

  appendFileSync(join(dirname(databasePath()), "delete-audit.jsonl"), `${JSON.stringify(audit)}\n`);

  return json({ purged: { ...purged, backup: backupPath }, preview });
}

async function drainUnsave(request: Request): Promise<Response> {
  const body = await objectBody(request, DrainBody);
  const database = connection();
  const limit = clamp(numberValue(body.max ?? body.limit, 50), 1, 500);
  const live = bool(body.live);
  const confirmed = bool(body.confirm) || bool(body.yes);

  if (!live || !confirmed) {
    const result = await redditUnsave.drain(database, { limit, dryRun: true });
    const remaining = Math.max(redditUnsave.countPending(database) - result.selected, 0);

    if (live)
      return json(
        {
          ...result,
          remaining,
          live_required: ["live", "confirm"],
          ok: false,
          error: "live drain requires confirm=true or yes=true",
        },
        409,
      );

    return json({ ...result, remaining, live_required: ["live", "confirm"] });
  }

  const [audit] = redditUnsave.auditAppender(databasePath());

  return json(await redditUnsave.drain(database, { limit, dryRun: false, audit }));
}

async function enqueueUnsaveByTag(request: Request): Promise<Response> {
  const body = await objectBody(request, EnqueueTagBody);
  const tag = body.tag.trim();

  if (!tag) return json({ error: "tag required" }, 400);
  const requested = bool(body.apply) || bool(body.confirm);
  const apply = requested && bool(body.yes);
  const result = db.enqueueUnsaveByTag(connection(), tag, { dryRun: !apply });

  const common = {
    ...result,
    confirmed: apply,
    confirmation_required: ["apply", "yes"],
    message:
      "This only queues local unsaves. Reddit is not contacted until the existing explicit drain action runs.",
  };

  return requested && !apply
    ? json({ ...common, ok: false, error: "local by-tag enqueue requires yes=true" }, 409)
    : json(common);
}

async function importFirefoxTabs(request: Request): Promise<Response> {
  const raw = z.json().safeParse(await request.json().catch(() => null));

  if (!raw.success) return json({ error: "invalid payload" }, 400);
  const validation = firefoxTabs.validatePayload(raw.data);

  if (validation.error || !validation.payload)
    return json({ error: validation.error ?? "invalid payload" }, 400);
  const database = connection();

  if (!firefoxTabs.tokenConfigured(database))
    return json({ error: "firefox ingest token is not configured" }, 503);
  const authorization = request.headers.get("authorization") ?? "";

  const token = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : (request.headers.get("x-content-hoarder-token")?.trim() ?? "");

  if (!token) return json({ error: "missing token" }, 401);

  if (!firefoxTabs.verifyToken(database, token)) return json({ error: "invalid token" }, 403);

  return json(firefoxTabs.ingestSnapshot(database, validation.payload));
}

async function importUpload(request: Request): Promise<Response> {
  const form = await request.formData();
  const file = form.get("file");

  if (!(file instanceof File) || !file.size) return json({ error: "no file uploaded" }, 400);

  const path = join(
    tmpdir(),
    `content-hoarder-${randomBytes(12).toString("hex")}${extname(file.name) || ".dat"}`,
  );

  await Bun.write(path, file);
  const rawSource = z.string().safeParse(form.get("source"));

  try {
    const result = await importPath(connection(), path, {
      source: rawSource.success ? rawSource.data : undefined,
    });

    return json({
      imported: result.imported,
      skipped: result.skipped,
      errors: result.errors.slice(0, 20),
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  } finally {
    try {
      unlinkSync(path);
    } catch {
      /* staged file is already gone */
    }
  }
}

async function prepareImport(request: Request): Promise<Response> {
  cleanPrepared();
  let stagedPath = "";
  let source: string | undefined;
  let url = "";

  if (request.headers.get("content-type")?.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    const rawSource = z.string().safeParse(form.get("source"));
    source = rawSource.success ? rawSource.data : undefined;

    if (file instanceof File && file.size) {
      stagedPath = join(
        tmpdir(),
        `content-hoarder-${randomBytes(12).toString("hex")}${extname(file.name) || ".dat"}`,
      );
      await Bun.write(stagedPath, file);
    }

    const rawUrl = z.string().safeParse(form.get("url"));
    url = rawUrl.success ? rawUrl.data.trim() : "";
  } else {
    const body = PrepareImportBody.parse(await request.json().catch(() => ({})));
    url = body.url?.trim() ?? "";
    source = body.source;
  }

  if (!stagedPath && url) {
    if (!/^https?:\/\/(?:[\w.-]*\.)?(?:youtube\.com|youtu\.be)\//i.test(url))
      return json({ error: "Only YouTube playlist or video URLs are supported here." }, 400);

    try {
      const youtubeImport = await resolveYouTubeUrl(url);
      stagedPath = join(tmpdir(), `content-hoarder-${randomBytes(12).toString("hex")}.json`);
      await Bun.write(stagedPath, JSON.stringify(youtubeImport));
      source = "youtube";
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  if (!stagedPath) return json({ error: "Provide a file or a YouTube URL." }, 400);

  try {
    const connector = source ? get(source) : dispatch(stagedPath);
    const items = connector.importFile(stagedPath);

    if (!items.length) {
      unlinkSync(stagedPath);

      return json({ error: "No importable items found in that input." }, 400);
    }

    const names = [...new Set(items.map((item) => item.fullname))];
    const database = connection();
    let existing = 0;

    for (let offset = 0; offset < names.length; offset += 500) {
      const chunk = names.slice(offset, offset + 500);
      const placeholders = chunk.map(() => "?").join(",");

      const countRow = ExistingCountSchema.safeParse(
        database
          .query(`SELECT COUNT(*) AS count FROM items WHERE fullname IN (${placeholders})`)
          .get(...chunk),
      );

      existing += countRow.success ? countRow.data.count : 0;
    }

    const token = randomBytes(18).toString("base64url");
    prepared.set(token, {
      path: stagedPath,
      source: connector.id,
      expires: Date.now() + RETENTION_SECONDS * 1000,
    });

    const sample = items.slice(0, 5).map((item) => ({
      title: (item.title || item.url || item.fullname).slice(0, 120),
      source: item.source,
    }));

    return json({
      token,
      count: names.length,
      new: Math.max(names.length - existing, 0),
      source: connector.id,
      label: connector.label,
      sample,
    });
  } catch (error) {
    try {
      unlinkSync(stagedPath);
    } catch {
      /* parser cleanup */
    }

    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
}

async function commitImport(request: Request): Promise<Response> {
  cleanPrepared();
  const body = CommitImportBody.parse(await request.json().catch(() => ({})));
  const token = body.token?.trim() ?? "";
  const staged = prepared.get(token);

  if (!staged) return json({ error: "this import preview expired — please preview again" }, 400);
  prepared.delete(token);

  try {
    const result = await importPath(connection(), staged.path, { source: staged.source });

    return json({
      imported: result.imported,
      skipped: result.skipped,
      errors: result.errors.slice(0, 20),
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  } finally {
    try {
      unlinkSync(staged.path);
    } catch {
      /* staged file is already gone */
    }
  }
}

export interface ServeOptions {
  dbPath?: string;
  host?: string;
  port?: number;
  tls?: boolean;
}

export async function serveApp(
  value: ServeOptions | string = {},
): Promise<{ port: number; stop: () => Promise<void> }> {
  const parsedPath = z.string().safeParse(value);

  const options = parsedPath.success
    ? { dbPath: parsedPath.data }
    : ServeOptionsSchema.parse(value);

  selectedDbPath = options.dbPath ? resolve(options.dbPath) : undefined;
  connection();
  cleanPrepared();
  const host = options.host ?? config.host();
  const port = options.port ?? config.port();

  const intervalMs =
    numberParam(config.get("REDDIT_AUTOSYNC_INTERVAL") ?? null, 600) * 1000 || 600_000;

  const scheduler = redditSync.isAutosyncEnabled(connection())
    ? new redditSync.SyncScheduler(() => connection(), intervalMs).start()
    : null;

  // The drainer opens its own connection per fire (never the shared request
  // one, which it closes) and re-checks the opt-in before draining.
  const tricklePath = databasePath();
  const [trickleAudit] = redditUnsave.auditAppender(tricklePath);

  unsaveTrickle = new TrickleDrainer(() => db.connect(tricklePath), { audit: trickleAudit });

  const server: Server<undefined> = options.tls
    ? serve({
        fetch: handle,
        hostname: host,
        port,
        idleTimeout: 120,
        tls: {
          cert: readFileSync(join(import.meta.dir, "..", "cert.pem")),
          key: readFileSync(join(import.meta.dir, "..", "key.pem")),
        },
      })
    : serve({ fetch: handle, hostname: host, port, idleTimeout: 120 });

  return {
    port: server.port ?? port,
    stop: async () => {
      server.stop(true);
      scheduler?.stop();
      unsaveTrickle?.stop();
      unsaveTrickle = null;
      activeDatabase?.close();
      activeDatabase = undefined;
      activeDatabasePath = undefined;
      selectedDbPath = undefined;

      for (const item of prepared.values())
        try {
          unlinkSync(item.path);
        } catch {
          /* staged file was already removed */
        }

      prepared.clear();
    },
  };
}
