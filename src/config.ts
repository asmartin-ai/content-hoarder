import { readFileSync } from "node:fs";

const _DEFAULTS = {
  CONTENT_HOARDER_OFFLINE: "",
  CONTENT_HOARDER_DB: "data/app.db",
  CONTENT_HOARDER_NSFW_RULES: "nsfw_rules.json",
  CONTENT_HOARDER_HOST: "127.0.0.1",
  CONTENT_HOARDER_PORT: "8788",
  CONTENT_HOARDER_TLS: "",
  USER_AGENT: "content-hoarder/0.1 (local personal use)",
  REDDIT_BROWSER_USER_AGENT:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0",
  REDDIT_OAUTH_CLIENT_ID: "",
  REDDIT_OAUTH_REDIRECT_URI: "redreader://rr_oauth_redir",
  KARAKEEP_BASE_URL: "",
  KARAKEEP_API_KEY: "",
  PKMS_CAPTURE_URL: "",
  PKMS_CAPTURE_TOKEN: "",
  LLM_BASE_URL: "http://127.0.0.1:1234/v1",
  LLM_MODEL: "",
} satisfies Record<string, string>;

export function loadEnv(path?: string): void {
  const envPath = path ?? ".env";
  let content: string;

  try {
    content = readFileSync(envPath, "utf8").replace(/^﻿/, "");
  } catch {
    return;
  }

  for (const raw of content.split("\n")) {
    const line = raw.trim();

    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function hasDefault(key: string): key is keyof typeof _DEFAULTS {
  return Object.hasOwn(_DEFAULTS, key);
}

export function get(key: string): string {
  const v = process.env[key];

  return v !== undefined ? v : hasDefault(key) ? _DEFAULTS[key] : "";
}

export function dbPath(): string {
  return get("CONTENT_HOARDER_DB");
}

export function offline(): boolean {
  return get("CONTENT_HOARDER_OFFLINE") === "1";
}

export function host(): string {
  return get("CONTENT_HOARDER_HOST");
}

export function port(): number {
  const n = Number.parseInt(get("CONTENT_HOARDER_PORT"), 10);

  return Number.isNaN(n) ? 8788 : n;
}
