import { existsSync, readFileSync } from "node:fs";
import * as z from "zod";
import { newItem, type RawItem } from "../models.ts";
import type { BaseConnector } from "./base.ts";

export const TWITCH_FOLLOWS_SCHEMA = "content-hoarder.twitch-follows.v1";

const FollowsFile = z.object({
  schema: z.literal(TWITCH_FOLLOWS_SCHEMA),
  follows: z.array(
    z.object({
      broadcaster_id: z.string().min(1),
      broadcaster_login: z.string().min(1),
      broadcaster_name: z.string().default(""),
      followed_at: z.string().optional(),
    }),
  ),
});

function read(path: string): z.infer<typeof FollowsFile> | null {
  if (!existsSync(path) || !path.toLowerCase().endsWith(".json")) return null;

  try {
    const parsed = FollowsFile.safeParse(JSON.parse(readFileSync(path, "utf8")));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export class TwitchConnector implements BaseConnector {
  readonly id = "twitch";
  readonly label = "Twitch";
  readonly badgeColor = "#9146ff";

  canImport(path: string): boolean {
    return read(path) !== null;
  }

  importFile(path: string): RawItem[] {
    return (read(path)?.follows ?? []).map((follow) => {
      const followed = Date.parse(follow.followed_at ?? "");
      const name = follow.broadcaster_name || follow.broadcaster_login;

      return newItem({
        source: this.id,
        source_id: follow.broadcaster_id,
        kind: "channel",
        title: name,
        author: name,
        url: `https://www.twitch.tv/${follow.broadcaster_login}`,
        created_utc: Number.isFinite(followed) ? Math.floor(followed / 1000) : 0,
        metadata: { broadcaster_login: follow.broadcaster_login },
      });
    });
  }
}
