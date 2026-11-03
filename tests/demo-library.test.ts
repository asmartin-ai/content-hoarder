import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../src/db.ts";
import { importPath } from "../src/pipeline.ts";

const DEMO_DIR = join(import.meta.dir, "..", "docs", "demo");

const MEDIA_DIR = join(DEMO_DIR, "media");

const MEDIA_PREFIX = "http://127.0.0.1:8790/";

const FIXTURES = [
  join(DEMO_DIR, "demo-saves.json"),
  join(DEMO_DIR, "youtube-watch-later.json"),
  join(DEMO_DIR, "hackernews-favorites.html"),
  join(DEMO_DIR, "bookmarks.html"),
  join(DEMO_DIR, "keep"),
];

type Meta = {
  thumbnail?: string;
  media_url?: string;
  media_urls?: string[];
  gallery?: string[];
  gallery_preview?: string[];
};

const MEDIA_EXT = /\.(jpe?g|png|gif|webp|mp4|webm|mov)(\?|$)/i;

test("the demo library imports every source with loopback media", async () => {
  const directory = mkdtempSync(join(tmpdir(), "content-hoarder-demo-test-"));
  const connection = db.connect(join(directory, "app.db"));

  try {
    for (const fixture of FIXTURES) {
      const result = await importPath(connection, fixture);

      expect({ fixture, errors: result.errors }).toEqual({ fixture, errors: [] });
      expect(result.imported).toBeGreaterThan(0);
    }

    const counts = connection
      .query<{ source: string; total: number }, []>(
        "SELECT source, COUNT(*) AS total FROM items GROUP BY source ORDER BY source",
      )
      .all();

    expect(Object.fromEntries(counts.map((row) => [row.source, row.total]))).toEqual({
      bookmarks: 6,
      hackernews: 6,
      keep: 5,
      reddit: 52,
      youtube: 8,
    });

    const rows = connection
      .query<{ url: string; metadata: string }, []>("SELECT url, metadata FROM items")
      .all();

    const mediaUrls = new Set<string>();

    const add = (value: string | undefined): void => {
      if (value && /^https?:\/\//.test(value)) mediaUrls.add(value);
    };

    for (const row of rows) {
      const metadata = JSON.parse(row.metadata || "{}") as Meta;

      add(metadata.thumbnail);
      add(metadata.media_url);

      for (const url of metadata.media_urls ?? []) add(url);

      for (const url of metadata.gallery ?? []) add(url);

      for (const url of metadata.gallery_preview ?? []) add(url);

      if (MEDIA_EXT.test(row.url)) add(row.url);
    }

    expect(mediaUrls.size).toBe(17);

    for (const url of mediaUrls) {
      expect(url.startsWith(MEDIA_PREFIX)).toBe(true);
      expect(existsSync(join(MEDIA_DIR, new URL(url).pathname.replace(/^\/+/, "")))).toBe(true);
    }

    const clips = [...mediaUrls].filter((url) => url.endsWith(".mp4"));

    expect(clips.length).toBe(2);

    const youtube = connection
      .query<{ metadata: string }, []>("SELECT metadata FROM items WHERE source='youtube'")
      .all();

    for (const row of youtube) {
      const metadata = JSON.parse(row.metadata || "{}") as Meta;

      expect(metadata.thumbnail?.startsWith(MEDIA_PREFIX)).toBe(true);
      expect(metadata.thumbnail).not.toContain("i.ytimg.com");
    }

    const stories = connection
      .query<{ title: string; url: string }, []>(
        "SELECT title, url FROM items WHERE source='hackernews'",
      )
      .all();

    expect(stories.every((story) => story.title.length > 0)).toBe(true);
    expect(stories.every((story) => story.url.startsWith("https://example.com/"))).toBe(true);

    const garden = connection
      .query<{ body: string }, [string]>("SELECT body FROM items WHERE fullname = ?")
      .get("keep:garden-jobs");

    expect(garden?.body).toContain("[x] Move the mint off the sunny sill");
    expect(garden?.body).toContain("[ ] Order more seed labels");
  } finally {
    connection.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
