import { z } from "zod";
import type { RedditReconcileResult } from "./db.ts";
import type { Database } from "bun:sqlite";
import * as db from "./db.ts";
import * as oauth from "./reddit_oauth.ts";
import * as unsave from "./reddit_unsave.ts";
import { jitteredThrottle, MIN_THROTTLE } from "./_http.ts";
import { childToItem } from "./connectors/reddit.ts";
import { setAutosyncEnabled } from "./sync/scheduler.ts";

export const SAVED_URL = "https://www.reddit.com/user/{user}/saved.json";

const MARK_KEY = "reddit_sync_newest";

const MARK_DEPTH = 25;

const LAST_RUN_KEY = "reddit_autosync_last_run";

const LAST_RECON_KEY = "reddit_autosync_last_reconcile";

export const MIN_RUN_INTERVAL = 90;

export const RECONCILE_INTERVAL = 6 * 3600;

export const RECONCILE_MAX_PAGES = 60;

const LEGACY_CAP_LO = 990;

const LEGACY_CAP_HI = 1010;

function loadMark(value: string | null): string[] {
  if (!value) return [];
  const text = value.trim();

  if (!text.startsWith("[")) return [text];

  try {
    const parsed: unknown = JSON.parse(text);

    return z.array(z.string()).catch([]).parse(parsed).filter(Boolean);
  } catch {
    return [];
  }
}

