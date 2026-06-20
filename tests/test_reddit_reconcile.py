from content_hoarder import db, models, pipeline

SEEN = 1_700_000_000  # a metadata.saved_seen_utc provenance-marker timestamp


def _add(conn, sid, kind, *, seen=False):
    """Insert a saved reddit item; ``seen`` stamps the saved_seen_utc snapshot marker."""
    md = {"saved_seen_utc": SEEN} if seen else None
    db.merge_upsert(conn, models.new_item(
        source="reddit", source_id=sid, kind=kind, title=sid, metadata=md, now=1000))


def test_reconcile_marks_seen_but_absent_as_unsaved(conn):
    for sid in ("t3_a", "t3_b", "t3_c"):
        _add(conn, sid, "post", seen=True)
    for sid in ("t1_x", "t1_y"):
        _add(conn, sid, "comment", seen=True)
    # export still has posts a,b and comment x; c and y dropped out of the saved list
    present = {"post": {"t3_a", "t3_b"}, "comment": {"t1_x"}}
    summary = db.reconcile_reddit_saves(conn, present)

    assert summary["post"]["unsaved"] == 1
    assert "reddit:t3_c" in summary["post"]["fullnames"]
    assert summary["comment"]["unsaved"] == 1
    assert db.get_item(conn, "reddit:t3_a")["is_saved"] == 1
    assert db.get_item(conn, "reddit:t3_c")["is_saved"] == 0
    assert db.get_item(conn, "reddit:t1_x")["is_saved"] == 1
    assert db.get_item(conn, "reddit:t1_y")["is_saved"] == 0


def test_reconcile_never_touches_unmarked_rows(conn):
    # the core Option-A safety: a bulk-imported row never seen in a snapshot is untouched,
    # even though it's absent from the export; only the marked-and-absent row is un-saved.
    _add(conn, "t3_bulk", "post", seen=False)
    _add(conn, "t3_seen", "post", seen=True)
    summary = db.reconcile_reddit_saves(conn, {"post": {"t3_other"}, "comment": set()})
    assert db.get_item(conn, "reddit:t3_bulk")["is_saved"] == 1   # unmarked -> untouched
    assert db.get_item(conn, "reddit:t3_seen")["is_saved"] == 0   # marked + absent -> un-saved
    assert summary["post"]["unsaved"] == 1


def test_reconcile_cap_guard_skips_truncated_type(conn):
    _add(conn, "t3_a", "post", seen=True)
    present = {"post": {f"t3_{i}" for i in range(3)}, "comment": set()}
    summary = db.reconcile_reddit_saves(conn, present, cap=3)
    assert summary["post"]["capped"] is True
    assert summary["post"]["skipped"] == "cap_reached"
    assert summary["post"]["unsaved"] == 0
    assert db.get_item(conn, "reddit:t3_a")["is_saved"] == 1


def test_reconcile_explicit_complete_reconciles_at_cap(conn):
    """B2: a COMPLETE export of exactly `cap` items must still reconcile — the row-count
    inference wrongly skipped it as truncated. truncated_by_kind={'post': False} overrides."""
    _add(conn, "t3_gone", "post", seen=True)               # seen before, now absent -> un-save
    present = {"post": {f"t3_{i}" for i in range(3)}, "comment": set()}  # exactly cap=3 present
    summary = db.reconcile_reddit_saves(
        conn, present, cap=3, truncated_by_kind={"post": False})
    assert summary["post"]["skipped"] is None              # NOT skipped despite hitting the cap
    assert summary["post"]["unsaved"] == 1
    assert db.get_item(conn, "reddit:t3_gone")["is_saved"] == 0


def test_reconcile_explicit_truncated_skips_below_cap(conn):
    """B2: a caller that KNOWS the listing was cut short (e.g. a max_pages cookie sync) skips
    even below the cap — the inference alone would have reconciled and wrongly un-saved."""
    _add(conn, "t3_maybe_beyond", "post", seen=True)
    present = {"post": {"t3_a", "t3_b"}, "comment": set()}  # only 2, well under cap
    summary = db.reconcile_reddit_saves(
        conn, present, truncated_by_kind={"post": True})
    assert summary["post"]["skipped"] == "source_truncated"
    assert summary["post"]["unsaved"] == 0
    assert db.get_item(conn, "reddit:t3_maybe_beyond")["is_saved"] == 1  # protected


def test_import_reconcile_complete_flag_threads_through(conn, tmp_path):
    """The pipeline opt-in maps to truncated_by_kind={post,comment: False}."""
    _add(conn, "t3_seen_old", "post", seen=True)           # snapshotted, absent from the export
    f = tmp_path / "export.xls"
    f.write_text(_ONE_POST, encoding="utf-8")
    res = pipeline.import_path(conn, f, reconcile=True, reconcile_complete=True)
    # the single imported post is present; the previously-seen one is gone -> un-saved
    assert db.get_item(conn, "reddit:t3_seen_old")["is_saved"] == 0
    assert res.reconcile["post"]["skipped"] is None


def test_reconcile_dry_run_does_not_write(conn):
    _add(conn, "t3_a", "post", seen=True)
    summary = db.reconcile_reddit_saves(
        conn, {"post": {"t3_z"}, "comment": set()}, dry_run=True)
    assert summary["post"]["unsaved"] == 1
    assert db.get_item(conn, "reddit:t3_a")["is_saved"] == 1       # preview only


_ONE_POST = """<html><body><table>
<thead><tr><th>createdUtc</th><th>id</th><th>over18</th><th>permalink</th><th>subredditNamePrefixed</th><th>subreddit</th><th>title</th><th>url</th></tr></thead>
<tbody><tr><td>1781508526</td><td>1u69n0s</td><td>false</td><td>/r/196/comments/1u69n0s/rule/</td><td>r/196</td><td>196</td><td>rule</td><td>https://i.redd.it/x.jpeg</td></tr></tbody>
</table></body></html>"""


def test_import_reconcile_only_touches_marked_rows(conn, tmp_path):
    _add(conn, "t3_seen_old", "post", seen=True)    # previously-snapshotted, now absent
    _add(conn, "t3_bulk_old", "post", seen=False)   # bulk import, never snapshotted
    f = tmp_path / "export.xls"
    f.write_text(_ONE_POST, encoding="utf-8")
    # the saveddit import stamps saved_seen_utc on every row it ingests
    res = pipeline.import_path(conn, f, reconcile=True)
    assert res.reconcile is not None
    assert db.get_item(conn, "reddit:t3_1u69n0s")["is_saved"] == 1   # imported (now marked)
    assert db.get_item(conn, "reddit:t3_seen_old")["is_saved"] == 0  # marked + absent -> un-saved
    assert db.get_item(conn, "reddit:t3_bulk_old")["is_saved"] == 1  # unmarked -> untouched
