"""Ingestion pipeline: dispatch -> import_file -> merge_upsert -> (optional) enrich.

The SOLE owner of database writes during import. Connectors only parse and yield.
"""

from __future__ import annotations

from pathlib import Path

from content_hoarder import connectors, db
from content_hoarder.connectors.base import ImportResult


def import_path(
    conn, path, *, source: str | None = None, enrich: bool = False,
    reconcile: bool = False, reconcile_dry_run: bool = False,
) -> ImportResult:
    """Import a file/dir into the DB. Returns counts + per-item errors.

    ``reconcile`` (or ``reconcile_dry_run``): treat this import as a fresh reddit saved-list
    snapshot and mark still-saved reddit items absent from it as un-saved (per-type cap-guarded;
    see ``db.reconcile_reddit_saves``). Only meaningful for a reddit saved-list export.
    """
    p = Path(path)
    connector = connectors.get(source) if source else connectors.dispatch(p)
    result = ImportResult()
    batch: list[dict] = []
    do_reconcile = reconcile or reconcile_dry_run
    present = {"post": set(), "comment": set()}
    for item in connector.import_file(p):
        # Record presence from the PARSED export regardless of upsert success — a row genuinely in
        # the export but failing to upsert must not be mistaken for "absent" (a false un-save).
        if do_reconcile and item.get("source") == "reddit":
            kind = item.get("kind")
            if kind in present:
                present[kind].add(item.get("source_id"))
        try:
            db.merge_upsert(conn, item)
            result.imported += 1
            batch.append(item)
        except Exception as exc:  # one bad row must not kill the whole import
            result.skipped += 1
            result.errors.append(f"{item.get('fullname', '?')}: {exc}")
    conn.commit()
    if enrich and batch:
        _enrich_batch(conn, connector, batch, result)
    if do_reconcile and (present["post"] or present["comment"]):
        result.reconcile = db.reconcile_reddit_saves(
            conn, present, dry_run=reconcile_dry_run
        )
    return result


def _enrich_batch(conn, connector, items, result) -> None:
    try:
        enriched = connector.enrich(items)
    except Exception as exc:
        result.errors.append(f"enrich: {exc}")
        return
    for item in enriched or []:
        try:
            db.merge_upsert(conn, item)
        except Exception as exc:
            result.errors.append(f"enrich {item.get('fullname', '?')}: {exc}")
    conn.commit()
