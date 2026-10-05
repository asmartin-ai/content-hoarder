import { expect, test } from "bun:test";
import { ArchiveError, PullPushProvider } from "../src/archival/providers";

test("PullPush validates ids, batches records, and normalizes Reddit media", async () => {
  const urls: string[] = [];

  const provider = new PullPushProvider("test-agent", {
    minInterval: 0,
    fetchJson: async (url) => {
      urls.push(url);

      return [
        200,
        {},
        {
          data: [
            {
              id: "abc123",
              title: "A post",
              selftext: "body",
              permalink: "/r/example/comments/abc123/a_post/",
              post_hint: "image",
              url: "https://i.redd.it/photo.jpg",
              preview: { images: [{ source: { url: "https://preview.redd.it/photo.jpg?amp" } }] },
            },
          ],
        },
      ];
    },
  });

  const posts = await provider.fetchPosts(["abc123", "bad&ids=1"]);
  expect(Object.keys(posts)).toEqual(["abc123"]);
  expect(posts.abc123).toMatchObject({
    title: "A post",
    body: "body",
    permalink: "https://www.reddit.com/r/example/comments/abc123/a_post/",
    media_type: "image",
    media_url: "https://i.redd.it/photo.jpg",
    thumbnail: "https://preview.redd.it/photo.jpg?amp",
  });
  expect(urls).toEqual(["https://api.pullpush.io/reddit/search/submission/?ids=abc123"]);
});

test("archive providers reject malformed source payloads", async () => {
  const provider = new PullPushProvider("test-agent", {
    fetchJson: async () => [200, {}, { unexpected: true }],
  });

  await expect(provider.fetchPosts(["abc123"])).rejects.toBeInstanceOf(ArchiveError);
});
