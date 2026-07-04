from content_hoarder import db, pipeline


def test_import_all_and_idempotent(conn, fixtures):
    paths = [
        fixtures / "reddit" / "saved.csv",
        fixtures / "youtube" / "playlist.json",
        fixtures / "obsidian" / "vault",
        fixtures / "keep" / "Keep",
        fixtures / "hackernews" / "ids.json",
    ]
    for p in paths:
        pipeline.import_path(conn, p)
    # reddit 1 + youtube 2 + obsidian 1 + keep 1 + hn 2 = 7
    assert db.get_counts(conn)["total"] == 7
    for p in paths:
        pipeline.import_path(conn, p)
    assert db.get_counts(conn)["total"] == 7  # idempotent


def test_cross_source_namespacing(conn, fixtures):
    pipeline.import_path(conn, fixtures / "youtube" / "playlist.json")
    pipeline.import_path(conn, fixtures / "reddit" / "saved.csv")
    fns = [r[0] for r in conn.execute("SELECT fullname FROM items")]
    assert all(":" in f for f in fns)
    assert len(fns) == len(set(fns))


def test_force_source(conn, fixtures):
    res = pipeline.import_path(conn, fixtures / "reddit" / "saved.csv", source="reddit")
    assert res.imported == 1 and not res.errors


def test_enrich_true_mutates_rows_via_connector_enrich(conn, fixtures, monkeypatch):
    """Audit Low (2026-07-02 Pass 5): the sole DB writer's ``enrich=True`` path
    had zero coverage. Verify the path runs the connector's ``enrich`` hook and
    folds its mutated rows back via merge_upsert, without needing network."""
    import json

    from content_hoarder import connectors
    reddit = connectors.get("reddit")

    enrich_calls: list[list[dict]] = []

    def fake_enrich(items):
        enrich_calls.append(list(items))
        # Mutate each row's metadata as an enrichment would (e.g. fetch tags).
        # Connector metadata is a JSON string (see models.new_item); keep that
        # contract so merge_upsert parses it cleanly.
        out = []
        for it in items:
            existing = json.loads(it.get("metadata") or "{}") if isinstance(
                it.get("metadata"), str
            ) else dict(it.get("metadata") or {})
            existing["enriched_by_test"] = True
            it2 = dict(it, metadata=json.dumps(existing, ensure_ascii=False))
            out.append(it2)
        return out

    monkeypatch.setattr(reddit, "enrich", fake_enrich)

    res = pipeline.import_path(
        conn, fixtures / "reddit" / "saved.csv", source="reddit", enrich=True
    )
    # enrich ran exactly once with the imported batch
    assert len(enrich_calls) == 1
    assert len(enrich_calls[0]) == res.imported
    # No errors accumulated on the happy path
    assert res.errors == []
    # The mutated metadata persisted to the DB
    rows = conn.execute("SELECT metadata FROM items").fetchall()
    assert rows, "expected at least one row after import"
    for r in rows:
        md = r["metadata"] or "{}"
        assert '"enriched_by_test"' in md, f"enrichment not persisted: {md}"


def test_enrich_true_swallows_per_item_enrich_errors(conn, fixtures, monkeypatch):
    """The ``enrich`` hook raising must surface on ``result.errors`` but not kill
    the import (the batch already committed before enrich ran)."""
    from content_hoarder import connectors
    reddit = connectors.get("reddit")

    def boom(_items):
        raise RuntimeError("enrich exploded")

    monkeypatch.setattr(reddit, "enrich", boom)

    res = pipeline.import_path(
        conn, fixtures / "reddit" / "saved.csv", source="reddit", enrich=True
    )
    # Import itself succeeded
    assert res.imported >= 1
    # The enrich failure is recorded, not raised
    assert any("enrich" in e for e in res.errors)
    assert any("enrich exploded" in e for e in res.errors)
    # Rows still landed (enrich ran AFTER the batch commit)
    assert conn.execute("SELECT COUNT(*) FROM items").fetchone()[0] == res.imported

