import type { Database } from "bun:sqlite";
import * as db from "./db.ts";
import { drain, type AuditCallback, type DrainOptions, type DrainResult } from "./reddit_unsave.ts";

export const DEFAULT_IDLE_SECONDS = 30;

export const DEFAULT_CAP = 25;

type Scheduler = (delayMilliseconds: number, callback: () => void) => ReturnType<typeof setTimeout>;

const defaultScheduler: Scheduler = (delay, callback) => setTimeout(callback, delay);

export async function trickle(
  database: Database,
  opts: { limit?: number; audit?: AuditCallback } = {},
): Promise<DrainResult> {
  return drain(database, { limit: opts.limit ?? DEFAULT_CAP, audit: opts.audit });
}

export class TrickleDrainer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  constructor(
    private readonly openDatabase: () => Database,
    private readonly opts: {
      audit?: AuditCallback;
      idleSeconds?: number;
      cap?: number;
      scheduler?: Scheduler;
      drainFn?: (database: Database, opts?: DrainOptions) => Promise<DrainResult>;
    } = {},
  ) {}

  noteEnqueue(): void {
    clearTimeout(this.timer ?? undefined);
    this.timer = (this.opts.scheduler ?? defaultScheduler)(
      1000 * (this.opts.idleSeconds ?? DEFAULT_IDLE_SECONDS),
      () => {
        void this.fire();
      },
    );
  }

  stop(): void {
    clearTimeout(this.timer ?? undefined);
    this.timer = null;
  }

  async fire(): Promise<DrainResult | null> {
    if (this.running) return null;
    this.running = true;
    let database: Database | null = null;
    let result: DrainResult | null = null;

    try {
      database = this.openDatabase();

      if (db.getSetting(database, "reddit_unsave_on_done", "0") !== "1") return null;
      result = await (this.opts.drainFn ?? drain)(database, {
        limit: this.opts.cap ?? DEFAULT_CAP,
        audit: this.opts.audit,
      });
    } finally {
      database?.close();
      this.running = false;
    }

    if (result?.auth_error || result?.network_error)
      console.warn(
        `unsave trickle halted (${result.auth_error ? "auth" : "network"} error): ${result.unsaved ?? 0} unsaved, ${result.remaining ?? 0} remaining — re-authenticate or check connectivity`,
      );

    if ((result?.unsaved ?? 0) > 0 && (result?.remaining ?? 0) > 0) this.noteEnqueue();

    return result;
  }
}
