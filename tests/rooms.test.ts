import { expect, test } from "bun:test";
import { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../src/db.ts";
import { newItem } from "../src/models.ts";
import { serveApp } from "../src/web.ts";

const DAY = 86_400;

const NOW = Math.floor(Date.now() / 1000);

const DealSchema = z.object({
  items: z.array(z.object({ fullname: z.string(), status: z.string(), html: z.string() })),
});

const TriggerSchema = z.object({
  "ch:wins": z.null(),
  "ch:toast": z.object({
    msg: z.string(),
    undo: z
      .object({ post: z.string(), vals: z.object({ wave: z.number() }), target: z.string() })
      .optional(),
  }),
});

/** Synthetic inbox: one meme pile (a sweep candidate) of twelve Reddit posts. */
function seed(path: string): void {
  const connection = db.connect(path);

  for (let index = 0; index < 12; index++) {
    db.mergeUpsert(
      connection,
      newItem({
        source: "reddit",
        source_id: `t3_room_${index}`,
        title: `Crayon meme ${index}`,
        created_utc: NOW - (index + 1) * 30 * DAY,
        metadata: { subreddit: "NonCredibleDefense", score: 100 + index },
      }),
    );
  }

  connection.close();
}

async function withServer(fn: (base: string, path: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-rooms-"));
  const databasePath = join(root, "app.db");

  seed(databasePath);
  const server = await serveApp({ dbPath: databasePath, host: "127.0.0.1", port: 0 });

  try {
    await fn(`http://127.0.0.1:${server.port}`, databasePath);
  } finally {
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

function statuses(path: string): Record<string, number> {
  const connection = db.connect(path);

  try {
    const list = connection
      .query<{ status: string; c: number }, []>(
        "SELECT status, COUNT(*) AS c FROM items GROUP BY status",
      )
      .all();

    return Object.fromEntries(list.map((row) => [row.status, row.c]));
  } finally {
    connection.close();
  }
}

function form(base: string, path: string, values: Record<string, string>): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "HX-Request": "true" },
    body: new URLSearchParams(values).toString(),
  });
}

/** The ids Up next dealt, read from its out-of-band #hero-go replacement. */
function heroIds(fragment: string): string[] {
  const hero = /<a class="hero-go" id="hero-go" href="([^"]+)" hx-swap-oob="true"/.exec(
    fragment.replace(/\s+/g, " "),
  );

  expect(hero).not.toBeNull();
  const href = (hero?.[1] ?? "").replaceAll("&amp;", "&");

  return (new URL(href, "http://x").searchParams.get("ids") ?? "").split(",").filter(Boolean);
}

test("Today is a server-rendered page that refuses framing", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/?n=5`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(response.headers.get("Set-Cookie")).toContain("ch_round_size=5");
    expect(body).toContain('id="hero-go"');
    expect(body).toContain('hx-get="/hx/today/upnext?n=5"');
    expect(body).toMatch(/hx-get="\/hx\/today\/upnext\?n=5"[^>]*aria-current="page"/);
    expect(body.match(/hx-get="\/hx\/today\/upnext\?n=\d+"[^>]*aria-current/g)).toHaveLength(1);
    expect(body).toContain("/static/vendor/htmx.min.js");

    const clear = await fetch(`${base}/clear`);
    const page = await clear.text();

    expect(clear.headers.get("X-Frame-Options")).toBe("DENY");
    expect(page).toContain('class="has-tabbar is-round"');
    expect(page).toContain('<section class="round" data-state="loading">');
  });
});

test("Up next deals the round that /clear/deal plays, in order", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/hx/today/upnext?n=5`);
    const fragment = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(fragment).toContain('id="upnext"');
    expect(fragment).toContain('id="hero-sizes"');

    const ids = heroIds(fragment);

    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    expect(ids.every((id) => id.startsWith("reddit:t3_room_"))).toBe(true);

    const dealt = DealSchema.parse(
      await (await fetch(`${base}/clear/deal?n=5&ids=${encodeURIComponent(ids.join(","))}`)).json(),
    );

    expect(dealt.items.map((item) => item.fullname)).toEqual(ids);
    expect(dealt.items.every((item) => item.status === "inbox")).toBe(true);
    expect(dealt.items.every((item) => item.html.includes('class="card"'))).toBe(true);
  });
});

