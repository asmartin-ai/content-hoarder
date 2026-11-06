import { basename } from "node:path";
import { z } from "zod";
import * as db from "../db.ts";
import { parse } from "../search_query.ts";
import { REGISTRY } from "../connectors/registry.ts";
import * as categorize from "../categorize.ts";
import * as resurface from "../resurface.ts";
import * as tagSuggest from "../tag_suggest.ts";
import * as folders from "../folders.ts";
import * as dedup from "../dedup.ts";
import * as redditSync from "../reddit_sync.ts";
import * as redditUnsave from "../reddit_unsave.ts";
import * as redditHydrate from "../reddit_hydrate.ts";
import * as redditThread from "../reddit_thread.ts";
import * as hnThread from "../hn_thread.ts";
import * as exportModule from "../export.ts";
import * as mediaStore from "../media_store.ts";
import { isAutosyncEnabled } from "../sync/scheduler.ts";
import { gate, hostedOrigin, ownerOnlyPath, sessionSub } from "../hosted.ts";
import { guard } from "./guard.ts";
import { libraryPage, serviceWorkerResponse, staticResponse } from "./static.ts";
import {
  clamp,
  json,
  numberParam,
  numberValue,
  objectBody,
  options,
  redditView,
  requestItem,
  requestZone,
} from "./http.ts";
import { connection, libraryConnection, mainConnection, withLibrary } from "./state.ts";
import {
  ClientEventsBody,
  MAX_CLIENT_BODY_BYTES,
  demoAnalyticsOn,
  recordClientEvents,
} from "../demo_analytics.ts";
import { handleBulkStatus, handleItemAction } from "./handlers/items.ts";
import {
  commitImport,
  importFirefoxTabs,
  importUpload,
  prepareImport,
} from "./handlers/imports.ts";
import {
  aiSettings,
  drainUnsave,
  enqueueUnsaveByTag,
  purgeDone,
  settingsPage,
  updateAiSettings,
} from "./handlers/settings.ts";
import { applySweep, listSweeps, undoSweep } from "./handlers/sweeps.ts";
import { clearHints, clearPage, deal } from "./handlers/clear.ts";
import { addPage, onboardingSeen, pullStatus } from "./handlers/add.ts";
import { youtubeRoute } from "./handlers/youtube.ts";
import { handleVideoExport, handleVideoPrepare } from "./handlers/video.ts";
import { homePage } from "./handlers/home.ts";
import {
  googleCallback,
  googleStart,
  invitePage,
  landingPage,
  loginPage,
  logout,
  privacyPage,
  twitchCallback,
  twitchStart,
} from "./handlers/auth.ts";
import {
  applyPile,
  dismissWhisper,
  letgoWhisper,
  piles,
  todayPage,
  undoPile,
  undoWhisper,
  upNext,
  whisper,
  wins,
} from "./handlers/today.ts";
import {
  ClusterBody,
  ClusterUndoBody,
  CookieBody,
  CreateFolderBody,
  DuplicateResolveBody,
  DuplicateUndoBody,
  EnabledBody,
  EvaluateFoldersBody,
  FolderBody,
  RedditSyncBody,
  RenameFolderBody,
  RetentionBody,
  SearchCountSchema,
  SnoozeUndoBody,
  TagFilterBody,
} from "./schemas.ts";

async function hostedRoute(
  request: Request,
  method: string,
  path: string,
): Promise<Response | null> {
  if (method === "GET" && path === "/" && !sessionSub(mainConnection(), request))
    return landingPage();

  const blocked = gate(mainConnection(), request);

  if (blocked) return blocked;

  if (method === "GET" && path.startsWith("/invite/"))
    return invitePage(decodeURIComponent(path.slice("/invite/".length)));

  if (method === "GET" && path === "/auth/login") return loginPage(request);

  if (method === "POST" && path === "/auth/logout") return logout(request);

  if (method === "POST" && path === "/onboarding/seen") {
    const sub = sessionSub(mainConnection(), request);

    return sub ? onboardingSeen(libraryConnection(sub)) : json({ error: "sign in" }, 401);
  }

  if (method === "GET" && path === "/privacy") return privacyPage();

  if (method === "GET" && path === "/oauth/google/start") return googleStart(request);

  if (method === "GET" && path === "/oauth/google/callback") return googleCallback(request);

  if (method === "GET" && path === "/oauth/twitch/start") return twitchStart(request);

  if (method === "GET" && path === "/oauth/twitch/callback") return twitchCallback(request);

  return null;
}

export async function handle(request: Request): Promise<Response> {
  try {
    return await route(request);
  } catch (error) {
    if (error instanceof URIError) return json({ error: "not found" }, 404);

    throw error;
  }
}

async function route(request: Request): Promise<Response> {
  const forbidden = guard(request);

  if (forbidden) return forbidden;

  if (!hostedOrigin()) return appRoute(request);

  const path = new URL(request.url).pathname;

  const hosted = await hostedRoute(request, request.method, path);

  if (hosted) return hosted;

  if (ownerOnlyPath(path)) return json({ error: "not found" }, 404);

  const sub = sessionSub(mainConnection(), request);

  if (sub) {
    const youtube = await youtubeRoute(request, sub, request.method, path);

    if (youtube) return youtube;
  }

  return sub ? withLibrary(libraryConnection(sub), () => appRoute(request)) : appRoute(request);
}

