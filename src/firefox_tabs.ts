import type { JsonValue } from "./models.ts";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import * as z from "zod";
import * as db from "./db.ts";
import {
  FIREFOX_TABS_SCHEMA,
  FirefoxTabSchema,
  itemFromTabRecord,
  type FirefoxTab,
} from "./connectors/firefox.ts";

export const TOKEN_HASH_SETTING = "firefox_ingest_token_sha256";

export interface FirefoxTabsPayload {
  schema: string;
  tabs: FirefoxTab[];
  source?: string;
  captured_at?: string | number;
  snapshot_id?: string | number;
}

export interface FirefoxTabsValidation {
  payload: FirefoxTabsPayload | null;
  error: string | null;
}

export interface FirefoxTabsIngestResult {
  imported: number;
  skipped: number;
  errors: string[];
  youtube_promoted: number;
  sample: string[];
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function tokenConfigured(database: Database): boolean {
  return Boolean(db.getSetting(database, TOKEN_HASH_SETTING, ""));
}

export function generateToken(database: Database): string {
  const token = randomBytes(32).toString("base64url");
  db.setSetting(database, TOKEN_HASH_SETTING, tokenHash(token));

  return token;
}

export function verifyToken(database: Database, token: string): boolean {
  const expected = db.getSetting(database, TOKEN_HASH_SETTING, "") || "";

  if (!expected || !token) return false;
  const received = tokenHash(token);

  return (
    expected.length === received.length &&
    timingSafeEqual(Buffer.from(received), Buffer.from(expected))
  );
}

const payloadSchema = z
  .object({
    schema: z.string(),
    tabs: z.array(FirefoxTabSchema),
    source: z.string().optional(),
    captured_at: z.union([z.string(), z.number()]).optional(),
    snapshot_id: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

export function validatePayload(value: JsonValue): FirefoxTabsValidation {
  const parsed = payloadSchema.safeParse(value);

  if (!parsed.success) return { payload: null, error: "expected JSON object with a tabs list" };

  if (parsed.data.schema !== FIREFOX_TABS_SCHEMA)
    return { payload: null, error: `schema must be ${FIREFOX_TABS_SCHEMA}` };

  return { payload: parsed.data, error: null };
}

function normalizedRecord(tab: FirefoxTab, payload: FirefoxTabsPayload, now: number): FirefoxTab {
  const record = { ...tab };
  record.capture_source = record.capture_source || payload.source || "webextension";
  record.captured_at = record.captured_at || payload.captured_at || now;

  if (payload.snapshot_id && !record.snapshot_id) record.snapshot_id = payload.snapshot_id;

  if (!("favicon" in record) && record.favIconUrl !== undefined) record.favicon = record.favIconUrl;

  if (!("window" in record) && record.windowId !== undefined) record.window = record.windowId;

  if (!("last_accessed_ms" in record) && "lastAccessed" in record)
    record.last_accessed_ms = record.lastAccessed ?? null;

  if (!("cookie_store_id" in record) && record.cookieStoreId !== undefined)
    record.cookie_store_id = record.cookieStoreId;

  if (!("group_id" in record) && record.groupId !== undefined) record.group_id = record.groupId;

  return record;
}

export function ingestSnapshot(
  database: Database,
  payload: FirefoxTabsPayload,
  now = Math.floor(Date.now() / 1000),
): FirefoxTabsIngestResult {
  const result: FirefoxTabsIngestResult = {
    imported: 0,
    skipped: 0,
    errors: [],
    youtube_promoted: 0,
    sample: [],
  };

  for (const tab of payload.tabs) {
    const item = itemFromTabRecord(normalizedRecord(tab, payload, now));

    if (!item) {
      result.skipped++;
      continue;
    }

    try {
      db.mergeUpsert(database, item);
      result.imported++;

      if (item.source === "youtube") result.youtube_promoted++;

      if (result.sample.length < 5) result.sample.push(item.fullname);
    } catch (error) {
      result.skipped++;
      result.errors.push(
        `${item.fullname || "?"}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return result;
}
