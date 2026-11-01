import { expect, test } from "bun:test";
import { request } from "../src/_http.ts";
import { fetchOgImage } from "../src/connectors/hackernews.ts";

test("the HN og:image fetch refuses loopback and reserved article targets", async () => {
  let hits = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      hits++;

      return new Response('<meta property="og:image" content="https://x.test/og.png">', {
        headers: { "content-type": "text/html" },
      });
    },
  });

  try {
    for (const url of [
      `http://127.0.0.1:${server.port}/article`,
      `http://localhost:${server.port}/article`,
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/",
      "http://192.168.1.1/admin",
    ])
      expect(await fetchOgImage(url)).toBe("");

    expect(hits).toBe(0);

    const [, , raw] = await request(`http://127.0.0.1:${server.port}/article`, {
      allowLoopback: true,
      timeout: 5,
    });

    expect(new TextDecoder().decode(raw)).toContain("og:image");
    expect(hits).toBe(1);
  } finally {
    server.stop(true);
  }
});
