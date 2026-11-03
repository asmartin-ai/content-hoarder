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
  youtubeChoices.clear();
  youtubeExpired.clear();
  youtubeAttempts.clear();
}

export type PullState = "running" | "done" | "error" | "cancelled";

export interface LibraryPull {
  source: string;
  state: PullState;
  count: number;
  settled: Promise<void>;
}

const pulls = new WeakMap<Database, LibraryPull>();

export function startPull(
  library: Database,
  source: string,
  run: () => Promise<number>,
): "started" | "busy" {
  if (pulls.get(library)?.state === "running") return "busy";

  const pull: LibraryPull = { source, state: "running", count: 0, settled: Promise.resolve() };

  const settle = async (): Promise<void> => {
    try {
      pull.count = await run();
      pull.state = "done";
    } catch {
      console.error(`${source} pull failed`);
      pull.state = "error";
    }
  };

  pull.settled = settle();
  pulls.set(library, pull);

  return "started";
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

export const YOUTUBE_CHOICE_SECONDS = 600;

const YOUTUBE_EXPIRED_SECONDS = 600;

const YOUTUBE_EXPIRED_MAX = 1000;

const YOUTUBE_SWEEP_MS = 30_000;

export interface YoutubeChoicePlaylist {
  id: string;
  title: string;
  count: number | null;
}

export interface YoutubeChoice {
  token: string;
  playlists: YoutubeChoicePlaylist[];
  expiresAt: number;
  generation: string;
}

const youtubeChoices = new Map<string, YoutubeChoice>();

const youtubeExpired = new Map<string, number>();

const youtubeAttempts = new Map<string, number>();

let youtubeSweepStarted = false;

function markYoutubeExpired(sub: string, now: number): void {
  youtubeExpired.delete(sub);
  youtubeExpired.set(sub, now + YOUTUBE_EXPIRED_SECONDS * 1000);

  while (youtubeExpired.size > YOUTUBE_EXPIRED_MAX) {
    const oldest = youtubeExpired.keys().next().value;

    if (oldest === undefined) break;

    youtubeExpired.delete(oldest);
  }
}

export function sweepYoutubeChoices(): void {
  const now = Date.now();

  for (const [sub, choice] of youtubeChoices)
    if (choice.expiresAt <= now) {
      youtubeChoices.delete(sub);
      markYoutubeExpired(sub, now);
    }

  for (const [sub, until] of youtubeExpired) if (until <= now) youtubeExpired.delete(sub);
}

function ensureYoutubeSweep(): void {
  if (youtubeSweepStarted) return;

  youtubeSweepStarted = true;
  setInterval(sweepYoutubeChoices, YOUTUBE_SWEEP_MS).unref();
}

export function beginYoutubeAuth(sub: string, attempt: number): void {
  sweepYoutubeChoices();
  youtubeAttempts.set(sub, attempt);
  youtubeChoices.delete(sub);
  youtubeExpired.delete(sub);
}

export function failYoutubeAuth(sub: string, attempt: number): boolean {
  sweepYoutubeChoices();

  const latest = youtubeAttempts.get(sub);

  if (latest !== undefined && latest > attempt) return false;

  youtubeAttempts.set(sub, attempt);
  youtubeChoices.delete(sub);
  youtubeExpired.delete(sub);

  return true;
}

export function setYoutubeChoice(
  sub: string,
  choice: { token: string; playlists: YoutubeChoicePlaylist[]; expiresAt: number },
  attempt?: number,
): string | null {
  sweepYoutubeChoices();
  ensureYoutubeSweep();

  const latest = youtubeAttempts.get(sub);

  if (attempt !== undefined && latest !== undefined && latest > attempt) return null;

  const generation = randomBytes(18).toString("base64url");

  youtubeChoices.set(sub, { ...choice, generation });

  if (attempt !== undefined) youtubeAttempts.set(sub, attempt);

  youtubeExpired.delete(sub);

  return generation;
}

export function youtubeChoice(sub: string): YoutubeChoice | null {
  sweepYoutubeChoices();

  return youtubeChoices.get(sub) ?? null;
}

export function youtubeChoiceExpired(sub: string): boolean {
  sweepYoutubeChoices();

  return youtubeExpired.has(sub);
}

export function takeYoutubeChoice(sub: string): YoutubeChoice | null {
  sweepYoutubeChoices();

  const choice = youtubeChoices.get(sub) ?? null;

  youtubeChoices.delete(sub);

  return choice;
}

export function restoreYoutubeChoice(sub: string, choice: YoutubeChoice): void {
  if (choice.expiresAt <= Date.now()) return;

  youtubeChoices.set(sub, choice);
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
