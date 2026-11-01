import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../src/db.ts";
import { newItem, parseMetadata, type Item, type NewItemInput } from "../src/models.ts";
import { renderCard } from "../src/web/views/card.ts";
import { html, raw } from "../src/web/views/html.ts";
import { cardMedia, compact, costLabel, domainOf } from "../src/web/views/media.ts";
import { topComment } from "../src/web/views/thread.ts";

const NOW = 1_760_000_000;

function makeItem(input: NewItemInput): Item {
  const rawItem = newItem({ now: NOW, created_utc: NOW - 3 * 86_400, ...input });

  return { ...rawItem, metadata: parseMetadata(rawItem.metadata) };
}

function flat(markup: string): string {
  return markup
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    .replace(/\s+(\/?>)/g, "$1");
}

test("html escapes interpolations but keeps SafeHtml", () => {
  expect(
    flat(
      html`<p>${"<b>&"}</p>
        ${raw("<i>ok</i>")}${null}${false}`.value,
    ),
  ).toBe("<p>&lt;b&gt;&amp;</p><i>ok</i>");
});

test("a hostile title renders escaped", () => {
  const item = makeItem({
    source: "reddit",
    source_id: "t3_esc",
    kind: "post",
    title: '<script>alert("x")</script>',
    metadata: { subreddit: "test" },
  });

  const out = flat(renderCard(item).value);

  expect(out).not.toContain("<script>");
  expect(out).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  expect(out).toContain('<h2 class="card-title">');
  expect(out).toContain("<b>r/test</b>");
});

test("a reddit comment renders context and no title", () => {
  const item = makeItem({
    source: "reddit",
    source_id: "t1_c1",
    kind: "comment",
    title: "Post title",
    body: "The **saved** comment.",
    author: "someone",
    metadata: { subreddit: "ADHD", permalink: "/r/ADHD/comments/p1/post_title/c1/", score: 12 },
  });

  const out = flat(renderCard(item).value);

  expect(out).toContain('data-kind="comment"');
  expect(out).toContain('<p class="card-context">Comment on <b>Post title</b></p>');
  expect(out).not.toContain("card-title");
  expect(out).toContain('class="card-body md is-comment"');
  expect(out).toContain("<strong>saved</strong>");
  expect(out).toContain('<span class="card-by">u/someone</span>');
});

test("removed placeholders are not rendered as a body", () => {
  const item = makeItem({
    source: "reddit",
    source_id: "t3_gone",
    kind: "post",
    title: "Gone",
    body: "[removed]",
  });

  const out = renderCard(item).value;

  expect(out).not.toContain("card-body");
  expect(out).toContain('class="card-note"');
});

test("a zero-score post has no score stat", () => {
  const item = makeItem({
    source: "reddit",
    source_id: "t3_zero",
    kind: "post",
    title: "Quiet post",
    metadata: { subreddit: "ADHD", score: 0, num_comments: 0 },
  });

  const out = renderCard(item).value;

  expect(out).not.toContain("stat-score");
  expect(out).not.toContain("stat-comments");
});

test("a gallery shows the count badge and a glance", () => {
  const item = makeItem({
    source: "reddit",
    source_id: "t3_gal",
    kind: "post",
    title: "Three pics",
    url: "https://www.reddit.com/gallery/gal",
    metadata: {
      media_type: "gallery",
      gallery: ["https://i.redd.it/a.jpg", "https://i.redd.it/b.jpg", "https://i.redd.it/c.jpg"],
    },
  });

  const out = flat(renderCard(item).value);

  expect(out).toContain('data-media="gallery"');
  expect(out).toContain('<span class="media-badge">1 / 3</span>');
  expect(out).toContain('loading="eager" decoding="async"/>');
  expect(costLabel(item)).toBe("a glance");
});

