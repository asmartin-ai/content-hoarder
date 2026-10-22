/**
 * Ingestion pipeline: dispatch -> importPath -> mergeUpsert ->
 * (optional) enrich.
 *
 * The SOLE owner of database writes during import. Connectors
 * only parse and yield.
 */

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

/**
 * Assign each reddit import's synthetic ``saved_utc`` as a
 * contiguous block ABOVE all prior ingests, so "sort by saved
 * newest" stays coherent across imports made at different times
 * (the older per-import wall-clock anchor left disjoint bands).
 * Imports AND cookie syncs share one monotonic counter via
 * `allocateSavedOrder`.
 *
 * Only rows from an authoritative saved-list snapshot (the
 * ``saved_seen_utc`` marker) AND lacking a real explicit
 * ``saved_utc`` are ranked — bulk JSON dumps and rows carrying a
 * genuine save time are left untouched. The counter advance is
 * folded into the import's transaction, so a crash rolls back
 * the anchor with the rows it ranked.
 */
export function applyMonotonicSavedOrder(db: Database, items: RawItem[]): void {
  const ranked = items.filter((it) => {
    if (it.source !== "reddit" || it.saved_utc) return false;
    const md = parseMetadata(it.metadata);

    return md.saved_seen_utc !== undefined && md.saved_seen_utc !== null;
  });

  if (!ranked.length) return;
  const top = allocateSavedOrder(db, ranked.length);
  ranked.forEach((it, i) => {
    // items are newest-first within the export
    it.saved_utc = top - i;
  });
}

/**
 * Import a file/dir into the DB. Returns counts + per-item errors.
 *
 * ``reconcile`` (or ``reconcileDryRun``): treat this import as a
 * fresh reddit saved-list snapshot and mark still-saved reddit
 * items absent from it as un-saved (per-type cap-guarded; see
 * `reconcileRedditSaves`). Only meaningful for a reddit
 * saved-list export. ``reconcileComplete`` asserts the export is
 * the COMPLETE saved list (e.g. a GDPR data export), so
 * reconciliation runs even at/above the ~1000-per-type listing
 * cap instead of being skipped as possibly-truncated (B2). Leave
 * it off for a possibly page-truncated dump.
 */
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
      // Record presence from the parsed export even when an upsert fails:
      // it must not be mistaken for an absent saved item.
      if (doReconcile && item.source === "reddit") {
        if (item.kind === "post" || item.kind === "comment") {
          present[item.kind].add(item.source_id);
        }
      }
    }

    // One multi-row INSERT per chunk for never-seen rows; existing
    // rows still take the full merge contract.
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
