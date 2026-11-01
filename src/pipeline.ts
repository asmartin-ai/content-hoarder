import type { Database } from "bun:sqlite";
import {
  allocateSavedOrder,
  mergeUpsert,
  mergeUpsertMany,
  reconcileRedditSaves,
  withTransaction,
} from "./db.ts";
import { parseMetadata, type RawItem } from "./models.ts";
import { dispatch, get, type BaseConnector, type ImportResult } from "./connectors/registry.ts";

export function applyMonotonicSavedOrder(db: Database, items: RawItem[]): void {
  const ranked = items.filter((it) => {
    if (it.source !== "reddit" || it.saved_utc) return false;
    const md = parseMetadata(it.metadata);

    return md.saved_seen_utc !== undefined && md.saved_seen_utc !== null;
  });

  if (!ranked.length) return;
  const top = allocateSavedOrder(db, ranked.length);
  ranked.forEach((it, i) => {
    it.saved_utc = top - i;
  });
}

export async function importPath(
  db: Database,
  path: string,
  opts: {
    source?: string | null;
    enrich?: boolean;
    reconcile?: boolean;
    reconcileDryRun?: boolean;
    reconcileComplete?: boolean;
  } = {},
): Promise<ImportResult> {
  const connector = opts.source ? get(opts.source) : dispatch(path);

  const result: ImportResult = {
    imported: 0,
    skipped: 0,
    errors: [],
    reconcile: null,
  };

  const batch: RawItem[] = [];
  const doReconcile = Boolean(opts.reconcile || opts.reconcileDryRun);

  const present: Record<"post" | "comment", Set<string>> = {
    post: new Set(),
    comment: new Set(),
  };

  const items = connector.importFile(path);
  withTransaction(db, () => {
    applyMonotonicSavedOrder(db, items);

    for (const item of items) {
      if (doReconcile && item.source === "reddit") {
        if (item.kind === "post" || item.kind === "comment") {
          present[item.kind].add(item.source_id);
        }
      }
    }

    const merged = mergeUpsertMany(db, items);
    const failed = new Set(merged.errors.map((error) => error.fullname));

    result.imported = merged.inserted + merged.updated;
    result.skipped = merged.errors.length;

    for (const error of merged.errors) result.errors.push(`${error.fullname}: ${error.message}`);

    for (const item of items) if (!failed.has(item.fullname)) batch.push(item);

    if (doReconcile && (present.post.size || present.comment.size)) {
      const truncated = opts.reconcileComplete ? { post: false, comment: false } : null;

      result.reconcile = reconcileRedditSaves(db, present, {
        dryRun: Boolean(opts.reconcileDryRun),
        truncatedByKind: truncated,
      });
    }
  });

  if (opts.enrich && batch.length) {
    await enrichBatch(db, connector, batch, result);
  }

  return result;
}

async function enrichBatch(
  db: Database,
  connector: BaseConnector,
  items: RawItem[],
  result: ImportResult,
): Promise<void> {
  let enriched: RawItem[];

  try {
    enriched = connector.enrich ? await connector.enrich(items) : items;
  } catch (exc) {
    result.errors.push(`enrich: ${exc instanceof Error ? exc.message : String(exc)}`);

    return;
  }

  withTransaction(db, () => {
    for (const item of enriched) {
      try {
        mergeUpsert(db, item);
      } catch (exc) {
        result.errors.push(
          `enrich ${item.fullname}: ${exc instanceof Error ? exc.message : String(exc)}`,
        );
      }
    }
  });
}