test("a YouTube item shows the duration badge and video cost", () => {
  const item = makeItem({
    source: "youtube",
    source_id: "dQw4w9WgXcQ",
    kind: "video",
    title: "A talk",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    metadata: { channel: "Some Channel", duration: 724, view_count: 1_234_567 },
  });

  const out = flat(renderCard(item).value);

  expect(out).toContain('src="https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg"');
  expect(out).toContain('data-fallback="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"');
  expect(out).toContain('<span class="media-badge">▶ 12:04</span>');
  expect(out).toContain('<span class="cost">12 min video</span>');
  expect(out).toContain("1.2M views");
  expect(out).toContain("<b>Some Channel</b>");
});

test("archived media becomes the data-fallback", () => {
  const item = makeItem({
    source: "reddit",
    source_id: "t3_img",
    kind: "post",
    title: "A picture",
    url: "https://i.redd.it/abc.jpg",
    metadata: {
      over_18: true,
      archived_media: { "https://i.redd.it/abc.jpg": "deadbeef.jpg" },
    },
  });

  const out = flat(renderCard(item).value);

  expect(cardMedia(item)).toEqual({
    kind: "image",
    src: "https://i.redd.it/abc.jpg",
    fallback: "/media/deadbeef.jpg",
  });
  expect(out).toContain('data-fallback="/media/deadbeef.jpg"');
  expect(out).toContain('class="card-media is-nsfw"');
  expect(out).toContain('<span class="tag tag-nsfw">NSFW</span>');
});

test("formatting helpers", () => {
  expect(compact(950)).toBe("950");
  expect(compact(4200)).toBe("4.2k");
  expect(compact(12_345)).toBe("12k");
  expect(domainOf("https://www.example.com/a")).toBe("example.com");
  expect(domainOf("javascript:alert(1)")).toBe("");
});

test("a cached thread supplies the top comment, skipping stickied and the saved comment", () => {
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-card-"));
  const connection = db.connect(join(root, "test.db"));

  const comment = (id: string, author: string, score: number, body: string, stickied = false) => ({
    kind: "t1",
    data: { id, name: `t1_${id}`, author, score, body, stickied },
  });

  const listing = [
    { kind: "Listing", data: { children: [{ kind: "t3", data: { id: "p1", title: "Post" } }] } },
    {
      kind: "Listing",
      data: {
        children: [
          comment("mod", "AutoModerator", 999, "Please read the rules", true),
          comment("c1", "saver", 500, "The saved comment"),
          comment("c2", "alice", 50, "Best &amp; brightest"),
          comment("c3", "bob", 10, "Also here"),
          { kind: "more", data: { count: 3 } },
        ],
      },
    },
  ];

  try {
    db.setRedditThread(connection, "reddit:t3_p1", JSON.stringify(listing), NOW);

    const post = makeItem({
      source: "reddit",
      source_id: "t3_p1",
      kind: "post",
      title: "Post",
      metadata: { permalink: "/r/test/comments/p1/post/" },
    });

    const top = topComment(connection, post);

    expect(top).toEqual({ author: "saver", score: 500, body: "The saved comment" });

    const saved = makeItem({
      source: "reddit",
      source_id: "t1_c1",
      kind: "comment",
      title: "Post",
      body: "The saved comment",
      metadata: { permalink: "/r/test/comments/p1/post/c1/" },
    });

    const reply = topComment(connection, saved);

    expect(reply).toEqual({ author: "alice", score: 50, body: "Best & brightest" });
    const out = flat(renderCard(saved, { topComment: reply }).value);

    expect(out).toContain('<aside class="card-reply">');
    expect(out).toContain("Top comment · u/alice · ▲ 50");
    expect(out).toContain("Best &amp; brightest");
    expect(out).not.toContain("Please read the rules");

    const uncached = makeItem({ source: "reddit", source_id: "t3_none", kind: "post" });

    expect(topComment(connection, uncached)).toBeNull();
  } finally {
    connection.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Reddit's &#x200B; paragraph padding never prints as text", () => {
  const item = makeItem({
    source: "reddit",
    source_id: "t3_zw",
    kind: "post",
    title: "Spacer",
    body: "First paragraph.\n\n&#x200B;\n\nSecond paragraph.",
    metadata: { subreddit: "test" },
  });

  const out = renderCard(item).value;

  expect(out).not.toContain("x200B");
  expect(out).toContain("Second paragraph.");
});
