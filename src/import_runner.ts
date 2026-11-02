import type { Database } from "bun:sqlite";
import {
  ImportRefused,
  type ImportJob,
  type ImportedFile,
  type PreparedFile,
  importFile,
  prepareFile,
} from "./import_jobs.ts";

export const IMPORT_BUSY = "An import is already running. Wait for it to finish, then try again.";

type Reply =
  | { id: number; ok: true; value: PreparedFile | ImportedFile }
  | { id: number; ok: false; refused: boolean; message: string };

interface Waiter {
  resolve: (value: PreparedFile | ImportedFile) => void;
  reject: (error: Error) => void;
}

let worker: Worker | null = null;

let nextId = 1;

const waiting = new Map<number, Waiter>();

const busy = new Set<string>();

function failAll(message: string): void {
  for (const waiter of waiting.values()) waiter.reject(new Error(message));
  waiting.clear();
  worker = null;
}

function ensureWorker(): Worker {
  if (worker) return worker;

  const made = new Worker(new URL("./import_worker.ts", import.meta.url).href);

  made.onmessage = (event: MessageEvent<Reply>) => {
    const reply = event.data;
    const waiter = waiting.get(reply.id);

    if (!waiter) return;
    waiting.delete(reply.id);

    if (reply.ok) waiter.resolve(reply.value);
    else waiter.reject(reply.refused ? new ImportRefused(reply.message) : new Error(reply.message));
  };

  made.onerror = (event) => failAll(`import worker failed: ${event.message}`);
  made.unref();
  worker = made;

  return made;
}

function inWorker(job: ImportJob): Promise<PreparedFile | ImportedFile> {
  const id = nextId++;
  const { promise, resolve, reject } = Promise.withResolvers<PreparedFile | ImportedFile>();

  waiting.set(id, { resolve, reject });
  ensureWorker().postMessage({ id, job });

  return promise;
}

function dbPath(database: Database): string {
  return database.filename && database.filename !== ":memory:" ? database.filename : "";
}

async function run<T extends PreparedFile | ImportedFile>(
  database: Database,
  job: (path: string) => ImportJob,
  inline: () => T | Promise<T>,
  guard: boolean,
): Promise<T> {
  const path = dbPath(database);

  if (!path) return inline();

  if (!guard) return (await inWorker(job(path))) as T;

  if (busy.has(path)) throw new ImportRefused(IMPORT_BUSY);
  busy.add(path);

  try {
    return (await inWorker(job(path))) as T;
  } finally {
    busy.delete(path);
  }
}

export function importBusy(database: Database): boolean {
  return busy.has(dbPath(database));
}

export function prepareOffThread(
  database: Database,
  filePath: string,
  source: string | undefined,
): Promise<PreparedFile> {
  return run(
    database,
    (dbPath) => ({ kind: "prepare", dbPath, filePath, source }),
    () => prepareFile(database, filePath, source),
    true,
  );
}

export function importOffThread(
  database: Database,
  filePath: string,
  source: string | undefined,
  opts: { queue?: boolean } = {},
): Promise<ImportedFile> {
  return run(
    database,
    (dbPath) => ({ kind: "import", dbPath, filePath, source }),
    () => importFile(database, filePath, source),
    !opts.queue,
  );
}
