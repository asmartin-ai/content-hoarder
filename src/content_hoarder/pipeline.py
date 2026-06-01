"""Ingestion pipeline: dispatch -> import_file -> merge_upsert -> (optional) enrich.

The SOLE owner of database writes during import. Connectors only parse and yield.
"""

from __future__ import annotations

from pathlib import Path

from content_hoarder import connectors, db
from content_hoarder.connectors.base import ImportResult


def import_path(
    conn, path, *, source: str | None = None, enrich: bool = False
) -> ImportResult:
    """Import a file/dir into the DB. Returns counts + per-item errors."""
    p = Path(path)
    connector = connectors.get(source) if source else connectors.dispatch(p)
    result = ImportResult()
    batch: list[dict] = []
    for item in connector.import_file(p):
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
