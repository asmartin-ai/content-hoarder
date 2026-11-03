import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RedditConnector, previewThumb } from "../src/connectors/reddit.ts";
import * as db from "../src/db.ts";
import {
  newItem,
  parseMetadata,
  type Item,
  type JsonValue,
  type NewItemInput,
} from "../src/models.ts";
import { hydrateIfMissing } from "../src/reddit_hydrate.ts";
import { mediaTileKind, mediaType, thumb } from "../src/static/core/media.js";
import {
  gallerySlides,
  isNsfw,
  isSpoiler,
  isVeiled,
  sharpImage,
  veilLabel,
} from "../src/static/core/veil.js";
import { renderCard } from "../src/web/views/card.ts";
import { cardMedia, thumbFor } from "../src/web/views/media.ts";

const NOW = 1_760_000_000;

const SHARP_DIRECT = "https://i.redd.it/spoil1.jpeg";

const SHARP_PREVIEW = "https://preview.redd.it/spoil1.jpeg?auto=webp&s=sharp";

const BLURRED_PREVIEW = "https://preview.redd.it/spoil1.jpeg?blur=40&format=pjpg&auto=webp&s=blur";

const BLURRED_THUMB =
  "https://preview.redd.it/spoil1.jpeg?width=140&height=78&blur=40&auto=webp&s=blur";

const EXTERNAL_BLURRED = "https://external-preview.redd.it/spoil1.png?blur=40&auto=webp&s=blur";

const COMMENT_PERMALINK = "/r/movies/comments/spoil1/finale_explained/";

function spoilerData(overrides: Record<string, JsonValue> = {}): JsonValue {
  return {
    name: "t3_spoil1",
    id: "spoil1",
    title: "Finale explained",
    subreddit: "movies",
    permalink: COMMENT_PERMALINK,
    author: "someone",
    created_utc: NOW,
    over_18: false,
    spoiler: true,
    thumbnail: "spoiler",
    url: SHARP_DIRECT,
    url_overridden_by_dest: SHARP_DIRECT,
    preview: {
      images: [
        {
          source: { url: BLURRED_PREVIEW, width: 1200, height: 800 },
          variants: { obfuscated: { source: { url: BLURRED_PREVIEW } } },
        },
      ],
    },
    ...overrides,
  };
}

