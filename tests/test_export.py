from content_hoarder import connectors, db, export, models


def test_obsidian_export_roundtrip(conn, tmp_path):
    db.merge_upsert(conn, models.new_item(
        source="reddit", source_id="t3_a", title="Cool Thing", body="hello world",
        url="http://x", created_utc=1700000000, metadata={"subreddit": "py", "tags": ["t1"]}))
    db.merge_upsert(conn, models.new_item(source="keep", source_id="n1", title="Skip me"))
    db.set_status(conn, "reddit:t3_a", "keep")

    vault = tmp_path / "vault"
    res = export.obsidian_export(conn, vault, status="keep")
    assert res["exported"] == 1  # only the 'keep' item

    files = list(vault.glob("*.md"))
    assert len(files) == 1
    text = files[0].read_text(encoding="utf-8")
    assert "source: reddit" in text and "r/py" in text and "hello world" in text
    assert "ch_fullname: reddit:t3_a" in text

    # Round-trip: the Obsidian connector can re-import the exported note.
    items = list(connectors.get("obsidian").import_file(files[0]))
    assert items and items[0]["title"] == "Cool Thing"


def test_export_filename_collision(conn, tmp_path):
    for i in (1, 2):
        db.merge_upsert(conn, models.new_item(source="reddit", source_id=f"t3_{i}", title="Same Title"))
        db.set_status(conn, f"reddit:t3_{i}", "keep")
    export.obsidian_export(conn, tmp_path / "v", status="keep")
    assert len(list((tmp_path / "v").glob("*.md"))) == 2  # no overwrite
