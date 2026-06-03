import json

from content_hoarder import db, firefox_youtube as fy, models


def _seed(conn, items):
    for kw in items:
        db.merge_upsert(conn, models.new_item(**kw))
    conn.commit()


def _firefox_yt(source_id, url, title, status="inbox", **md):
    """A row as the OLD connector would have written it: source=firefox, youtube url."""
    return dict(source="firefox", source_id=source_id, kind="tab",
                title=title, url=url, status=status, metadata=md)


def _seed_library(conn):
    _seed(conn, [
        # an existing Watch-Later save — the dupe target
        dict(source="youtube", source_id="DUPvid000_1", kind="video", title="Real WL Title",
             metadata={"playlist": "WL2", "position": 3, "channel": "Chan"}),
        # firefox tabs imported before the connector change (source=firefox, youtube url):
        _firefox_yt("ff_dup", "https://www.youtube.com/watch?v=DUPvid000_1&list=WL",
                    "(5) messy dup title - YouTube", window="3", pinned=1),       # dupe
        _firefox_yt("ff_orphan", "https://youtu.be/ORPvid00002",
                    "(9) Orphan Title - YouTube", window="3"),                    # orphan
        _firefox_yt("ff_done", "https://www.youtube.com/watch?v=DONvid00003",
                    "Watched One - YouTube", status="done"),                      # orphan, already triaged
        # a non-youtube firefox tab (control — must survive untouched)
        dict(source="firefox", source_id="ff_plain", kind="tab", title="Mod",
             url="https://modrinth.com/mod/x", metadata={"domain": "modrinth.com"}),
    ])


def test_migrate_dry_run_makes_no_changes(tmp_db):
    conn = db.connect(tmp_db)
    _seed_library(conn)
    res = fy.migrate(conn, apply=False)
    assert res["dupes"] == 1 and res["orphans"] == 2
    assert res["firefox_rows_removed"] == 0 and res["applied"] is False
    assert sorted(res["sample_orphans"]) == ["firefox:ff_done", "firefox:ff_orphan"]
    # nothing written: firefox rows still present, no youtube orphan created
    assert db.get_item(conn, "firefox:ff_dup") is not None
    assert db.get_item(conn, "youtube:ORPvid00002") is None


def test_migrate_apply(tmp_db):
    conn = db.connect(tmp_db)
    _seed_library(conn)
    res = fy.migrate(conn, apply=True)
    assert res["dupes"] == 1 and res["orphans"] == 2 and res["firefox_rows_removed"] == 3

    # old firefox youtube-tab rows are gone; the non-youtube tab survives
    for fn in ("firefox:ff_dup", "firefox:ff_orphan", "firefox:ff_done"):
        assert db.get_item(conn, fn) is None
    assert db.get_item(conn, "firefox:ff_plain") is not None

    # DUPE: the WL save keeps its title/playlist/position/status; gains only the open-tab markers
    wl = db.get_item(conn, "youtube:DUPvid000_1")
    wmd = json.loads(wl["metadata"])
    assert wl["title"] == "Real WL Title"              # NOT clobbered by the messy tab title
    assert wmd["playlist"] == "WL2" and wmd["position"] == 3
    assert wl["status"] == "inbox"
    assert wmd["open_in_firefox"] is True
    assert wmd["firefox_window"] == "3" and wmd["firefox_pinned"] == 1

    # ORPHAN: promoted to a real youtube video item (cleaned title, markers, thumbnail)
    orp = db.get_item(conn, "youtube:ORPvid00002")
    omd = json.loads(orp["metadata"])
    assert orp["source"] == "youtube" and orp["kind"] == "video"
    assert orp["title"] == "Orphan Title" and orp["status"] == "inbox"
    assert orp["url"] == "https://youtu.be/ORPvid00002"
    assert omd["open_in_firefox"] is True and omd["firefox_window"] == "3"
    assert omd["thumbnail"].endswith("/ORPvid00002/hqdefault.jpg")

    # ORPHAN with prior triage keeps its status (a 'done' tab stays done)
    done_row = db.get_item(conn, "youtube:DONvid00003")
    assert done_row["status"] == "done"
    # processed_utc must be preserved so the item counts in weekly-stats and undo works
    assert done_row["processed_utc"] is None  # seeded without one — still None, not forced

    # the batch filter surfaces exactly the 3 promoted/merged items, all youtube
    hits = db.search_items(conn, open_in_firefox=True, limit=50)
    assert {h["fullname"] for h in hits} == {
        "youtube:DUPvid000_1", "youtube:ORPvid00002", "youtube:DONvid00003"}
    assert {h["source"] for h in hits} == {"youtube"}


def test_migrate_preserves_processed_utc(tmp_db):
    """A 'done' tab that was triaged in the UI (has processed_utc) keeps it after promotion."""
    conn = db.connect(tmp_db)
    _seed(conn, [_firefox_yt("ff_triaged", "https://youtu.be/TRGvid00001", "Triaged Tab", status="done")])
    # Simulate the UI having stamped processed_utc (as set_status does)
    conn.execute("UPDATE items SET processed_utc=1748000000 WHERE fullname='firefox:ff_triaged'")
    conn.commit()
    fy.migrate(conn, apply=True)
    promoted = db.get_item(conn, "youtube:TRGvid00001")
    assert promoted["status"] == "done"
    assert promoted["processed_utc"] == 1748000000  # preserved, not reset to NULL


def test_migrate_same_video_in_two_tabs_collapses_to_one(tmp_db):
    conn = db.connect(tmp_db)
    _seed(conn, [  # same video open in two tabs (slightly different URLs -> two firefox rows)
        _firefox_yt("ff_a", "https://www.youtube.com/watch?v=SAMEvid0001&t=10", "Tab A - YouTube"),
        _firefox_yt("ff_b", "https://youtu.be/SAMEvid0001", "Tab B - YouTube"),
    ])
    res = fy.migrate(conn, apply=True)
    assert res["orphans"] == 2 and res["firefox_rows_removed"] == 2
    assert db.get_item(conn, "firefox:ff_a") is None and db.get_item(conn, "firefox:ff_b") is None
    # both collapse onto a single youtube item
    assert db.get_item(conn, "youtube:SAMEvid0001") is not None
    hits = db.search_items(conn, open_in_firefox=True, limit=50)
    assert {h["fullname"] for h in hits} == {"youtube:SAMEvid0001"}
