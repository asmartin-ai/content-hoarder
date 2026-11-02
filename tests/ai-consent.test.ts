import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { aiProviderIsZai, aiProviderLabel } from "../src/assist/consent.ts";
import { privacyPage } from "../src/web/handlers/auth.ts";
import { serveApp } from "../src/web.ts";

const AiStateSchema = z.object({
  configured: z.boolean(),
  consent: z.enum(["on", "off", "unset"]),
  provider: z.string(),
});

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
  restoreEnv();
});

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-ai-consent-"));

  const server = await serveApp({
    dbPath: join(root, "app.db"),
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

async function aiState(base: string): Promise<z.infer<typeof AiStateSchema>> {
  return AiStateSchema.parse(await (await fetch(`${base}/settings/ai`)).json());
}

async function setConsent(base: string, enabled: boolean | string): Promise<Response> {
  return fetch(`${base}/settings/ai`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

test("AI suggestions stay unconfigured without a key and no popup renders", async () => {
  keepEnv("LLM_API_KEY");
  keepEnv("LLM_BASE_URL");
  keepEnv("LLM_PROVIDER_LABEL");

  delete process.env.LLM_API_KEY;
  delete process.env.LLM_BASE_URL;

  await withServer(async (base) => {
    const state = await aiState(base);

    expect(state.configured).toBe(false);
    expect(state.consent).toBe("unset");

    const today = await (await fetch(`${base}/`)).text();

    expect(today).not.toContain("data-ai-consent");
    expect(today).not.toContain("Turn on AI suggestions?");

    const add = await (await fetch(`${base}/add`)).text();

    expect(add).not.toContain("data-ai-toggle");
  });
});

test("a configured provider prompts once and the opt-out is remembered", async () => {
  keepEnv("LLM_API_KEY");
  keepEnv("LLM_BASE_URL");
  keepEnv("LLM_PROVIDER_LABEL");

  delete process.env.LLM_BASE_URL;
  process.env.LLM_API_KEY = "test-key";
  process.env.LLM_PROVIDER_LABEL = "Z.ai (GLM)";

  await withServer(async (base) => {
    expect((await aiState(base)).configured).toBe(true);

    const today = await (await fetch(`${base}/`)).text();

    expect(today).toContain("data-ai-consent");
    expect(today).toContain("Turn on AI suggestions?");
    expect(today).toContain("Z.ai (GLM)");
    expect(today).toContain("first 500 characters of its text");

    const declined = await setConsent(base, false);

    expect(declined.status).toBe(200);
    expect(AiStateSchema.parse(await declined.json()).consent).toBe("off");
    expect((await aiState(base)).consent).toBe("off");
    expect(await (await fetch(`${base}/`)).text()).not.toContain("data-ai-consent");

    const add = await (await fetch(`${base}/add`)).text();

    expect(add).toContain("data-ai-toggle");
    expect(add).toContain("Z.ai (GLM)");
    expect(add).toContain('aria-pressed="false"');

    const accepted = await setConsent(base, true);

    expect(accepted.status).toBe(200);
    expect(AiStateSchema.parse(await accepted.json()).consent).toBe("on");
    expect((await aiState(base)).consent).toBe("on");
    expect(await (await fetch(`${base}/`)).text()).not.toContain("data-ai-consent");
  });
});

test("an invalid consent body is rejected", async () => {
  keepEnv("LLM_API_KEY");

  process.env.LLM_API_KEY = "test-key";

  await withServer(async (base) => {
    expect((await setConsent(base, "yes")).status).toBe(400);
    expect((await aiState(base)).consent).toBe("unset");
  });
});

test("privacy claims follow the provider host", async () => {
  keepEnv("LLM_API_KEY");
  keepEnv("LLM_BASE_URL");
  keepEnv("LLM_PROVIDER_LABEL");

  process.env.LLM_API_KEY = "test-key";
  delete process.env.LLM_PROVIDER_LABEL;
  process.env.LLM_BASE_URL = "https://api.z.ai/api/paas/v4";

  expect(aiProviderIsZai()).toBe(true);
  expect(aiProviderLabel()).toBe("Z.ai (GLM)");

  const zaiPrivacy = await privacyPage().text();

  expect(zaiPrivacy).toContain("Z.ai (GLM)");
  expect(zaiPrivacy).toContain("Singapore");
  expect(zaiPrivacy).toContain("docs.z.ai");

  process.env.LLM_BASE_URL = "https://openrouter.ai/api/v1";
  process.env.LLM_PROVIDER_LABEL = "OpenRouter";

  expect(aiProviderIsZai()).toBe(false);
  expect(aiProviderLabel()).toBe("OpenRouter");

  const otherPrivacy = await privacyPage().text();

  expect(otherPrivacy).toContain("OpenRouter");
  expect(otherPrivacy).toContain("first 500 characters of its text");
  expect(otherPrivacy).toContain("The provider&#39;s own terms apply.");
  expect(otherPrivacy).not.toContain("Singapore");
  expect(otherPrivacy).not.toContain("docs.z.ai");
});
