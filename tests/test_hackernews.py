import json
import sqlite3

from content_hoarder.connectors.hackernews import HNConnector


def _materialistic_db(tmp_path):
    p = tmp_path / "Materialistic.db"
    con = sqlite3.connect(p)
    con.execute("CREATE TABLE saved (_id INTEGER, itemid TEXT, url TEXT, title TEXT, time TEXT)")
    con.execute("INSERT INTO saved VALUES (1,'29387761','https://x.com/a','A Title','1638269381970')")
    con.execute("CREATE TABLE read (_id INTEGER, itemid TEXT)")
    con.executemany("INSERT INTO read VALUES (?,?)", [(1, "111"), (2, "29387761")])  # 2nd dups a saved id
    con.commit()
    con.close()
    return p


def test_hn_saved_and_read(tmp_path):
    p = _materialistic_db(tmp_path)
    hn = HNConnector()
    assert hn.can_import(p) is True
    items = {i["source_id"]: i for i in hn.import_file(p)}
    assert set(items) == {"29387761", "111"}  # the read row that dups a saved id is skipped

    saved = items["29387761"]
    assert saved["title"] == "A Title" and saved["status"] == "inbox"
    assert saved["created_utc"] == 1638269381 and saved["saved_utc"] == 1638269381  # ms -> seconds
    assert json.loads(saved["metadata"])["hn_list"] == "saved"

    read = items["111"]
    assert read["title"] == "" and read["kind"] == "story"
    assert read["status"] == "archived"  # read-but-not-saved is archived, not inbox
    assert json.loads(read["metadata"])["hn_list"] == "read"
