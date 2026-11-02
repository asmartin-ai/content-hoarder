import type { Database } from "bun:sqlite";
import * as db from "./db.ts";
import { ImportRefused, type ImportJob, importFile, prepareFile } from "./import_jobs.ts";

declare const self: Worker;

const open = new Map<string, Database>();

function library(path: string): Database {
  const known = open.get(path);

  if (known) return known;

  const made = db.connect(path);

  open.set(path, made);

  return made;
}

self.onmessage = async (event: MessageEvent<{ id: number; job: ImportJob }>) => {
  const { id, job } = event.data;

  try {
    const database = library(job.dbPath);

    const value =
      job.kind === "prepare"
        ? prepareFile(database, job.filePath, job.source)
        : await importFile(database, job.filePath, job.source);

    self.postMessage({ id, ok: true, value });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      refused: error instanceof ImportRefused,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
