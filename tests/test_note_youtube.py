import json

from content_hoarder import db, note_youtube
from content_hoarder.models import new_item as mk


def _md(row: dict) -> dict:
    return json.loads(row["metadata"])


def _promoted_to_has(md: dict, yt_fullname: str) -> bool:
    v = md.get("promoted_to")
    if v == yt_fullname:
        return True
    if isinstance(v, list):
        return yt_fullname in v
    return False


def test_note_yt_ids_extraction():
    item = {
        "body": (
            "see https://youtu.be/dQw4w9WgXcQ and also "
            "https://www.youtube.com/watch?v=aaaaaaaaaaa plus "
            "https://notyoutube.com/watch?v=bbbbbbbbbbb"
        ),
        "url": "https://youtube.com/watch?v=ccccccccccc",
        "metadata": {
            "urls": [
                "https://youtu.be/ddddddddddd",
                "https://www.youtube.com/watch?v=eeeeeeeeeee",
                "https://example.com/watch?v=fffffffffff",  # host-guarded reject
                "https://youtube.com/watch?v=shortid",  # too short
            ]
        },
    }
    ids = note_youtube._note_yt_ids(item)
    assert set(ids) == {
        "dQw4w9WgXcQ",
        "aaaaaaaaaaa",
        "ccccccccccc",
        "ddddddddddd",
        "eeeeeeeeeee",
    }


def test_plan_orphan_vs_companion():
    with db.connect(":memory:") as c:
        vid = "vid12345678"  # 11 chars
        db.merge_upsert(
            c,
            mk(
                source="keep",
                source_id="note1",
                kind="note",
                title="A note",
                body=f"https://youtu.be/{vid}",
                now=1000,
            ),
        )

        plan_res = note_youtube.plan(c)
        assert {r["vid"] for r in plan_res["orphan"]} == {vid}
        assert plan_res["companion"] == []

        db.merge_upsert(
            c,
            mk(
                source="youtube",
                source_id=vid,
                kind="video",
                title="YT Video",
                url=f"https://youtu.be/{vid}",
                now=1000,
            ),
        )
        plan_res2 = note_youtube.plan(c)
        assert plan_res2["orphan"] == []
        assert {r["vid"] for r in plan_res2["companion"]} == {vid}


def test_migrate_dry_run_writes_nothing():
    with db.connect(":memory:") as c:
        vid = "dQw4w9WgXcQ"
        db.merge_upsert(
            c,
            mk(
                source="obsidian",
                source_id="note2",
                kind="note",
                title="Note 2",
                body=f"https://youtu.be/{vid}",
                now=1000,
            ),
        )
        before = c.execute("SELECT COUNT(*) FROM items").fetchone()[0]
        res = note_youtube.migrate(c, apply=False)
        after = c.execute("SELECT COUNT(*) FROM items").fetchone()[0]
        assert before == after
        assert res["applied"] is False

        note_row = db.get_item(c, "obsidian:note2")
        assert note_row is not None
        assert "promoted_to" not in _md(note_row)


def test_migrate_apply_creates_and_stamps():
    with db.connect(":memory:") as c:
        vid = "dQw4w9WgXcQ"
        note_fn = "keep:note3"
        yt_fn = f"youtube:{vid}"

        db.merge_upsert(
            c,
            mk(
                source="keep",
                source_id="note3",
                kind="note",
                title="Note 3",
                body=f"visit https://www.youtube.com/watch?v={vid}",
                now=1000,
            ),
        )

        res1 = note_youtube.migrate(c, apply=True)
        assert res1["applied"] is True

        yt_row = db.get_item(c, yt_fn)
        assert yt_row is not None
        yt_md = _md(yt_row)
        assert yt_md.get("promoted_by") == note_youtube.NOTE_PROMOTE_MARKER

        note_row = db.get_item(c, note_fn)
        assert note_row is not None
        note_md = _md(note_row)
        assert _promoted_to_has(note_md, yt_fn)

        companions = yt_md.get("companions") or []
        assert any(isinstance(x, dict) and x.get("fullname") == note_fn for x in companions)

        # Re-run is idempotent: no duplicate companions.
        res2 = note_youtube.migrate(c, apply=True)
        assert res2.get("already_done", 0) >= 1

        yt_row2 = db.get_item(c, yt_fn)
        companions2 = _md(yt_row2).get("companions") or []
        assert sum(1 for x in companions2 if isinstance(x, dict) and x.get("fullname") == note_fn) == 1


def test_migrate_companion_attach():
    with db.connect(":memory:") as c:
        vid = "dQw4w9WgXcQ"
        yt_fn = f"youtube:{vid}"
        note_fn = "obsidian:note4"

        db.merge_upsert(
            c,
            mk(
                source="youtube",
                source_id=vid,
                kind="video",
                title="YT Vid",
                url=f"https://youtu.be/{vid}",
                now=1000,
                metadata={"companions": []},
            ),
        )

        db.merge_upsert(
            c,
            mk(
                source="obsidian",
                source_id="note4",
                kind="note",
                title="Obs Note",
                body=f"https://youtu.be/{vid}",
                now=1000,
            ),
        )

        res = note_youtube.migrate(c, apply=True)
        assert res["applied"] is True

        yt_count = c.execute("SELECT COUNT(*) FROM items WHERE source='youtube'").fetchone()[0]
        assert yt_count == 1

        yt_row = db.get_item(c, yt_fn)
        yt_md = _md(yt_row)
        companions = yt_md.get("companions") or []
        assert any(isinstance(x, dict) and x.get("fullname") == note_fn for x in companions)

        note_row = db.get_item(c, note_fn)
        note_md = _md(note_row)
        assert _promoted_to_has(note_md, yt_fn)
