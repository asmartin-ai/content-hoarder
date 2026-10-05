import type { Database } from "bun:sqlite";
import { dequeueUnsave, getItem, withTransaction } from "./db.ts";
import { parseMetadata, type Item, type Metadata, type RawItem } from "./models.ts";

const PLACEHOLDER_TITLES = new Set([
  "removed",
  "deleted",
  "private video",
  "deleted video",
  "unavailable video",
  "removed video",
  "deleted by user",
]);

type DuplicateFlagRow = { fullname: string; metadata: string };

type StatusTransition = { status: string; status_prev: string | null };

function normalizedUrl(url: string): string {
  return (url || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("#", 1)[0]!
    .replace(/\/$/, "");
}

function normalizedTitle(title: string): string {
  return (title || "")
    .trim()
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^\p{L}\p{M}\p{N}_\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function groupKey(item: Item, by: string): string {
  if (by === "title") {
    const title = normalizedTitle(item.title);

    return title.length < 8 || PLACEHOLDER_TITLES.has(title) ? "" : `t:${title}`;
  }

  if (by !== "url") throw new Error(`unsupported duplicate key: ${by}`);
  const url = normalizedUrl(item.url);

  return url ? `u:${url}` : "";
}

function richness(item: Item): [number, number, number, string] {
  const metadata = parseMetadata(item.metadata);

  return [item.title ? 1 : 0, Object.keys(metadata).length, -item.first_seen_utc, item.fullname];
}

function richer(a: Item, b: Item): boolean {
  const left = richness(a);
  const right = richness(b);

  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i]! > right[i]!;
  }

  return false;
}

export interface DuplicateGroup {
  key: string;
  count: number;
  suggested_keep: string;
  items: Item[];
}

export function findGroups(
  db: Database,
  opts: { by?: string; status?: string } = {},
): DuplicateGroup[] {
  const by = opts.by ?? "url";
  const status = opts.status ?? "inbox";
  const members = new Map<string, Item[]>();
  const rows = db.query<RawItem, [string]>("SELECT * FROM items WHERE status=?").all(status);

  for (const row of rows) {
    const item: Item = { ...row, metadata: parseMetadata(row.metadata) };
    const key = groupKey(item, by);

    if (!key) continue;
    const group = members.get(key);

    if (group) group.push(item);
    else members.set(key, [item]);
  }

  return [...members]
    .flatMap(([key, items]) => {
      if (items.length < 2) return [];
      let keep = items[0]!;

      for (const item of items.slice(1)) if (richer(item, keep)) keep = item;

      return [{ key, count: items.length, suggested_keep: keep.fullname, items }];
    })
    .sort((a, b) => b.count - a.count);
}

function updateMetadata(
  db: Database,
  fullname: string,
  update: (metadata: Metadata) => void,
): void {
  const item = getItem(db, fullname);

  if (!item) return;
  const metadata = parseMetadata(item.metadata);
  update(metadata);
  db.query("UPDATE items SET metadata=? WHERE fullname=?").run(JSON.stringify(metadata), fullname);
}

export interface FlagDuplicatesResult {
  groups: number;
  flagged: number;
  by: string;
}

export function flagDuplicates(db: Database, opts: { by?: string } = {}): FlagDuplicatesResult {
  const by = opts.by ?? "url";
  const groups = findGroups(db, { by });
  let flagged = 0;
  withTransaction(db, () => {
    for (const group of groups)
      for (const item of group.items) {
        updateMetadata(db, item.fullname, (metadata) => {
          metadata.dup_group = group.key;
          metadata.dup_count = group.count;
        });
        flagged++;
      }
  });

  return { groups: groups.length, flagged, by };
}

export interface ClearFlagsResult {
  cleared: number;
}

export function clearFlags(db: Database): ClearFlagsResult {
  let cleared = 0;
  withTransaction(db, () => {
    const rows = db
      .query<DuplicateFlagRow, []>(
        "SELECT fullname, metadata FROM items WHERE metadata LIKE '%dup_group%'",
      )
      .all();

    for (const { fullname, metadata: encoded } of rows) {
      const metadata = parseMetadata(encoded);

      if (!("dup_group" in metadata) && !("dup_count" in metadata)) continue;
      delete metadata.dup_group;
      delete metadata.dup_count;
      db.query("UPDATE items SET metadata=? WHERE fullname=?").run(
        JSON.stringify(metadata),
        fullname,
      );
      cleared++;
    }
  });

  return { cleared };
}

export interface ResolveGroupResult {
  kept: string;
  archived: number;
}

export function resolveGroup(
  db: Database,
  keepFullname: string,
  archiveFullnames: string[],
): ResolveGroupResult {
  const fullnames = [
    ...new Set(archiveFullnames.flatMap((name) => (name !== keepFullname ? [name] : []))),
  ];

  let archived = 0;
  withTransaction(db, () => {
    const now = Math.floor(Date.now() / 1000);

    for (const fullname of fullnames) {
      archived += db
        .query(
          "UPDATE items SET status_prev=status,status='archived',processed_utc=?,metadata=json_remove(metadata,'$.decayed_at','$.decay_label','$.snoozed_until','$.snoozed_wave') WHERE fullname=? AND status<>'archived'",
        )
        .run(now, fullname).changes;
      updateMetadata(db, fullname, (metadata) => {
        metadata.dedup_of = keepFullname;
      });
    }
  });

  return { kept: keepFullname, archived };
}

export interface UndoResolveResult {
  restored: number;
  fullnames: string[];
}

export function undoResolve(db: Database, fullnames: string[]): UndoResolveResult {
  const names = [
    ...new Set(
      fullnames.flatMap((name) => {
        const trimmed = name.trim();

        return trimmed ? [trimmed] : [];
      }),
    ),
  ];

  let restored = 0;
  withTransaction(db, () => {
    for (const fullname of names) {
      const item = getItem(db, fullname);

      const transition = db
        .query<StatusTransition, [string]>("SELECT status,status_prev FROM items WHERE fullname=?")
        .get(fullname);

      if (item && transition && transition.status_prev !== null) {
        const previous = transition.status_prev;
        db.query(
          "UPDATE items SET status=?,status_prev=NULL,processed_utc=?,metadata=json_remove(metadata,'$.decayed_at','$.decay_label','$.snoozed_until','$.snoozed_wave') WHERE fullname=?",
        ).run(previous, previous === "inbox" ? null : Math.floor(Date.now() / 1000), fullname);

        if (transition.status === "done") dequeueUnsave(db, fullname);
      }

      const after = getItem(db, fullname);

      if (item && after && item.status !== after.status) restored++;
      updateMetadata(db, fullname, (metadata) => {
        delete metadata.dedup_of;
      });
    }
  });

  return { restored, fullnames: names };
}

export interface AutoResolveResult {
  groups: number;
  archived: number;
}

export function autoResolve(db: Database, opts: { by?: string } = {}): AutoResolveResult {
  const groups = findGroups(db, { by: opts.by ?? "url" });
  let archived = 0;

  for (const group of groups) {
    const rest = group.items.flatMap((item) =>
      item.fullname !== group.suggested_keep ? [item.fullname] : [],
    );

    archived += resolveGroup(db, group.suggested_keep, rest).archived;
  }

  return { groups: groups.length, archived };
}
