from content_hoarder import db, models, pipeline


def _add(conn, sid, kind):
    db.merge_upsert(conn, models.new_item(
        source="reddit", source_id=sid, kind=kind, title=sid, now=1000))


def test_reconcile_marks_absent_as_unsaved(conn):
    for sid in ("t3_a", "t3_b", "t3_c"):
        _add(conn, sid, "post")
    for sid in ("t1_x", "t1_y"):
        _add(conn, sid, "comment")
    # export still has posts a,b and comment x; c and y were un-saved on reddit
    present = {"post": {"t3_a", "t3_b"}, "comment": {"t1_x"}}
    summary = db.reconcile_reddit_saves(conn, present)

    assert summary["post"]["unsaved"] == 1
    assert "reddit:t3_c" in summary["post"]["fullnames"]
    assert summary["comment"]["unsaved"] == 1
    assert db.get_item(conn, "reddit:t3_a")["is_saved"] == 1   # present -> kept
    assert db.get_item(conn, "reddit:t3_c")["is_saved"] == 0   # absent  -> un-saved
    assert db.get_item(conn, "reddit:t1_x")["is_saved"] == 1
    assert db.get_item(conn, "reddit:t1_y")["is_saved"] == 0


def test_reconcile_cap_guard_skips_truncated_type(conn):
    _add(conn, "t3_a", "post")
    # export hit the per-type cap -> missing could be merely truncated -> skip the whole type
    present = {"post": {f"t3_{i}" for i in range(3)}, "comment": set()}
    summary = db.reconcile_reddit_saves(conn, present, cap=3)
    assert summary["post"]["capped"] is True
    assert summary["post"]["skipped"] == "cap_reached"
    assert summary["post"]["unsaved"] == 0
    assert db.get_item(conn, "reddit:t3_a")["is_saved"] == 1   # untouched


def test_reconcile_dry_run_does_not_write(conn):
    _add(conn, "t3_a", "post")
    summary = db.reconcile_reddit_saves(
        conn, {"post": {"t3_z"}, "comment": set()}, dry_run=True)
    assert summary["post"]["unsaved"] == 1
    assert db.get_item(conn, "reddit:t3_a")["is_saved"] == 1   # preview only


_ONE_POST = """<html><body><table>
<thead><tr><th>createdUtc</th><th>id</th><th>over18</th><th>permalink</th><th>subredditNamePrefixed</th><th>subreddit</th><th>title</th><th>url</th></tr></thead>
<tbody><tr><td>1781508526</td><td>1u69n0s</td><td>false</td><td>/r/196/comments/1u69n0s/rule/</td><td>r/196</td><td>196</td><td>rule</td><td>https://i.redd.it/x.jpeg</td></tr></tbody>
</table></body></html>"""


def test_import_with_reconcile_end_to_end(conn, tmp_path):
    _add(conn, "t3_old", "post")          # pre-existing saved post, absent from the export
    f = tmp_path / "export.xls"
    f.write_text(_ONE_POST, encoding="utf-8")
    res = pipeline.import_path(conn, f, reconcile=True)
    assert res.reconcile is not None
    assert db.get_item(conn, "reddit:t3_1u69n0s")["is_saved"] == 1   # imported -> saved
    assert db.get_item(conn, "reddit:t3_old")["is_saved"] == 0       # absent  -> un-saved
