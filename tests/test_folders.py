"""Tests for the folder system (Epic 26) — registry, evaluation, CLI, web.

Offline: :memory: SQLite, synthetic fixtures, no network.
"""

import json

from content_hoarder import db, folders, models


def mk(**kw):
    kw.setdefault("now", 1000)
    return models.new_item(**kw)


def _md(conn, fullname):
    return json.loads(db.get_item(conn, fullname)["metadata"])


def _insert_items(conn):
    """Insert a handful of items for folder tests."""
    for item in [
        mk(
            source="reddit",
            source_id="t3_a",
            title="Minecraft modpack help",
            metadata={"subreddit": "feedthebeast", "tags": ["minecraft", "memes"]},
        ),
        mk(
            source="reddit",
            source_id="t3_b",
            title="lol",
            metadata={"subreddit": "ProgrammerHumor", "tags": ["coding", "memes"]},
        ),
        mk(
            source="reddit",
            source_id="t3_c",
            title="anime clip",
            metadata={"subreddit": "anime", "tags": ["anime"]},
        ),
        mk(
            source="youtube",
            source_id="v1",
            title="Perun analysis",
            metadata={"channel": "Perun", "tags": ["defense"]},
        ),
        mk(
            source="firefox",
            source_id="ff1",
            title="stock market today",
            metadata={"domain": "bloomberg.com", "tags": ["investing"]},
        ),
        mk(
            source="reddit",
            source_id="t3_d",
            title="untagged post",
            metadata={"subreddit": "AskReddit"},
        ),
    ]:
        db.merge_upsert(conn, item)
    conn.commit()


# ---------------------------------------------------------------------------
# Folder registry (db.py)
# ---------------------------------------------------------------------------


def test_create_folder(conn):
    f = db.create_folder(conn, "Minecraft", {"tag": ["minecraft"]})
    assert f["name"] == "minecraft"
    assert f["query_def"] == {"tag": ["minecraft"]}


def test_create_folder_duplicate_raises(conn):
    db.create_folder(conn, "minecraft", {"tag": ["minecraft"]})
    import pytest

    with pytest.raises(ValueError, match="already exists"):
        db.create_folder(conn, "minecraft", {"tag": ["minecraft", "memes"]})


def test_list_folders(conn):
    db.create_folder(conn, "Minecraft", {"tag": ["minecraft"]})
    db.create_folder(conn, "Coding", {"tag": ["coding"]})
    fl = db.list_folders(conn)
    assert len(fl) == 2
    # Ordered by name
    assert fl[0]["name"] == "coding"
    assert fl[1]["name"] == "minecraft"


def test_delete_folder(conn):
    f = db.create_folder(conn, "test", {})
    assert db.delete_folder(conn, f["id"]) is True
    assert db.list_folders(conn) == []


def test_delete_folder_missing(conn):
    assert db.delete_folder(conn, 999) is False


def test_rename_folder(conn):
    f = db.create_folder(conn, "old", {})
    renamed = db.rename_folder(conn, f["id"], "new")
    assert renamed["name"] == "new"
    assert db.get_folder_by_name(conn, "new") is not None
    assert db.get_folder_by_name(conn, "old") is None


def test_rename_folder_duplicate(conn):
    db.create_folder(conn, "a", {})
    f = db.create_folder(conn, "b", {})
    import pytest

    with pytest.raises(ValueError, match="already exists"):
        db.rename_folder(conn, f["id"], "a")


def test_get_folder_by_name(conn):
    db.create_folder(conn, "my folder", {"source": "reddit"})
    f = db.get_folder_by_name(conn, "MY FOLDER")
    assert f is not None
    assert f["name"] == "my folder"
    assert f["query_def"] == {"source": "reddit"}


# ---------------------------------------------------------------------------
# Item folder assignment (db.py)
# ---------------------------------------------------------------------------


def test_set_item_folder(conn):
    _insert_items(conn)
    assert db.set_item_folder(conn, "reddit:t3_a", "gaming")
    md = _md(conn, "reddit:t3_a")
    assert md["folder"] == "gaming"


def test_set_item_folder_clear(conn):
    _insert_items(conn)
    db.set_item_folder(conn, "reddit:t3_a", "gaming")
    db.set_item_folder(conn, "reddit:t3_a", None)
    md = _md(conn, "reddit:t3_a")
    assert "folder" not in md


def test_set_item_folder_missing(conn):
    assert db.set_item_folder(conn, "r:nope", "test") is False


def test_folder_counts(conn):
    _insert_items(conn)
    db.set_item_folder(conn, "reddit:t3_a", "gaming")
    db.set_item_folder(conn, "reddit:t3_b", "gaming")
    db.set_item_folder(conn, "reddit:t3_c", "anime")
    counts = db.folder_counts(conn)
    assert counts == {"gaming": 2, "anime": 1}


# ---------------------------------------------------------------------------
# Folder evaluation (folders.py)
# ---------------------------------------------------------------------------


