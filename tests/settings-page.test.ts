import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import * as db from "../src/db.ts";
import { newItem } from "../src/models.ts";
import { serveApp } from "../src/web.ts";

const RetentionPreviewSchema = z.object({
  preview: z.object({ total: z.number(), cutoff: z.number() }),
});

const PurgedSchema = z.object({ purged: z.object({ total: z.number() }) });

const saved: Record<string, string | undefined> = {};

function keepEnv(key: string): void {
  saved[key] = process.env[key];
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  setSystemTime(new Date());
  restoreEnv();
});

async function withServer(
  fn: (base: string) => Promise<void>,
  seed?: (path: string) => void,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-settings-"));
  const databasePath = join(root, "app.db");

  seed?.(databasePath);

  const server = await serveApp({
    dbPath: databasePath,
    host: "127.0.0.1",
    port: 0,
  });

  try {
    await fn(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

function unconfigureAi(): void {
  keepEnv("LLM_API_KEY");
  keepEnv("LLM_BASE_URL");
  keepEnv("LLM_PROVIDER_LABEL");

  delete process.env.LLM_API_KEY;
  delete process.env.LLM_BASE_URL;
}

function configureAi(): void {
  unconfigureAi();

  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_PROVIDER_LABEL = "Z.ai (GLM)";
}

test("/settings renders the settings groups without AI when no provider is configured", async () => {
  unconfigureAi();

  await withServer(async (base) => {
    const page = await (await fetch(`${base}/settings`)).text();

    expect(page).toContain("Settings");
    expect(page).not.toContain("Show reasons");
    expect(page).toContain("Theme");
    expect(page).toContain("Daily goal");
    expect(page).toContain("Done retention");
    expect(page).toContain("Reddit unsave");
    expect(page).toContain("Library tools");
    expect(page).toContain('href="/settings"');
    expect(page).not.toContain("AI suggestions");
  });
});

test("/settings names the configured AI provider", async () => {
  configureAi();

  await withServer(async (base) => {
    const page = await (await fetch(`${base}/settings`)).text();

    expect(page).toContain("AI suggestions");
    expect(page).toContain("Z.ai (GLM)");
    expect(page).not.toContain("Show reasons");
  });
});

test("the removed hint reasons routes are gone", async () => {
  await withServer(async (base) => {
    expect((await fetch(`${base}/settings/hints`)).status).toBe(404);
    expect(
      (
        await fetch(`${base}/settings/hints`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reasons: true }),
        })
      ).status,
    ).toBe(404);
  });
});

test("Add links to settings for AI instead of showing a switch", async () => {
  configureAi();

  await withServer(async (base) => {
    const add = await (await fetch(`${base}/add`)).text();

    expect(add).toContain("AI suggestions: Off");
    expect(add).toContain('href="/settings"');
    expect(add).not.toContain("data-ai-toggle");
    expect(add).not.toContain("Let go");
  });
});

test("room pages serve their stylesheet link unescaped", async () => {
  unconfigureAi();

  await withServer(async (base) => {
    const pages: Array<[string, string]> = [
      ["/", "/static/home/today.css"],
      ["/home", "/static/home/orient.css"],
      ["/clear", "/static/home/clear.css"],
      ["/add", "/static/add/add.css"],
      ["/settings", "/static/home/home.css"],
    ];

    for (const [path, sheet] of pages) {
      const page = await (await fetch(`${base}${path}`)).text();

      expect(page).toContain(`<link rel="stylesheet" href="${sheet}"`);
      expect(page).not.toContain("&lt;link");
    }
  });
});

test("the Library shell links to settings and no longer carries the settings sheet", async () => {
  unconfigureAi();

  await withServer(async (base) => {
    const library = await (await fetch(`${base}/library`)).text();

    expect(library).toContain('href="/settings"');
    expect(library).not.toContain('id="settings"');
    expect(library).not.toContain("set-done-retention");
    expect(library).not.toContain('open-settings" type="button"');
  });
});

test("a non-preset retention value stays visible and selected", async () => {
  await withServer(async (base) => {
    const saved = await fetch(`${base}/settings/done-retention`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ retention_days: 14 }),
    });

    expect(saved.status).toBe(200);

    const page = await (await fetch(`${base}/settings`)).text();

    expect(page).toContain("Current window: 14 days.");
    expect(page).toContain('data-days="14"');
    expect(page).toMatch(/data-settings-retention="14"[\s\S]{0,80}aria-pressed="true"/);
  });
});

function seedDone(path: string, processedUtc: number): void {
  const connection = db.connect(path);

  const item = newItem({
    source: "reddit",
    source_id: "t3_settings_purge",
    title: "Old Done item",
  });

  db.mergeUpsert(connection, item);
  connection
    .query("UPDATE items SET status='done', processed_utc=? WHERE fullname=?")
    .run(processedUtc, item.fullname);
  connection.close();
}

test("a delayed purge confirmation still deletes the previewed set", async () => {
  const now = Math.floor(Date.now() / 1000);

  await withServer(
    async (base) => {
      const { preview } = RetentionPreviewSchema.parse(
        await (await fetch(`${base}/settings/done-retention`)).json(),
      );

      expect(preview.total).toBe(1);

      setSystemTime(new Date(Date.now() + 5000));

      const response = await fetch(`${base}/settings/done-retention/purge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_total: preview.total,
          expected_cutoff: preview.cutoff,
        }),
      });

      expect(response.status).toBe(200);
      expect(PurgedSchema.parse(await response.json()).purged.total).toBe(1);
    },
    (path) => seedDone(path, now - 40 * 86_400),
  );
});

test("a purge confirmed after the retention window widened is rejected", async () => {
  const now = Math.floor(Date.now() / 1000);

  await withServer(
    async (base) => {
      const { preview } = RetentionPreviewSchema.parse(
        await (await fetch(`${base}/settings/done-retention`)).json(),
      );

      await fetch(`${base}/settings/done-retention`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ retention_days: 365 }),
      });

      const response = await fetch(`${base}/settings/done-retention/purge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_total: preview.total,
          expected_cutoff: preview.cutoff,
        }),
      });

      expect(response.status).toBe(409);
      expect(RetentionPreviewSchema.parse(await response.json()).preview.total).toBe(0);
    },
    (path) => seedDone(path, now - 40 * 86_400),
  );
});

test("the consent dialog keeps two short lines and tucks the field list into details", async () => {
  configureAi();

  await withServer(async (base) => {
    const today = await (await fetch(`${base}/`)).text();

    expect(today).toContain("Turn on AI suggestions?");
    expect(today).toContain("Khaos highlights the button the AI would pick. You still decide.");
    expect(today).toContain("Card details go to <b>Z.ai (GLM)</b>.");
    expect(today).toContain('<details class="ai-consent-details">');
    expect(today).toContain("<summary>What's sent</summary>");
    expect(today).not.toContain('<details class="ai-consent-details" open');
    expect(today).toContain("first 500 characters of its text");
    expect(today).toContain("Not now");
    expect(today).not.toContain('href="/privacy"');
  });
});
