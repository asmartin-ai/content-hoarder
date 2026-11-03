import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "../src/_http.ts";
import { fetchOgImage } from "../src/connectors/hackernews.ts";
import { get } from "../src/connectors/registry.ts";

const FAVORITES_HTML = `<html><head><title>favorites</title></head><body><table>
<tr class="athing submission" id="44510201">
<td class="title"><span class="titleline"><a href="https://example.test/story-a">Story A</a></span></td>
</tr>
<tr><td class="subtext"><a href="item?id=44510201">1 hour ago</a></td></tr>
<tr id='44510202' class='athing submission'>
<td class='title'><span class='titleline'><a class='storylink' href='https://example.test/story-b'>Story &amp; B</a></span></td>
</tr>
<tr><td class="subtext"><a href="item?id=44510202">2 hours ago</a></td></tr>
<tr id="44510203" class="athing comtr">
<td><span class="comhead"><a href="user?id=sample_reader">sample_reader</a></span></td>
<td class="comment"><div class="commtext">A saved comment</div></td>
</tr>
<tr><td class="subtext"><a href="item?id=44510203">3 hours ago</a></td></tr>
<tr><td><a href="https://news.ycombinator.com/item?id=44510204">Legacy anchor row</a></td></tr>
</table></body></html>`;

test("HN favorites HTML keeps every id and titles only real story rows", () => {
  const directory = mkdtempSync(join(tmpdir(), "content-hoarder-hn-html-"));
  const path = join(directory, "favorites.html");
  writeFileSync(path, FAVORITES_HTML);

  try {
    const items = get("hackernews").importFile(path);
    const byId = Object.fromEntries(items.map((item) => [item.source_id, item]));

    expect(items.map((item) => item.source_id)).toEqual([
      "44510201",
      "44510202",
      "44510203",
      "44510204",
    ]);
    expect(byId["44510201"]).toMatchObject({
      title: "Story A",
      url: "https://example.test/story-a",
    });
    expect(byId["44510202"]).toMatchObject({
      title: "Story & B",
      url: "https://example.test/story-b",
    });
    expect(byId["44510203"]).toMatchObject({
      title: "",
      url: "https://news.ycombinator.com/item?id=44510203",
    });
    expect(byId["44510204"]).toMatchObject({
      title: "",
      url: "https://news.ycombinator.com/item?id=44510204",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
