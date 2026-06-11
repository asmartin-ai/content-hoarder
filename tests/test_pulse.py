"""Epic 20: /pulse — the guilt-free ambient counts (pebbles / "· N new" / decay line)."""
import time

from content_hoarder import db, models
from content_hoarder.web import create_app


def _seed(conn, sid, *, first_seen=None, md=None):
    it = models.new_item(source="reddit", source_id=sid, kind="post", title=sid,
                         metadata=md or {})
    db.merge_upsert(conn, it)
    if first_seen is not None:
        conn.execute("UPDATE items SET first_seen_utc=? WHERE fullname=?",
                     (first_seen, f"reddit:{sid}"))
    conn.commit()


def test_pulse_counts(conn):
    now = int(time.time())
    _seed(conn, "t3_new")                                  # arrived today
    _seed(conn, "t3_old", first_seen=now - 40 * 86400)     # old arrival
    _seed(conn, "t3_done", first_seen=now - 40 * 86400)
    db.set_status(conn, "reddit:t3_done", "done")          # manually cleared today
    _seed(conn, "t3_swept", first_seen=now - 40 * 86400,
          md={"tags": ["memes"]})
    db.decay(conn, tags=["memes"], apply=True)             # decayed today — NOT a clear
    p = db.pulse(conn)
    assert p["new_today"] == 1
    assert p["cleared_today"] == 1          # the decay-stamped row is excluded
    assert p["swept_recent"] == 1


def test_pulse_swept_window(conn):
    now = int(time.time())
    _seed(conn, "t3_a", first_seen=now - 400 * 86400, md={"tags": ["memes"]})
    db.decay(conn, tags=["memes"], apply=True)
    # push the stamp outside the 30-day window
    conn.execute(
        "UPDATE items SET metadata=json_set(metadata, '$.decayed_at', ?) "
        "WHERE fullname='reddit:t3_a'", (now - 45 * 86400,))
    conn.commit()
    assert db.pulse(conn)["swept_recent"] == 0


def test_pulse_route(tmp_db):
    c = db.connect(tmp_db)
    _seed(c, "t3_x")
    c.close()
    r = create_app(tmp_db).test_client().get("/pulse").get_json()
    assert r == {"new_today": 1, "cleared_today": 0, "swept_recent": 0}