function importJson(payload: JsonValue): Item[] {
  const dir = mkdtempSync(join(tmpdir(), "ch-spoiler-"));

  try {
    const file = join(dir, "reddit-saved.json");

    writeFileSync(file, JSON.stringify(payload), "utf8");
    const raw = new RedditConnector().importFile(file);

    return raw.map((item) => ({ ...item, metadata: parseMetadata(item.metadata) }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeItem(input: NewItemInput): Item {
  const item = newItem({ now: NOW, created_utc: NOW - 3 * 86_400, ...input });

  return { ...item, metadata: parseMetadata(item.metadata) };
}

function flat(markup: string): string {
  return markup
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    .replace(/\s+(\/?>)/g, "$1");
}

function threadWith(spoiler: boolean | undefined): string {
  const base = { id: "spoil1", title: "Finale explained" };
  const data = spoiler === undefined ? base : { ...base, spoiler };

  return JSON.stringify([
    { kind: "Listing", data: { children: [{ kind: "t3", data }] } },
    { kind: "Listing", data: { children: [] } },
  ]);
}

test("previewThumb prefers the sharp i.redd.it image over a blurred spoiler preview", () => {
  expect(previewThumb(spoilerData())).toBe(SHARP_DIRECT);
});

test("bookmarklet listing import keeps the sharp image and stores the spoiler flag", () => {
  const [item] = importJson({
    kind: "Listing",
    data: { children: [{ kind: "t3", data: spoilerData() }] },
  });

  expect(item).toBeDefined();
  expect(item!.metadata.thumbnail).toBe(SHARP_DIRECT);
  expect(item!.metadata.spoiler).toBe(1);
  expect(item!.metadata.over_18).toBe(0);
  expect(item!.url).toBe(SHARP_DIRECT);
});

test("root-array Reddit listing import keeps the sharp image and stores the spoiler flag", () => {
  const [item] = importJson([{ kind: "t3", data: spoilerData({ url_overridden_by_dest: null }) }]);

  expect(item).toBeDefined();
  expect(item!.metadata.thumbnail).toBe(SHARP_DIRECT);
  expect(item!.metadata.spoiler).toBe(1);
});

test("a post whose only media is blurred keeps the blurred URL so a veil can reveal it", () => {
  const [item] = importJson({
    kind: "Listing",
    data: {
      children: [
        {
          kind: "t3",
          data: spoilerData({
            url: "https://www.reddit.com/gallery/spoil1",
            url_overridden_by_dest: null,
            thumbnail: BLURRED_THUMB,
            preview: { images: [{ source: { url: BLURRED_PREVIEW } }] },
          }),
        },
      ],
    },
  });

  expect(item).toBeDefined();
  expect(item!.metadata.thumbnail).toBe(BLURRED_PREVIEW);
  expect(item!.metadata.spoiler).toBe(1);
});

test("a sharp preview is used when the post is not a direct i.redd.it image", () => {
  const thumbnail = previewThumb(
    spoilerData({
      url: "https://www.reddit.com/gallery/spoil1",
      url_overridden_by_dest: null,
      preview: { images: [{ source: { url: SHARP_PREVIEW } }] },
    }),
  );

  expect(thumbnail).toBe(SHARP_PREVIEW);
});

test("an NSFW spoiler stores both flags and still prefers the sharp image", () => {
  const [item] = importJson({
    kind: "Listing",
    data: { children: [{ kind: "t3", data: spoilerData({ over_18: true }) }] },
  });

  expect(item).toBeDefined();
  expect(item!.metadata.spoiler).toBe(1);
  expect(item!.metadata.over_18).toBe(1);
  expect(item!.metadata.thumbnail).toBe(SHARP_DIRECT);
});

test("a legacy static-image spoiler with a blurred thumbnail renders the sharp original", () => {
  const item = makeItem({
    source: "reddit",
    source_id: "t3_spoil1",
    kind: "post",
    title: "Finale explained",
    url: SHARP_DIRECT,
    metadata: {
      over_18: 0,
      spoiler: 1,
      thumbnail: BLURRED_PREVIEW,
      media_type: "image",
      permalink: COMMENT_PERMALINK,
    },
  });

  expect(sharpImage(item, BLURRED_PREVIEW)).toBe(SHARP_DIRECT);
  expect(thumb(item, "list")).toBe(SHARP_DIRECT);
  expect(cardMedia(item)?.src).toBe(SHARP_DIRECT);
  expect(thumbFor(item)).toBe(SHARP_DIRECT);
});

test("a blurred external preview stays blurred unless a sharp source is known", () => {
  const unknown = makeItem({
    source: "reddit",
    source_id: "t3_ext1",
    kind: "post",
    title: "External",
    url: "https://example.com/story",
    metadata: { spoiler: 1, thumbnail: EXTERNAL_BLURRED, media_type: "link" },
  });

  expect(sharpImage(unknown, EXTERNAL_BLURRED)).toBe(EXTERNAL_BLURRED);

  const known = makeItem({
    source: "reddit",
    source_id: "t3_ext2",
    kind: "post",
    title: "External",
    url: "https://example.com/story",
    metadata: { spoiler: 1, thumbnail: EXTERNAL_BLURRED, media_url: SHARP_DIRECT },
  });

  expect(sharpImage(known, EXTERNAL_BLURRED)).toBe(SHARP_DIRECT);
});

test("preview derivation is limited to static image posts", () => {
  const image = makeItem({
    source: "reddit",
    source_id: "t3_img",
    kind: "post",
    title: "Image",
    url: "https://www.reddit.com/gallery/img",
    metadata: { media_type: "image", thumbnail: BLURRED_PREVIEW },
  });

  expect(sharpImage(image, BLURRED_PREVIEW)).toBe(SHARP_DIRECT);

  const video = makeItem({
    source: "reddit",
    source_id: "t3_vid",
    kind: "post",
    title: "Video",
    url: "https://v.redd.it/abc123",
    metadata: { media_type: "reddit_video", thumbnail: BLURRED_PREVIEW },
  });

  expect(sharpImage(video, BLURRED_PREVIEW)).toBe(BLURRED_PREVIEW);

  const gif = makeItem({
    source: "reddit",
    source_id: "t3_gif",
    kind: "post",
    title: "GIF",
    url: "https://www.reddit.com/gallery/gif",
    metadata: { media_type: "image", thumbnail: "https://preview.redd.it/anim.gif?blur=40&s=x" },
  });

  expect(sharpImage(gif, "https://preview.redd.it/anim.gif?blur=40&s=x")).toBe(
    "https://preview.redd.it/anim.gif?blur=40&s=x",
  );

  const gallery = makeItem({
    source: "reddit",
    source_id: "t3_gal",
    kind: "post",
    title: "Gallery",
    url: "https://www.reddit.com/gallery/gal",
    metadata: { media_type: "gallery", gallery: [SHARP_DIRECT], thumbnail: BLURRED_PREVIEW },
  });

  expect(sharpImage(gallery, BLURRED_PREVIEW)).toBe(SHARP_DIRECT);
});

test("gallery slides use sharp originals when previews are blurred", () => {
  const sharpPreview = "https://preview.redd.it/g2.png?auto=webp&s=ok";
  const full = [SHARP_DIRECT, "https://i.redd.it/g2.png"];

  expect(gallerySlides(full, [BLURRED_PREVIEW, sharpPreview])).toEqual([
    SHARP_DIRECT,
    sharpPreview,
  ]);
  expect(gallerySlides(full, [BLURRED_PREVIEW])).toEqual(full);
});

test("NSFW takes precedence over spoiler, and tags count as NSFW", () => {
  const combined = { metadata: { over_18: 1, spoiler: 1 } };
  const tagged = { metadata: { tags: ["nsfw_other"], spoiler: 1 } };
  const spoiler = { metadata: { spoiler: 1 } };
  const clear = { metadata: { over_18: 0, tags: ["video"] } };

  expect(isNsfw(combined)).toBe(true);
  expect(isSpoiler(combined)).toBe(true);
  expect(isVeiled(tagged)).toBe(true);
  expect(veilLabel(combined, true)).toBe("NSFW · tap to reveal");
  expect(veilLabel(spoiler, true)).toBe("Spoiler · tap to reveal");
  expect(veilLabel(spoiler)).toBe("Spoiler");
  expect(isVeiled(clear)).toBe(false);
  expect(veilLabel(clear)).toBe("");
});

test("a text-classified Reddit media item still gets a revealable reader tile", () => {
  const item = makeItem({
    source: "reddit",
    source_id: "t3_text_media",
    kind: "post",
    title: "Finale explained",
    url: "https://www.reddit.com" + COMMENT_PERMALINK,
    metadata: {
      spoiler: 1,
      thumbnail: BLURRED_PREVIEW,
      media_type: "reddit_media",
      permalink: COMMENT_PERMALINK,
    },
  });

  const mt = mediaType(item);

  expect(mt.cls).toBe("text");
  expect(mediaTileKind(item, mt, sharpImage(item, BLURRED_PREVIEW))).toEqual({
    cls: "image",
    icon: "🖼️",
    label: "Image",
  });

  const clear = makeItem({
    source: "reddit",
    source_id: "t3_text_clear",
    kind: "post",
    title: "Discussion",
    url: "https://www.reddit.com" + COMMENT_PERMALINK,
    metadata: { media_type: "reddit_media", permalink: COMMENT_PERMALINK },
  });

  expect(mediaTileKind(clear, mediaType(clear), "")).toBeNull();
});

test("a spoiler video without a poster keeps the veil before it can play", () => {
  const item = makeItem({
    source: "reddit",
    source_id: "t3_spoilvid",
    kind: "post",
    title: "The ending",
    url: "https://v.redd.it/abc123",
    metadata: {
      over_18: 0,
      spoiler: 1,
      media_type: "reddit_video",
      media_url: "https://v.redd.it/abc123",
      permalink: "/r/movies/comments/spoilvid/the_ending/",
    },
  });

  const out = flat(renderCard(item).value);

  expect(out).toContain('class="card-media is-missing is-nsfw"');
  expect(out).toContain('data-veil="Spoiler · tap to reveal"');
  expect(out).toContain('data-play="https://v.redd.it/abc123/HLSPlaylist.m3u8"');
  expect(out).not.toContain("data-thumb=");
});

test("a spoiler card renders the NSFW reveal mechanism with a spoiler veil", () => {
  const item = makeItem({
    source: "reddit",
    source_id: "t3_spoil1",
    kind: "post",
    title: "Finale explained",
    url: SHARP_DIRECT,
    metadata: { over_18: 0, spoiler: 1, thumbnail: SHARP_DIRECT, subreddit: "movies" },
  });

  const out = flat(renderCard(item).value);

  expect(out).toContain('class="card-media is-nsfw"');
  expect(out).toContain('data-veil="Spoiler · tap to reveal"');
  expect(out).toContain('<span class="tag tag-spoiler">Spoiler</span>');
  expect(out).not.toContain("data-thumb=");
});

test("a tagged-NSFW card is veiled and labelled NSFW on Clear too", () => {
  const item = makeItem({
    source: "reddit",
    source_id: "t3_tagged",
    kind: "post",
    title: "Tagged",
    url: SHARP_DIRECT,
    metadata: { tags: ["nsfw_other"], thumbnail: SHARP_DIRECT, subreddit: "movies" },
  });

  const out = flat(renderCard(item).value);

  expect(out).toContain('class="card-media is-nsfw"');
  expect(out).toContain('data-veil="NSFW · tap to reveal"');
  expect(out).toContain('<span class="tag tag-nsfw">NSFW</span>');
});

test("an unflagged post keeps a clear card preview", () => {
  const item = makeItem({
    source: "reddit",
    source_id: "t3_clear",
    kind: "post",
    title: "No spoilers",
    url: SHARP_DIRECT,
    metadata: { over_18: 0, spoiler: 0, thumbnail: SHARP_DIRECT, subreddit: "movies" },
  });

  const out = flat(renderCard(item).value);

  expect(out).not.toContain("is-nsfw");
  expect(out).not.toContain("data-veil=");
  expect(out).toContain('data-thumb="https://i.redd.it/spoil1.jpeg"');
});

test("an existing database is backfilled with spoiler flags from raw JSON", () => {
  const root = mkdtempSync(join(tmpdir(), "ch-spoiler-db-"));
  const path = join(root, "app.db");

  try {
    const connection = db.connect(path);

    db.mergeUpsert(
      connection,
      newItem({
        source: "reddit",
        source_id: "t3_old_spoiler",
        kind: "post",
        title: "Old spoiler",
        metadata: { permalink: COMMENT_PERMALINK },
        raw: { id: "old_spoiler", spoiler: true, permalink: COMMENT_PERMALINK },
      }),
    );
    db.mergeUpsert(
      connection,
      newItem({
        source: "reddit",
        source_id: "t3_old_clear",
        kind: "post",
        title: "Old clear",
        metadata: { permalink: COMMENT_PERMALINK },
        raw: { id: "old_clear", spoiler: false, permalink: COMMENT_PERMALINK },
      }),
    );
    connection.query("DELETE FROM settings WHERE key='spoiler_flags_built'").run();
    connection.close();

    const reopened = db.connect(path);
    const spoiled = parseMetadata(db.getItem(reopened, "reddit:t3_old_spoiler")?.metadata);
    const clear = parseMetadata(db.getItem(reopened, "reddit:t3_old_clear")?.metadata);

    expect(spoiled.spoiler).toBe(1);
    expect(clear.spoiler).toBeUndefined();
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a cached Reddit thread sets and clears the spoiler flag", async () => {
  const connection = db.connect(":memory:");

  try {
    db.mergeUpsert(
      connection,
      newItem({
        source: "reddit",
        source_id: "t3_spoil1",
        kind: "post",
        title: "Finale explained",
        metadata: { permalink: COMMENT_PERMALINK },
      }),
    );
    db.setRedditThread(connection, "reddit:t3_spoil1", threadWith(true), NOW);

    expect(await hydrateIfMissing(connection, "reddit:t3_spoil1")).toMatchObject({
      status: "cached",
    });
    expect(parseMetadata(db.getItem(connection, "reddit:t3_spoil1")?.metadata).spoiler).toBe(1);

    db.setRedditThread(connection, "reddit:t3_spoil1", threadWith(false), NOW);

    expect(await hydrateIfMissing(connection, "reddit:t3_spoil1")).toMatchObject({
      status: "cached",
    });
    expect(parseMetadata(db.getItem(connection, "reddit:t3_spoil1")?.metadata).spoiler).toBe(0);
  } finally {
    connection.close();
  }
});