const SavedPageSchema = z.object({
  data: z
    .object({
      children: z.array(z.json()),
      after: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

export interface SyncOptions {
  maxPages?: number;
  stopOnKnown?: boolean;
  perPage?: number;
  throttle?: number;
  sleep?: (seconds: number) => Promise<void> | void;
  getf?: unsave.Get;
  userAgent?: string;
  progress?: (message: string) => void;
  reconcile?: boolean;
  reconcileDryRun?: boolean;
}

export interface ReconcileStatus {
  ran: boolean;
  present: number;
  skipped?: string;
  stopped?: string;
  by_kind?: RedditReconcileResult;
  dry_run?: boolean;
  unsaved?: number;
  promoted_done?: number;
}

export interface SyncResult {
  fetched: number;
  new: number;
  updated: number;
  pages: number;
  stopped: string | null;
  auth_error: boolean;
  network_error: boolean;
  username: string | null;
  transport: "cookie" | "oauth" | null;
  reconcile?: ReconcileStatus;
}

export async function syncSaved(database: Database, opts: SyncOptions = {}): Promise<SyncResult> {
  let stopOnKnown = opts.stopOnKnown ?? true;
  const reconcile = opts.reconcile ?? false;

  if (reconcile) stopOnKnown = false;
  const sleep = opts.sleep ?? (async (seconds) => Bun.sleep(seconds * 1000));
  const userAgent = opts.userAgent ?? unsave.cookieUserAgent();
  const throttle = Math.max(opts.throttle ?? 1, MIN_THROTTLE);
  const maxPages = Math.max(0, Math.trunc(opts.maxPages ?? 3));
  const perPage = Math.max(1, Math.trunc(opts.perPage ?? 100));

  const result: SyncResult = {
    fetched: 0,
    new: 0,
    updated: 0,
    pages: 0,
    stopped: null,
    auth_error: false,
    network_error: false,
    username: null,
    transport: null,
  };

  const present: Record<"post" | "comment", Set<string>> = { post: new Set(), comment: new Set() };
  let oauthToken: string | null = null;
  let username: string | null = null;
  let ua = userAgent;
  let base = "";
  let auth: unsave.RedditAuth | null = null;

  if (!opts.getf && oauth.isConfigured(database)) {
    oauthToken = await oauth.accessToken(database);

    if (oauthToken) {
      username = oauth.status(database).username ?? (await oauth.fetchUsername(oauthToken));

      if (username) {
        ua = oauth.oauthUserAgent(database, username);
        base = `https://oauth.reddit.com/user/${encodeURIComponent(username)}/saved`;
        result.transport = "oauth";
      } else if (!unsave.getAuth(database)) {
        result.auth_error = true;
        result.stopped = "auth_error";

        return result;
      } else oauthToken = null;
    }
  }

  if (!oauthToken) {
    ua = userAgent;
    auth = unsave.getAuth(database);

    if (!auth) {
      result.auth_error = true;
      result.stopped = "auth_error";

      return result;
    }

    username = auth.username;

    if (!username) {
      try {
        [, username] = await unsave.refreshModhash(auth.session_cookie, {
          userAgent: ua,
          getf: opts.getf,
        });
      } catch (error) {
        result[error instanceof unsave.RedditAuthError ? "auth_error" : "network_error"] = true;
        result.stopped = error instanceof unsave.RedditAuthError ? "auth_error" : "network_error";

        return result;
      }
    }

    base = `https://www.reddit.com/user/${encodeURIComponent(username)}/saved.json`;
    result.transport = "cookie";
  }

  result.username = username;
  const marks = loadMark(db.getSetting(database, MARK_KEY));
  const markSet = new Set(marks);
  const topNames: string[] = [];
  const synced: string[] = [];
  let after = "";
  let hitMark = false;
  const snapshotUtc = Math.floor(Date.now() / 1000);

  for (let page = 0; page < maxPages; page++) {
    if (page) await sleep(jitteredThrottle(throttle));
    const params = new URLSearchParams({ limit: String(perPage), raw_json: "1" });

    if (after) params.set("after", after);
    let body: unknown;

    try {
      body = oauthToken
        ? await oauth.oauthGet(`${base}?${params}`, { bearer: oauthToken, userAgent: ua })
        : await (opts.getf ?? unsave.httpGet)(`${base}?${params}`, {
            session_cookie: auth?.session_cookie ?? "",
            user_agent: ua,
            sleep,
          });
    } catch {
      result.network_error = true;
      result.stopped = "network_error";
      break;
    }

    const response = SavedPageSchema.safeParse(body);

    if (!response.success || !response.data.data) {
      result.auth_error = true;
      result.stopped = "auth_error";
      break;
    }

    const { children, after: next } = response.data.data;

    if (!children.length) {
      result.stopped = page === 0 ? "empty" : "exhausted";
      break;
    }

    result.pages++;
    let pageNew = 0;

    for (const child of children) {
      const item = childToItem(child, { savedSeenUtc: snapshotUtc });

      if (!item) continue;
      const name = item.fullname.slice("reddit:".length);

      if (topNames.length < MARK_DEPTH && !topNames.includes(name)) topNames.push(name);

      if (reconcile) present[item.kind === "post" ? "post" : "comment"].add(name);

      if (markSet.has(name) && !reconcile) {
        hitMark = true;
        break;
      }

      result.fetched++;

      if (db.mergeUpsert(database, item) === "inserted") {
        result.new++;
        pageNew++;
      } else result.updated++;
      synced.push(item.fullname);
    }

    opts.progress?.(`page ${page + 1}: +${pageNew} new (${children.length} items)`);

    if (hitMark) {
      result.stopped = "caught_up";
      break;
    }

    if (!next) {
      result.stopped = "exhausted";
      break;
    }

    after = next;

    if (stopOnKnown && !marks.length && pageNew === 0) {
      result.stopped = "all_known";
      break;
    }
  }

  if (result.stopped === null) result.stopped = "max_pages";

  if (synced.length) {
    const top = db.allocateSavedOrder(database, synced.length);
    synced.forEach((fullname, index) =>
      database.query("UPDATE items SET saved_utc=? WHERE fullname=?").run(top - index, fullname),
    );
  }

  if (
    topNames.length &&
    (!marks.length || ["caught_up", "exhausted", "all_known"].includes(String(result.stopped)))
  )
    db.setSetting(database, MARK_KEY, JSON.stringify(topNames));

  if (reconcile)
    result.reconcile = reconcilePresent(
      database,
      present,
      String(result.stopped),
      opts.reconcileDryRun ?? false,
    );

  return result;
}

function reconcilePresent(
  database: Database,
  presentByKind: Record<"post" | "comment", Set<string>>,
  stopped: string,
  dryRun: boolean,
): ReconcileStatus {
  const total = presentByKind.post.size + presentByKind.comment.size;

  if (stopped !== "exhausted" && stopped !== "empty")
    return { ran: false, skipped: "incomplete_walk", stopped, present: total };

  if (total >= LEGACY_CAP_LO && total <= LEGACY_CAP_HI)
    return { ran: false, skipped: "ambiguous_cap", present: total };

  const result: RedditReconcileResult = db.reconcileRedditSaves(database, presentByKind, {
    dryRun,
    truncatedByKind: { post: false, comment: false },
  });

  const fullnames = [...result.post.fullnames, ...result.comment.fullnames];
  let promoted = 0;

  for (const fullname of dryRun ? [] : fullnames) {
    const row = z
      .object({ status: z.string() })
      .safeParse(database.query("SELECT status FROM items WHERE fullname=?").get(fullname));

    if (row.success && row.data.status === "inbox") {
      db.setStatus(database, fullname, "done", { queueUnsave: false });
      promoted++;
    }
  }

  return {
    ran: true,
    present: total,
    by_kind: result,
    dry_run: dryRun,
    unsaved: fullnames.length,
    promoted_done: promoted,
  };
}

function asInt(value: string | null, fallback = 0): number {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

export type AutoSyncResult =
  | { skipped: "debounced"; since_last: number; mode: null }
  | { mode: "reconcile" | "incremental"; result: SyncResult; transport: SyncResult["transport"] };

export async function autoSync(
  database: Database,
  opts: {
    now?: number;
    force?: boolean;
    reconcileDryRun?: boolean;
    minInterval?: number;
    reconcileInterval?: number;
    getf?: unsave.Get;
    sleep?: SyncOptions["sleep"];
    userAgent?: string;
    progress?: (message: string) => void;
  } = {},
): Promise<AutoSyncResult> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const sinceLast = now - asInt(db.getSetting(database, LAST_RUN_KEY));

  if (!opts.force && sinceLast < (opts.minInterval ?? MIN_RUN_INTERVAL))
    return { skipped: "debounced", since_last: sinceLast, mode: null };

  const due =
    Boolean(opts.force) ||
    now - asInt(db.getSetting(database, LAST_RECON_KEY)) >=
      (opts.reconcileInterval ?? RECONCILE_INTERVAL);

  const result = await syncSaved(database, {
    reconcile: due,
    reconcileDryRun: opts.reconcileDryRun,
    maxPages: due ? RECONCILE_MAX_PAGES : 3,
    stopOnKnown: !due,
    getf: opts.getf,
    sleep: opts.sleep,
    userAgent: opts.userAgent,
    progress: opts.progress,
  });

  if (due && !opts.reconcileDryRun && result.reconcile?.ran)
    db.setSetting(database, LAST_RECON_KEY, String(now));
  db.setSetting(database, LAST_RUN_KEY, String(now));

  return { mode: due ? "reconcile" : "incremental", result, transport: result.transport };
}

export interface SyncOptionsForCli extends SyncOptions {
  full?: boolean;
  enableAuto?: boolean;
  disableAuto?: boolean;
  reconcileDryRun?: boolean;
}

export async function sync(
  database: Database,
  opts: SyncOptionsForCli = {},
  progress?: (message: string) => void,
): Promise<SyncResult> {
  if (opts.enableAuto) setAutosyncEnabled(database, true);

  if (opts.disableAuto) setAutosyncEnabled(database, false);

  return syncSaved(database, {
    ...opts,
    stopOnKnown: opts.full ? false : opts.stopOnKnown,
    progress: progress ?? opts.progress,
  });
}
