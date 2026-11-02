import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import * as config from "../config.ts";
import * as db from "../db.ts";
import type { TrickleDrainer } from "../reddit_trickle.ts";

export const PREPARED_TTL_SECONDS = 3600;

export interface StagedImport {
  path: string;
  source: string;
  expires: number;
  library: Database;
}

const prepared = new Map<string, StagedImport>();

let selectedDbPath: string | undefined;

let activeDatabasePath: string | undefined;

let activeDatabase: Database | undefined;

let unsaveTrickle: TrickleDrainer | null = null;

const libraries = new Map<string, Database>();

const currentLibrary = new AsyncLocalStorage<Database>();

export function setDatabasePath(path: string | undefined): void {
  selectedDbPath = path;
}

export function databasePath(): string {
  return selectedDbPath ?? config.dbPath();
}

export function mainConnection(): Database {
  const path = databasePath();

  if (!activeDatabase || activeDatabasePath !== path) {
    closeConnection();
    activeDatabase = db.connect(path);
    activeDatabasePath = path;
  }

  return activeDatabase;
}

export function connection(): Database {
  return currentLibrary.getStore() ?? mainConnection();
}

export function libraryPath(sub: string): string {
  const name = createHash("sha256").update(sub).digest("hex").slice(0, 32);

  return join(dirname(databasePath()), "users", `${name}.db`);
}

export function libraryConnection(sub: string): Database {
  const path = libraryPath(sub);
  const open = libraries.get(path);

  if (open) return open;

  mkdirSync(dirname(path), { recursive: true });
  const opened = db.connect(path);

  libraries.set(path, opened);

  return opened;
}

export function withLibrary<T>(library: Database, fn: () => T): T {
  return currentLibrary.run(library, fn);
}

export function closeConnection(): void {
  activeDatabase?.close();
  activeDatabase = undefined;
  activeDatabasePath = undefined;

  for (const library of libraries.values()) library.close();
  libraries.clear();
}

export type PullState = "running" | "done" | "error" | "cancelled";

export interface LibraryPull {
  source: string;
  state: PullState;
  count: number;
  settled: Promise<void>;
}

const pulls = new WeakMap<Database, LibraryPull>();

export function startPull(library: Database, source: string, run: () => Promise<number>): void {
  if (pulls.get(library)?.state === "running") return;

  const pull: LibraryPull = { source, state: "running", count: 0, settled: Promise.resolve() };

  const settle = async (): Promise<void> => {
    try {
      pull.count = await run();
      pull.state = "done";
    } catch (error) {
      console.error(`${source} pull failed: ${error instanceof Error ? error.message : error}`);
      pull.state = "error";
    }
  };

  pull.settled = settle();
  pulls.set(library, pull);
}

export function notePull(library: Database, source: string, state: "error" | "cancelled"): void {
  pulls.set(library, { source, state, count: 0, settled: Promise.resolve() });
}

export function currentPull(library: Database): LibraryPull | undefined {
  return pulls.get(library);
}

export function takePull(library: Database): LibraryPull | undefined {
  const pull = pulls.get(library);

  if (pull && pull.state !== "running") pulls.delete(library);

  return pull;
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

  prepared.set(token, {
    path,
    source,
    expires: Date.now() + ttlSeconds * 1000,
    library: connection(),
  });

  return token;
}

export function takeImport(token: string): StagedImport | undefined {
  const staged = prepared.get(token);

  if (!staged || staged.library !== connection()) return undefined;

  prepared.delete(token);

  return staged;
}

export function stagedImports(): StagedImport[] {
  return [...prepared.values()];
}

export function clearPrepared(): void {
  prepared.clear();
}
