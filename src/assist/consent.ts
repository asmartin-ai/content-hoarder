import type { Database } from "bun:sqlite";
import * as config from "../config.ts";
import { getSetting, setSetting } from "../db.ts";

export const AI_CONSENT_KEY = "ai_suggestions";

export const AI_FIELDS_SENT =
  "each dealt card's source, title, author, subreddit or channel, URL, the first 500 characters of its text, and one line of your own decision counts for that card's source (for example, \"You archived 9 of 10 from r/pics\"; never other items' titles)";

export type AiConsent = "on" | "off" | "unset";

export function aiConfigured(): boolean {
  return Boolean(config.get("LLM_API_KEY") || process.env.LLM_BASE_URL);
}

export function aiProviderIsZai(): boolean {
  const base = config.get("LLM_BASE_URL");
  let host: string;

  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    return false;
  }

  return host === "api.z.ai" || host.endsWith(".z.ai");
}

export function aiProviderLabel(): string {
  const label = config.get("LLM_PROVIDER_LABEL");

  if (label) return label;

  return aiProviderIsZai() ? "Z.ai (GLM)" : "an AI provider";
}

export function aiConsent(database: Database): AiConsent {
  const value = getSetting(database, AI_CONSENT_KEY);

  return value === "1" ? "on" : value === "0" ? "off" : "unset";
}

export function setAiConsent(database: Database, on: boolean): void {
  setSetting(database, AI_CONSENT_KEY, on ? "1" : "0");
}

export function aiActive(database: Database): boolean {
  return aiConfigured() && aiConsent(database) === "on";
}
