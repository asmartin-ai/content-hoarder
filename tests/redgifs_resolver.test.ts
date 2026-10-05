import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as db from "../src/db.ts";
import { newItem, parseMetadata } from "../src/models.ts";
import {
  extractGfycatId,
  gfycatToRedgifsId,
  resolve,
  resolveGfycat,
} from "../src/redgifs_resolver.ts";

test("Gfycat URL forms map to the migrated Redgifs ID", () => {
  expect(extractGfycatId("https://gfycat.com/ifr/lazyfatcat")).toBe("lazyfatcat");
  expect(extractGfycatId("https://gfycat.com/gifs/detail/lazyfatcat")).toBe("lazyfatcat");
  expect(extractGfycatId("https://example.test/lazyfatcat")).toBeNull();
  expect(gfycatToRedgifsId("lazyfatcat")).toBe("Lazyfatcat");
});

test("anonymous API resolution is opt-in, read-only unless applied, and preserves local media metadata", async () => {
  let authCalls = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/v2/auth/temporary") {
        authCalls++;

        return Response.json({ token: "anonymous-fixture-token" });
      }

      if (url.pathname === "/v2/gifs/Lazyfatcat") {
        if (request.headers.get("authorization") !== "Bearer anonymous-fixture-token")
          return new Response("unauthorized", { status: 401 });

        return Response.json({
          gif: {
            urls: {
              hd: "https://media.redgifs.com/Lazyfatcat.mp4",
              poster: "https://media.redgifs.com/Lazyfatcat.jpg",
            },
            tags: ["preserved wire extra"],
          },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  const conn = new Database(":memory:");

  try {
    db.initDb(conn);

    const item = newItem({
      source: "reddit",
      source_id: "t3_redgifs",
      title: "preserve",
      status: "keep",
      metadata: {
        media_url: "https://gfycat.com/lazyfatcat",
        media_type: "gif",
        archived_media: { old: "a" },
        unrelated: "keep",
      },
    });

    db.mergeUpsert(conn, item);
    const blocked = await resolve(conn, { allowNetwork: false, apply: true });
    expect(blocked.total).toBe(1);
    expect(blocked.requires_opt_in).toBe(true);
    expect(blocked.message).toBe(
      "RedGifs network resolution is not enabled. Re-run with --redgifs-ok to activate RedGifs resolution.",
    );
    expect(authCalls).toBe(0);

    const baseUrl = `http://127.0.0.1:${server.port}`;
    const resolved = await resolveGfycat("https://gfycat.com/lazyfatcat", { apiBase: baseUrl });
    expect(resolved?.media_url).toBe("https://media.redgifs.com/Lazyfatcat.mp4");
    expect(authCalls).toBe(1);
    const dry = await resolve(conn, { allowNetwork: true, apply: false, apiBase: baseUrl });
    expect(dry.resolved).toBe(1);
    expect(parseMetadata(db.getItem(conn, item.fullname)!.metadata).media_url).toBe(
      "https://gfycat.com/lazyfatcat",
    );
    const applied = await resolve(conn, { allowNetwork: true, apply: true, apiBase: baseUrl });
    expect(applied.resolved).toBe(1);
    const row = db.getItem(conn, item.fullname)!;
    const metadata = parseMetadata(row.metadata);
    expect(metadata.media_url).toBe("https://media.redgifs.com/Lazyfatcat.mp4");
    expect(metadata.media_type).toBe("redgifs_video");
    expect(metadata.thumbnail).toBe("https://media.redgifs.com/Lazyfatcat.jpg");
    expect(metadata.archived_media).toEqual({ old: "a" });
    expect(metadata.unrelated).toBe("keep");
    expect(row.status).toBe("keep");
  } finally {
    conn.close();
    await server.stop(true);
  }
});
