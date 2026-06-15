from content_hoarder import db, models, reddit_hydrate


def _add(conn, sid, *, title="", body="", raw=None):
    db.merge_upsert(conn, models.new_item(
        source="reddit", source_id=sid,
        kind="comment" if sid.startswith("t1_") else "post",
        title=title, body=body, raw=raw, now=1000))


def test_backfill_fills_empty_titles_from_submission_title(conn):
    _add(conn, "t1_a", title="", body="my comment", raw={"submission_title": "Real Post Title"})
    _add(conn, "t1_b", title="Already Has", raw={"submission_title": "Other"})  # real title present
    _add(conn, "t1_c", title="", body="no source")                             # no submission_title

    res = reddit_hydrate.backfill_titles_local(conn)
    assert res["updated"] == 1
    assert db.get_item(conn, "reddit:t1_a")["title"] == "Real Post Title"   # filled
    assert db.get_item(conn, "reddit:t1_b")["title"] == "Already Has"       # never overwritten
    assert db.get_item(conn, "reddit:t1_c")["title"] == ""                  # left as placeholder
    # search_text recomputed so the restored title is searchable
    assert "Real Post Title" in db.get_item(conn, "reddit:t1_a")["search_text"]


def test_backfill_dry_run_does_not_write(conn):
    _add(conn, "t1_a", title="", raw={"submission_title": "Title X"})
    res = reddit_hydrate.backfill_titles_local(conn, dry_run=True)
    assert res["updated"] == 1 and res["dry_run"] is True
    assert db.get_item(conn, "reddit:t1_a")["title"] == ""                  # preview only


def test_backfill_is_idempotent(conn):
    _add(conn, "t1_a", title="", raw={"submission_title": "Title X"})
    assert reddit_hydrate.backfill_titles_local(conn)["updated"] == 1
    assert reddit_hydrate.backfill_titles_local(conn)["updated"] == 0       # nothing left to fill


# --- Phase 2: network backfill from web archives (spec 08 P2) -------------------


class _FakeProvider:
    """Stand-in archive provider: returns canned post titles keyed by bare submission id."""

    def __init__(self, titles, name="fake"):
        self._titles = titles
        self.name = name

    def fetch_posts(self, ids):
        return {i: {"title": self._titles[i]} for i in ids if i in self._titles}


def _add_comment(conn, cid, sub, sid, *, title="", body="a comment"):
    """A saved reddit comment with a permalink (no raw_json) — the Phase-2 shape."""
    db.merge_upsert(conn, models.new_item(
        source="reddit", source_id=cid, kind="comment", title=title, body=body,
        metadata={"permalink": f"/r/{sub}/comments/{sid}/_/{cid[3:]}/"}, now=1000))


def test_network_backfill_fills_title_from_submission(conn):
    _add_comment(conn, "t1_aaa", "pics", "subA", title="")        # resolvable -> filled
    _add_comment(conn, "t1_bbb", "pics", "subB", title="Kept")    # already titled -> untouched
    _add_comment(conn, "t1_ccc", "pics", "subC", title="")        # archive returns nothing -> missed
    prov = _FakeProvider({"subA": "First Post Title"})            # subC absent
    res = reddit_hydrate.backfill_titles_network(conn, providers=[prov])
    assert res["updated"] == 1 and res["missed"] == 1
    assert db.get_item(conn, "reddit:t1_aaa")["title"] == "First Post Title"   # filled
    assert db.get_item(conn, "reddit:t1_bbb")["title"] == "Kept"              # never overwritten
    assert db.get_item(conn, "reddit:t1_ccc")["title"] == ""                  # left as placeholder
    assert "First Post Title" in db.get_item(conn, "reddit:t1_aaa")["search_text"]


def test_network_backfill_dedups_shared_submission(conn):
    # two comments on the SAME submission -> one fetch (submissions==1), both filled
    _add_comment(conn, "t1_d1", "aww", "shared")
    _add_comment(conn, "t1_d2", "aww", "shared")
    res = reddit_hydrate.backfill_titles_network(
        conn, providers=[_FakeProvider({"shared": "Shared Title"})])
    assert res["submissions"] == 1 and res["updated"] == 2
    assert db.get_item(conn, "reddit:t1_d1")["title"] == "Shared Title"
    assert db.get_item(conn, "reddit:t1_d2")["title"] == "Shared Title"


def test_network_backfill_falls_through_to_second_provider(conn):
    _add_comment(conn, "t1_e", "gifs", "subE")
    p1 = _FakeProvider({}, name="empty")                 # finds nothing
    p2 = _FakeProvider({"subE": "Recovered"}, name="backup")
    res = reddit_hydrate.backfill_titles_network(conn, providers=[p1, p2])
    assert res["updated"] == 1 and res["by_provider"] == {"backup": 1}
    assert db.get_item(conn, "reddit:t1_e")["title"] == "Recovered"


def test_network_backfill_dry_run_makes_no_network_and_no_write(conn):
    _add_comment(conn, "t1_f", "gifs", "subF")

    class _Boom(_FakeProvider):
        def fetch_posts(self, ids):
            raise AssertionError("dry-run must not hit the network")

    res = reddit_hydrate.backfill_titles_network(conn, providers=[_Boom({})], dry_run=True)
    assert res["resolvable"] == 1 and res["dry_run"] is True and res["submissions"] == 1
    assert db.get_item(conn, "reddit:t1_f")["title"] == ""