test("/clear/deal skips an id that left the inbox", async () => {
  await withServer(async (base) => {
    const ids = heroIds(await (await fetch(`${base}/hx/today/upnext?n=5`)).text());
    const decided = ids[1] ?? "";

    const status = await fetch(`${base}/items/${encodeURIComponent(decided)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });

    expect(status.status).toBe(200);

    const dealt = DealSchema.parse(
      await (await fetch(`${base}/clear/deal?ids=${encodeURIComponent(ids.join(","))}`)).json(),
    );

    expect(dealt.items.map((item) => item.fullname)).toEqual(ids.filter((id) => id !== decided));
  });
});

test("an empty inbox deals nothing instead of failing", async () => {
  await withServer(async (base, path) => {
    const connection = db.connect(path);

    connection.run("UPDATE items SET status = 'done'");
    connection.close();

    const dealt = await fetch(`${base}/clear/deal?n=10`);

    expect(dealt.status).toBe(200);
    expect(DealSchema.parse(await dealt.json()).items).toEqual([]);

    const upnext = await fetch(`${base}/hx/today/upnext?n=10`);

    expect(upnext.status).toBe(200);
    expect(await upnext.text()).toContain('class="upnext-empty"');
  });
});

test("letting a pile go from Today toasts a wave, and undo restores it", async () => {
  await withServer(async (base, path) => {
    const piles = await (await fetch(`${base}/hx/today/piles`)).text();

    expect(piles).toContain('id="piles"');
    expect(piles).toContain("r/NonCredibleDefense");
    expect(piles).toContain('hx-post="/hx/sweeps/apply"');

    const applied = await form(base, "/hx/sweeps/apply", {
      kind: "subreddit",
      source: "reddit",
      subreddit: "NonCredibleDefense",
    });

    expect(applied.status).toBe(200);
    const trigger = TriggerSchema.parse(JSON.parse(applied.headers.get("HX-Trigger") ?? "{}"));

    expect(trigger["ch:toast"].msg).toBe("12 r/NonCredibleDefense saves rested.");
    expect(trigger["ch:toast"].undo?.post).toBe("/hx/sweeps/undo");
    expect(trigger["ch:toast"].undo?.target).toBe("#piles");
    expect(await applied.text()).toContain('<section class="piles" id="piles" hidden>');
    expect(statuses(path)).toEqual({ archived: 12 });

    const wave = trigger["ch:toast"].undo?.vals.wave ?? 0;
    const undone = await form(base, "/hx/sweeps/undo", { wave: String(wave) });

    expect(undone.status).toBe(200);
    const undoTrigger = TriggerSchema.parse(JSON.parse(undone.headers.get("HX-Trigger") ?? "{}"));

    expect(undoTrigger["ch:toast"].msg).toBe("Back in the pile.");
    expect(await undone.text()).toContain("r/NonCredibleDefense");
    expect(statuses(path)).toEqual({ inbox: 12 });
  });
});

test("wins and whisper partials render without backlog totals", async () => {
  await withServer(async (base) => {
    const wins = await (
      await fetch(`${base}/hx/today/wins`, { headers: { Cookie: "ch_goal=3" } })
    ).text();

    // ch_goal sets the pebble ring: one arc per pebble, none lit on an empty day.
    expect(wins.match(/class="arc"/g)).toHaveLength(3);
    expect(wins).not.toContain('class="arc on"');

    const noGoal = await (
      await fetch(`${base}/hx/today/wins`, { headers: { Cookie: "ch_goal=0" } })
    ).text();

    expect(noGoal).not.toContain('class="ring');

    const whisper = await (await fetch(`${base}/hx/today/whisper`)).text();

    expect(whisper).toContain('id="whisper"');
  });
});
