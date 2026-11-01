import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as z from "zod";
import type { JsonValue } from "../src/models.ts";
import { allConnectors, dispatch, get } from "../src/connectors/registry.ts";

const fixtureRoot = (): string => mkdtempSync(join(tmpdir(), "content-hoarder-connectors-"));

const jsonFile = (path: string, value: JsonValue): string => {
  writeFileSync(path, JSON.stringify(value));

  return path;
};

const fixtureMetadataSchema = z.record(z.string(), z.json());

type FixtureMetadata = z.infer<typeof fixtureMetadataSchema>;

const metadata = (serialized: string | undefined): FixtureMetadata =>
  fixtureMetadataSchema.parse(JSON.parse(serialized ?? "{}"));

test("all offline import connectors shape normalized source items", () => {
  const root = fixtureRoot();

  const redditPath = jsonFile(join(root, "reddit.json"), {
    kind: "Listing",
    data: {
      children: [
        {
          kind: "t3",
          data: {
            id: "abc12",
            name: "t3_abc12",
            permalink: "/r/news/comments/abc12/example/",
            subreddit: "news",
            title: "Example",
            url: "https://v.redd.it/clip",
            created_utc: 1700000000,
            score: 9,
          },
        },
      ],
    },
  });

  const redditExport = join(root, "saved_posts.csv");
  writeFileSync(
    redditExport,
    'id,permalink,subreddit,title,url\nimg12,/r/pics/comments/img12/a_picture/,pics,"Picture, with comma",https://i.redd.it/pic.jpg?width=640&format=jpg\n',
  );

  const youtubePath = jsonFile(join(root, "playlist.json"), {
    _type: "playlist",
    id: "PL-fixture",
    title: "Saved videos",
    entries: [
      { id: "video001", title: "One", channel: "Maker", timestamp: 1700000000 },
      { url: "https://youtu.be/video002", title: "Two" },
    ],
  });

  const hnPath = jsonFile(join(root, "hn.json"), ["8863", 8864]);
  const hnHtmlPath = join(root, "favorites.html");
  writeFileSync(
    hnHtmlPath,
    '<html><a href="https://news.ycombinator.com/item?id=8865">one</a><a href="https://news.ycombinator.com/item?id=8866">two</a><a href="https://news.ycombinator.com/item?id=8865">duplicate</a></html>',
  );
  const hnDatabasePath = join(root, "hn.sqlite");
  const hnDatabase = new Database(hnDatabasePath);
  hnDatabase.exec(
    "CREATE TABLE favorite (itemid INTEGER, title TEXT, url TEXT, time INTEGER); CREATE TABLE read (itemid INTEGER)",
  );
  hnDatabase
    .query("INSERT INTO favorite VALUES (?, ?, ?, ?)")
    .run(8867, "Saved story", "https://example.test/story", 1700000000);
  hnDatabase.query("INSERT INTO read VALUES (?)").run(8868);
  hnDatabase.close();

  const twitterPath = jsonFile(join(root, "bookmarks.json"), [
    {
      id: "1777777777777777777",
      full_text: "A saved post",
      screen_name: "reader",
      created_at: "2024-01-15T10:30:00Z",
      media_urls: ["https://pbs.twimg.com/media/pic.jpg?format=jpg&name=small"],
    },
    {
      id: "1888888888888888888",
      full_text: "A second saved post",
      screen_name: "reader",
      created_at: "2024-01-16T10:30:00Z",
    },
  ]);

  const vault = join(root, "vault");
  mkdirSync(vault);
  const notePath = join(vault, "note.md");
  writeFileSync(
    notePath,
    "---\ntitle: Local note\ntags: [research, read]\ndate: 2024-01-15T00:00:00Z\n---\nSee [[Other Note]] and #inbox",
  );
  const keep = join(root, "Keep");
  mkdirSync(keep);
  jsonFile(join(keep, "note.json"), {
    title: "Keep note",
    textContent: "Visit https://example.test",
    createdTimestampMs: "1700000000000",
    listContent: [
      { text: "Unchecked", checked: false },
      { text: "Checked", isChecked: true },
    ],
    labels: [{ name: "home" }],
  });

  const firefoxPath = jsonFile(join(root, "tabs.json"), {
    schema: "content-hoarder.firefox-tabs.v1",
    captured_at: 1700000000,
    tabs: [
      { url: "https://example.test/path", title: "Example", pinned: true },
      { url: "https://www.youtube.com/watch?v=abcdefghijk", title: "(2) Clip - YouTube" },
      { url: "https://private.test", title: "Private", incognito: true },
    ],
  });

  const redditItems = get("reddit").importFile(redditPath);
  expect(redditItems).toHaveLength(1);
  expect(redditItems[0]).toMatchObject({
    fullname: "reddit:t3_abc12",
    source: "reddit",
    source_id: "t3_abc12",
    kind: "post",
    title: "Example",
    url: "https://www.reddit.com/r/news/comments/abc12/example/",
    author: "",
  });
  expect(metadata(redditItems[0]?.metadata)).toEqual({
    subreddit: "news",
    score: 9,
    permalink: "/r/news/comments/abc12/example/",
    media_type: "reddit_video",
    media_url: "https://v.redd.it/clip",
  });
  const exportItem = get("reddit").importFile(redditExport)[0];
  expect(exportItem).toMatchObject({
    fullname: "reddit:t3_img12",
    title: "Picture, with comma",
    url: "https://i.redd.it/pic.jpg?width=640&format=jpg",
  });
  expect(metadata(exportItem?.metadata)).toEqual({
    subreddit: "pics",
    permalink: "/r/pics/comments/img12/a_picture/",
    media_type: "image",
    saved_seen_utc: expect.any(Number),
  });
  const videos = get("youtube").importFile(youtubePath);

  expect(videos.map((item) => item.fullname)).toEqual(["youtube:video001", "youtube:video002"]);
  expect(metadata(videos[0]?.metadata)).toMatchObject({
    playlist: "Saved videos",
    playlist_id: "PL-fixture",
    position: 0,
    thumbnail: "https://i.ytimg.com/vi/video001/hqdefault.jpg",
  });

  expect(dispatch(hnPath).id).toBe("hackernews");
  expect(
    get("hackernews")
      .importFile(hnPath)
      .map((item) => item.url),
  ).toEqual([
    "https://news.ycombinator.com/item?id=8863",
    "https://news.ycombinator.com/item?id=8864",
  ]);
  expect(get("hackernews").canImport(hnHtmlPath)).toBe(true);
  expect(
    get("hackernews")
      .importFile(hnHtmlPath)
      .map((item) => item.source_id),
  ).toEqual(["8865", "8866"]);
  expect(get("hackernews").canImport(hnDatabasePath)).toBe(true);
  const hnFavorites = get("hackernews").importFile(hnDatabasePath);
  expect(
    hnFavorites.map(({ source_id, title, status, saved_utc }) => ({
      source_id,
      title,
      status,
      saved_utc,
    })),
  ).toEqual([
    { source_id: "8867", title: "Saved story", status: "inbox", saved_utc: 1700000000 },
    { source_id: "8868", title: "", status: "archived", saved_utc: 0 },
  ]);
  const tweets = get("twitter").importFile(twitterPath);
  expect(tweets).toHaveLength(2);
  expect(tweets.map((item) => item.source_id)).toEqual([
    "1777777777777777777",
    "1888888888888888888",
  ]);
  expect(tweets[0]).toMatchObject({
    fullname: "twitter:1777777777777777777",
    title: "A saved post",
    author: "reader",
    url: "https://x.com/reader/status/1777777777777777777",
    created_utc: 1705314600,
  });
  expect(metadata(tweets[0]?.metadata)).toEqual({
    permalink: "https://x.com/reader/status/1777777777777777777",
    author_handle: "reader",
    author_name: "",
    media_urls: ["https://pbs.twimg.com/media/pic.jpg?name=orig"],
    media_type: "image",
    thumbnail: "https://pbs.twimg.com/media/pic.jpg?name=orig",
  });

  expect(dispatch(vault).id).toBe("obsidian");
  const obsidian = get("obsidian").importFile(vault)[0];
  expect(obsidian).toMatchObject({
    fullname: "obsidian:note.md",
    title: "Local note",
    body: "See [[Other Note]] and #inbox",
  });
  expect(metadata(obsidian?.metadata)).toMatchObject({
    tags: ["research", "read", "inbox"],
    wikilinks: ["Other Note"],
    frontmatter: { title: "Local note", tags: ["research", "read"], date: "2024-01-15T00:00:00Z" },
  });
  const keepItem = get("keep").importFile(keep)[0];
  expect(keepItem).toMatchObject({
    fullname: "keep:1700000000000",
    title: "Keep note",
    url: "https://example.test",
  });
  expect(keepItem?.body).toBe("Visit https://example.test\n\n[ ] Unchecked\n[x] Checked");
  expect(metadata(keepItem?.metadata)).toMatchObject({
    labels: ["home"],
    isArchived: false,
    isTrashed: false,
    isPinned: false,
  });

  const tabs = get("firefox").importFile(firefoxPath);
  expect(tabs.map((item) => item.source)).toEqual(["firefox", "youtube"]);
  expect(tabs).toHaveLength(2);
  expect(metadata(tabs[0]?.metadata)).toEqual({
    domain: "example.test",
    open_in_firefox: true,
    pinned: 1,
    firefox_capture_source: "json_export",
    firefox_captured_at: 1700000000,
  });
  expect(allConnectors().map((connector) => connector.id)).toEqual([
    "twitter",
    "reddit",
    "youtube",
    "hackernews",
    "obsidian",
    "keep",
    "firefox",
    "twitch",
    "bookmarks",
    "links",
  ]);
});
