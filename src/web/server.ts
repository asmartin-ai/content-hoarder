import { readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { serve, type Server } from "bun";
import { z } from "zod";
import * as config from "../config.ts";
import * as db from "../db.ts";
import * as redditUnsave from "../reddit_unsave.ts";
import { TrickleDrainer } from "../reddit_trickle.ts";
import { SyncScheduler, autosyncIntervalMs, isAutosyncEnabled } from "../sync/scheduler.ts";
import { handle } from "./routes.ts";
import {
  cleanPrepared,
  clearPrepared,
  closeConnection,
  connection,
  databasePath,
  setDatabasePath,
  setUnsaveTrickle,
  stagedImports,
  stopUnsaveTrickle,
} from "./state.ts";

const ServeOptionsSchema = z.object({
  dbPath: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().optional(),
  tls: z.boolean().optional(),
});

export interface ServeOptions {
  dbPath?: string;
  host?: string;
  port?: number;
  tls?: boolean;
}

export interface AppServer {
  port: number;
  scheduler: SyncScheduler | null;
  stop: () => Promise<void>;
}

export async function serveApp(value: ServeOptions | string = {}): Promise<AppServer> {
  const parsedPath = z.string().safeParse(value);

  const options = parsedPath.success
    ? { dbPath: parsedPath.data }
    : ServeOptionsSchema.parse(value);

  setDatabasePath(options.dbPath ? resolve(options.dbPath) : undefined);
  connection();
  cleanPrepared();
  const host = options.host ?? config.host();
  const port = options.port ?? config.port();

  // SyncScheduler closes the connection it opens. Handing it the shared request
  // connection killed the server on the first tick ("Cannot use a closed
  // database" on every later request), so it gets its own, exactly like the
  // unsave drainer below.
  const scheduler = isAutosyncEnabled(connection())
    ? new SyncScheduler(() => db.connect(databasePath()), autosyncIntervalMs()).start()
    : null;

  // The drainer opens its own connection per fire (never the shared request
  // one, which it closes) and re-checks the opt-in before draining.
  const tricklePath = databasePath();
  const [trickleAudit] = redditUnsave.auditAppender(tricklePath);

  setUnsaveTrickle(new TrickleDrainer(() => db.connect(tricklePath), { audit: trickleAudit }));

  const server: Server<undefined> = options.tls
    ? serve({
        fetch: handle,
        hostname: host,
        port,
        idleTimeout: 120,
        tls: {
          cert: readFileSync(join(import.meta.dir, "..", "..", "cert.pem")),
          key: readFileSync(join(import.meta.dir, "..", "..", "key.pem")),
        },
      })
    : serve({ fetch: handle, hostname: host, port, idleTimeout: 120 });

  return {
    port: server.port ?? port,
    scheduler,
    stop: async () => {
      server.stop(true);
      scheduler?.stop();
      stopUnsaveTrickle();
      closeConnection();
      setDatabasePath(undefined);

      for (const item of stagedImports())
        try {
          unlinkSync(item.path);
        } catch {
          /* staged file was already removed */
        }

      clearPrepared();
    },
  };
}
