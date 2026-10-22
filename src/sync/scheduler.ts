import type { Database } from "bun:sqlite";
import * as config from "../config.ts";
import * as db from "../db.ts";
import { autoSync, type AutoSyncResult } from "../reddit_sync.ts";

const ENABLED_KEY = "reddit_autosync_enabled";

const DEFAULT_INTERVAL_SECONDS = 600;

export function isAutosyncEnabled(database: Database): boolean {
  return db.getSetting(database, ENABLED_KEY, "0") === "1";
}

export function setAutosyncEnabled(database: Database, enabled: boolean): void {
  db.setSetting(database, ENABLED_KEY, enabled ? "1" : "0");
}

function integerSetting(value: string | null, fallback: number): number {
  if (value === null || value === "") return fallback;

  const parsed = Number(value);

  return Number.isInteger(parsed) ? parsed : fallback;
}

export function autosyncIntervalMs(): number {
  return (
    integerSetting(config.get("REDDIT_AUTOSYNC_INTERVAL") ?? null, DEFAULT_INTERVAL_SECONDS) *
      1000 || 600_000
  );
}

export class SyncScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private running = false;
  constructor(
    private readonly openDatabase: () => Database,
    private readonly interval = 600_000,
    private readonly syncFn: (database: Database) => Promise<AutoSyncResult> = autoSync,
  ) {}
  start(): this {
    this.arm();

    return this;
  }
  stop(): void {
    this.stopped = true;

    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
  private arm(): void {
    if (!this.stopped) this.timer = setTimeout(() => void this.fire(), this.interval);
  }
  async fire(): Promise<AutoSyncResult | null> {
    if (this.running) return null;
    this.running = true;
    let database: Database | null = null;

    try {
      database = this.openDatabase();

      if (!isAutosyncEnabled(database)) return null;

      return await this.syncFn(database);
    } catch (error) {
      console.error(`reddit autosync tick failed: ${error}`);

      return null;
    } finally {
      database?.close();
      this.running = false;
      this.arm();
    }
  }
}
