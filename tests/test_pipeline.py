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