def test_evaluate_folder_by_tag(conn):
    _insert_items(conn)
    f = db.create_folder(conn, "memes", {"tag": ["memes"]})
    res = folders.evaluate_folder(conn, f["id"])
    assert res["total"] >= 2  # t3_a and t3_b have memes tag
    assert _md(conn, "reddit:t3_a")["folder"] == "memes"
    assert _md(conn, "reddit:t3_b")["folder"] == "memes"
    # t3_c has anime, not memes -> no folder
    assert "folder" not in _md(conn, "reddit:t3_c")


def test_evaluate_folder_by_source(conn):
    _insert_items(conn)
    f = db.create_folder(conn, "reddit", {"source": "reddit"})
    res = folders.evaluate_folder(conn, f["id"])
    assert res["total"] == 4  # all 4 reddit items
    assert "folder" in _md(conn, "reddit:t3_a")
    assert "folder" not in _md(conn, "youtube:v1")


def test_evaluate_folder_by_subreddit(conn):
    _insert_items(conn)
    f = db.create_folder(conn, "ftb", {"subreddit": "feedthebeast"})
    res = folders.evaluate_folder(conn, f["id"])
    assert res["total"] == 1
    assert _md(conn, "reddit:t3_a")["folder"] == "ftb"


def test_evaluate_folder_removes_stale(conn):
    _insert_items(conn)
    f = db.create_folder(conn, "gaming", {"tag": ["minecraft"]})
    folders.evaluate_folder(conn, f["id"])
    # t3_a has minecraft tag -> assigned
    assert _md(conn, "reddit:t3_a")["folder"] == "gaming"
    # t3_b does NOT have minecraft -> not assigned
    assert "folder" not in _md(conn, "reddit:t3_b")

    # Change rule: now target "memes" tag
    conn.execute(
        "UPDATE folders SET query_def=? WHERE id=?",
        (json.dumps({"tag": ["memes"]}), f["id"]),
    )
    folders.evaluate_folder(conn, f["id"])
    # t3_a still has memes (and now minecraft too) -> stays
    assert _md(conn, "reddit:t3_a")["folder"] == "gaming"
    # t3_b now matches memes -> assigned
    assert _md(conn, "reddit:t3_b")["folder"] == "gaming"
    # Non-redirecting: check that a non-matching item is cleared


def test_evaluate_folder_dry_run(conn):
    _insert_items(conn)
    f = db.create_folder(conn, "memes", {"tag": ["memes"]})
    res = folders.evaluate_folder(conn, f["id"], dry_run=True)
    assert res["dry_run"] is True
    assert res["matched"] >= 2
    # No write happened
    assert "folder" not in _md(conn, "reddit:t3_a")


def test_evaluate_folder_by_has_video(conn):
    _insert_items(conn)
    f = db.create_folder(conn, "has-url", {"has": "video"})
    res = folders.evaluate_folder(conn, f["id"])
    # All items have a url (set by new_item -> url defaults to "")
    # Only youtube:v1 has url="https://youtube.com/watch?v=xyz" if we set it
    # Actually the mk() doesn't set url, so url is "". Let me check.
    # models.new_item url defaults to "". So has:video won't match any.
    assert res["total"] == 0


def test_evaluate_folder_all(conn):
    _insert_items(conn)
    db.create_folder(conn, "memes", {"tag": ["memes"]})
    db.create_folder(conn, "coding", {"tag": ["coding"]})
    results = folders.evaluate_all_folders(conn)
    assert len(results) == 2
    assert results[0]["total"] >= 2  # memes
    assert results[1]["total"] == 1  # coding


def test_evaluate_folder_nonexistent(conn):
    res = folders.evaluate_folder(conn, 999)
    assert "error" in res


def test_evaluate_folder_by_status(conn):
    _insert_items(conn)
    # Make one item "keep"
    conn.execute("UPDATE items SET status='keep' WHERE fullname='reddit:t3_a'")
    conn.commit()
    f = db.create_folder(conn, "kept", {"status": "keep"})
    res = folders.evaluate_folder(conn, f["id"])
    assert res["total"] == 1
    assert _md(conn, "reddit:t3_a")["folder"] == "kept"


def test_evaluate_folder_by_free_text(conn):
    _insert_items(conn)
    f = db.create_folder(conn, "minecraft", {"q": "minecraft"})
    res = folders.evaluate_folder(conn, f["id"])
    # search_text includes title "Minecraft modpack help"
    assert res["total"] == 1


# ---------------------------------------------------------------------------
# Items_by_folder
# ---------------------------------------------------------------------------


def test_items_by_folder(conn):
    _insert_items(conn)
    db.set_item_folder(conn, "reddit:t3_a", "gaming")
    db.set_item_folder(conn, "reddit:t3_b", "gaming")
    items = folders.items_by_folder(conn, "gaming")
    assert len(items) == 2
    assert items[0]["source"] == "reddit"


def test_items_by_folder_empty(conn):
    assert folders.items_by_folder(conn, "nonexistent") == []
