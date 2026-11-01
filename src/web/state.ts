import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import type { Database } from "bun:sqlite";
import * as config from "../config.ts";
import * as db from "../db.ts";
import type { TrickleDrainer } from "../reddit_trickle.ts";

export const PREPARED_TTL_SECONDS = 3600;

export interface StagedImport {
  path: string;
  source: string;
  expires: number;
}

const prepared = new Map<string, StagedImport>();

let selectedDbPath: string | undefined;

let activeDatabasePath: string | undefined;

let activeDatabase: Database | undefined;

let unsaveTrickle: TrickleDrainer | null = null;

export function setDatabasePath(path: string | undefined): void {
  selectedDbPath = path;
}

export function databasePath(): string {
  return selectedDbPath ?? config.dbPath();
}

export function connection(): Database {
  const path = databasePath();

  if (!activeDatabase || activeDatabasePath !== path) {
    activeDatabase?.close();
    activeDatabase = db.connect(path);
    activeDatabasePath = path;
  }

  return activeDatabase;
}

export function closeConnection(): void {
  activeDatabase?.close();
  activeDatabase = undefined;
  activeDatabasePath = undefined;
}

export function setUnsaveTrickle(drainer: TrickleDrainer | null): void {
  unsaveTrickle = drainer;
}

export function noteUnsaveEnqueue(): void {
  unsaveTrickle?.noteEnqueue();
}

export function stopUnsaveTrickle(): void {
  unsaveTrickle?.stop();
  unsaveTrickle = null;
}

export function cleanPrepared(): void {
  for (const [token, item] of prepared)
    if (item.expires < Date.now()) {
      try {
        unlinkSync(item.path);
      } catch {}

      prepared.delete(token);
    }
}

export function stageImport(path: string, source: string, ttlSeconds: number): string {
  const token = randomBytes(18).toString("base64url");

  prepared.set(token, { path, source, expires: Date.now() + ttlSeconds * 1000 });

  return token;
}

export function takeImport(token: string): StagedImport | undefined {
  const staged = prepared.get(token);

  if (staged) prepared.delete(token);

  return staged;
}

export function stagedImports(): StagedImport[] {
  return [...prepared.values()];
}

export function clearPrepared(): void {
  prepared.clear();
}