async function collectEvents(request: Request): Promise<Response> {
  if (!demoAnalyticsOn()) return new Response(null, { status: 204 });

  const declared = Number(request.headers.get("content-length") ?? "");

  if (Number.isFinite(declared) && declared > MAX_CLIENT_BODY_BYTES)
    return json({ error: "event batch too large" }, 413);

  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;

  if (reader) {
    try {
      for (;;) {
        const chunk = await reader.read();

        if (chunk.done) break;

        size += chunk.value.byteLength;

        if (size > MAX_CLIENT_BODY_BYTES) {
          await reader.cancel().catch(() => {});

          return json({ error: "event batch too large" }, 413);
        }

        text += decoder.decode(chunk.value, { stream: true });
      }

      text += decoder.decode();
    } catch {
      return json({ error: "invalid event batch" }, 400);
    }
  }

  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return json({ error: "invalid event batch" }, 400);
  }

  const body = ClientEventsBody.safeParse(value);

  if (!body.success) return json({ error: "invalid event batch" }, 400);

  recordClientEvents(connection(), body.data);

  return new Response(null, { status: 204 });
}

async function appRoute(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === "GET" && path === "/triage") return Response.redirect("/clear", 302);

  if (method === "GET" && path === "/reddit")
    return Response.redirect("/library?source=reddit", 302);

  if (method === "GET" && (path.startsWith("/static/") || path === "/manifest.webmanifest"))
    return staticResponse(path);

  if (method === "GET" && path === "/sw.js") return serviceWorkerResponse();

  if (method === "GET" && path === "/") return todayPage(request, url);

  if (method === "GET" && path === "/home") return homePage(request);

  if (method === "GET" && path === "/clear") return clearPage();

  if (method === "GET" && path === "/add") return addPage(request, url);

  if (method === "GET" && path === "/settings") return settingsPage(request);

  if (method === "GET" && (path === "/library" || path === "/browse")) return libraryPage();

  try {
    if (method === "GET" && path === "/clear/deal") return deal(url);

    if (method === "GET" && path === "/clear/hints") return clearHints(url);

    if (method === "POST" && path === "/events") return await collectEvents(request);

    if (method === "GET" && path === "/hx/today/upnext") return upNext(request, url);

    if (method === "GET" && path === "/hx/today/wins") return wins(request);

    if (method === "GET" && path === "/hx/today/piles") return piles();

    if (method === "GET" && path === "/hx/today/whisper") return whisper();

    if (method === "GET" && path === "/hx/add/pull") return pullStatus();

    if (method === "POST" && path === "/hx/sweeps/apply") return await applyPile(request);

    if (method === "POST" && path === "/hx/sweeps/undo") return await undoPile(request);

    if (method === "POST" && path === "/hx/whisper/dismiss") return await dismissWhisper(request);

    if (method === "POST" && path === "/hx/whisper/letgo") return await letgoWhisper(request);

    if (method === "POST" && path === "/hx/whisper/undo") return await undoWhisper(request);

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

    const videoMatch = /^\/(?:api\/)?(?:reddit\/)?items\/(.+?)\/video\.mp4$/.exec(path);

    if ((method === "GET" || method === "HEAD") && videoMatch) {
      let fullname: string;

      try {
        fullname = decodeURIComponent(videoMatch[1] ?? "");
      } catch {
        return json({ error: "not_found" }, 404);
      }

      return handleVideoExport(request, fullname);
    }

    const videoPrepareMatch = /^\/(?:api\/)?(?:reddit\/)?items\/(.+?)\/video\/prepare$/.exec(path);

    if (method === "POST" && videoPrepareMatch) {
      let fullname: string;

      try {
        fullname = decodeURIComponent(videoPrepareMatch[1] ?? "");
      } catch {
        return json({ error: "not_found" }, 404);
      }

      return handleVideoPrepare(fullname);
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

    if (method === "GET" && path === "/pulse")
      return json(db.pulse(connection(), { zone: requestZone(request) }));

    if (method === "GET" && path === "/sweeps") return listSweeps(url);

    if (method === "POST" && path === "/sweeps/apply") return await applySweep(request);

    if (method === "POST" && path === "/sweeps/undo") return await undoSweep(request);

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

      if (!result) return json({ error: "not found", hydrate_status: hydrated?.status }, 404);

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
          "Cache-Control": "private, max-age=31536000, immutable",
        },
      });
    }

    if (itemRoute && method === "POST" && itemRoute.action) {
      const response = await handleItemAction(request, path, itemRoute);

      if (response) return response;
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

    if (method === "POST" && path === "/bulk/status") return handleBulkStatus(request);

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

    if (method === "GET" && path === "/settings/ai") return aiSettings();

    if (method === "POST" && path === "/settings/ai") return await updateAiSettings(request);

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

      if (!isAutosyncEnabled(database)) return json({ skipped: "disabled" });

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

    if (error instanceof URIError) return json({ error: "not found" }, 404);

    return json({ error: error instanceof Error ? error.message : "request failed" }, 500);
  }

  return json({ error: "not found" }, 404);
}
