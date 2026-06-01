"""Standalone enrichment: fill sparse rows per source via ``connector.enrich()``."""

from __future__ import annotations

from content_hoarder import connectors, db
from content_hoarder.connectors.base import BaseConnector


def _has_enrich(connector: BaseConnector) -> bool:
    """True if this connector overrides the default no-op enrich()."""
    return type(connector).enrich is not BaseConnector.enrich


def enrich_source(conn, source: str, *, all_rows: bool = False, limit: int | None = None) -> dict:
    connector = connectors.get(source)
    sql = "SELECT * FROM items WHERE source=?"
    params: list = [source]
    if not all_rows:
        sql += " AND hydrated_at IS NULL"
    sql += " ORDER BY last_seen_utc DESC"
    if limit:
        sql += " LIMIT ?"
        params.append(int(limit))
    rows = [db._row_to_public(r) for r in conn.execute(sql, params)]
    if not rows:
        return {"selected": 0, "updated": 0}
    enriched = connector.enrich(rows) or []
    for item in enriched:
        db.merge_upsert(conn, item)
    conn.commit()
    return {"selected": len(rows), "updated": len(enriched)}


def enrich_all(conn, *, all_rows: bool = False) -> dict:
    totals = {"selected": 0, "updated": 0, "by_source": {}}
    for connector in connectors.all_connectors():
        if not _has_enrich(connector):
            continue
        res = enrich_source(conn, connector.id, all_rows=all_rows)
        totals["selected"] += res["selected"]
        totals["updated"] += res["updated"]
        totals["by_source"][connector.id] = res
    return totals
