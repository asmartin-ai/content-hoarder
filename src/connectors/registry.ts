import { existsSync } from "node:fs";
import type { BaseConnector } from "./base.ts";
import { BookmarksConnector } from "./bookmarks.ts";
import { FirefoxConnector } from "./firefox.ts";
import { HackerNewsConnector } from "./hackernews.ts";
import { KeepConnector } from "./keep.ts";
import { LinksConnector } from "./links.ts";
import { ObsidianConnector } from "./obsidian.ts";
import { RedditConnector } from "./reddit.ts";
import { TwitchConnector } from "./twitch.ts";
import { TwitterConnector } from "./twitter.ts";
import { YouTubeConnector } from "./youtube.ts";

export type { BaseConnector, ImportResult } from "./base.ts";

const CONNECTORS: BaseConnector[] = [
  new BookmarksConnector(),
  new RedditConnector(),
  new TwitterConnector(),
  new YouTubeConnector(),
  new HackerNewsConnector(),
  new ObsidianConnector(),
  new KeepConnector(),
  new FirefoxConnector(),
  new TwitchConnector(),
  new LinksConnector(),
];

export const REGISTRY: Record<string, BaseConnector> = Object.fromEntries(
  CONNECTORS.map((connector) => [connector.id, connector]),
);

export function get(id: string): BaseConnector {
  const connector = REGISTRY[id];

  if (!connector) throw new Error(`unknown connector: ${JSON.stringify(id)}`);

  return connector;
}

export function allConnectors(): BaseConnector[] {
  return [...CONNECTORS];
}

export function dispatch(path: string): BaseConnector {
  if (!existsSync(path)) throw new Error(`Nothing found at ${JSON.stringify(path)}`);

  for (const connector of CONNECTORS) {
    try {
      if (connector.canImport(path)) return connector;
    } catch {}
  }

  throw new Error(`No connector recognizes ${JSON.stringify(path)}; pass --source explicitly`);
}
