"""media_scan: probe + classify reddit media for deletion (promoted from the one-off
scripts/scan_deleted_media.py). Probe is injected, so the whole pass is offline-testable."""

import json

from content_hoarder import db, media_scan, models


def _md(conn, fn):
    row = db.get_item(conn, fn)
    assert row is not None, fn
    return json.loads(row["metadata"] or "{}")


def _seed(conn, sid, **meta):
    db.merge_upsert(
        conn,
        models.new_item(
            source="reddit",
            source_id=sid,
            kind="post",
            title=sid,
            url=meta.pop("url", "https://www.reddit.com/r/x/comments/%s/t/" % sid),
            metadata=meta,
        ),
    )


def test_helpers_classify_media_detection():
    assert media_scan.is_media({"media_type": "image"}, "")
    assert media_scan.is_media({"gallery": ["a.jpg"]}, "")
    assert media_scan.is_media({}, "https://i.redd.it/x.jpg")
    assert not media_scan.is_media({}, "https://www.reddit.com/r/x/comments/a/t/")
    # best prefers gallery[0], then direct url, then media_url; preview only if redd.it
    best, prev = media_scan.best_and_preview(
        {
            "gallery": ["https://i.redd.it/g0.jpg"],
            "thumbnail": "https://preview.redd.it/t.jpg",
        },
        "https://www.reddit.com/r/x/comments/a/t/",
    )
    assert (
        best == "https://i.redd.it/g0.jpg" and prev == "https://preview.redd.it/t.jpg"
    )


def test_classify_states():
    def alive(u):
        return 200

    def dead(u):
        return 404

    def half(u):  # full gone, preview alive
        return 404 if "full" in u else 200

    assert media_scan.classify(("fn", "full.jpg", "", []), alive)[1] == "alive"
    assert media_scan.classify(("fn", "full.jpg", "", []), dead)[1] == "gone"
    assert media_scan.classify(("fn", "full.jpg", "prev.jpg", []), half)[:3] == (
        "fn",
        "salvageable",
        "prev.jpg",
    )
    assert media_scan.classify(("fn", "full.jpg", "", []), lambda u: -1)[1] == "unknown"


def test_scan_apply_writes_status_and_deleted_tag(conn):
    _seed(conn, "alive", media_url="https://i.redd.it/alive.jpg")
    _seed(
        conn,
        "salv",
        media_url="https://i.redd.it/salv.jpg",
        thumbnail="https://preview.redd.it/salv_t.jpg",
    )
    _seed(conn, "gone", media_url="https://i.redd.it/gone.jpg", tags=["memes"])
    _seed(conn, "galg", gallery=["https://i.redd.it/galg.jpg"])
    _seed(conn, "unk", media_url="https://i.redd.it/unk.jpg")
    _seed(
        conn, "text", url="https://www.reddit.com/r/x/comments/text/t/"
    )  # not media -> skipped
    conn.commit()

    codes = {
        "https://i.redd.it/alive.jpg": 200,
        "https://i.redd.it/salv.jpg": 404,
        "https://preview.redd.it/salv_t.jpg": 200,
        "https://i.redd.it/gone.jpg": 404,
        "https://i.redd.it/galg.jpg": 404,
        "https://i.redd.it/unk.jpg": -1,
    }

    def probe(u):
        return codes.get(u, 404)

    res = media_scan.scan(conn, apply=True, workers=1, batch=2, probe=probe)
    assert res["scanned"] == 5  # text excluded
    assert (res["alive"], res["salvageable"], res["gone"], res["unknown"]) == (
        1,
        1,
        2,
        1,
    )
    # writes: gone -> status + deleted tag (existing kept); salvageable -> status only
    assert _md(conn, "reddit:gone")["media_status"] == "gone"
    assert set(_md(conn, "reddit:gone")["tags"]) == {"memes", "deleted"}
    assert _md(conn, "reddit:galg")["media_status"] == "gone"
    assert _md(conn, "reddit:salv")["media_status"] == "salvageable"
    assert (
        _md(conn, "reddit:salv")["media_salvage_url"]
        == "https://preview.redd.it/salv_t.jpg"
    )
    assert "media_status" not in _md(
        conn, "reddit:alive"
    )  # alive/unknown never stamped
    assert "media_status" not in _md(conn, "reddit:unk")
    assert res["salvageable_items"] == [
        {"fullname": "reddit:salv", "live_url": "https://preview.redd.it/salv_t.jpg"}
    ]


def test_scan_skips_classified_unless_recheck(conn):
    _seed(conn, "gone", media_url="https://i.redd.it/gone.jpg")
    _seed(conn, "alive", media_url="https://i.redd.it/alive.jpg")
    conn.commit()

    def probe(u):
        return 200 if "alive" in u else 404

    media_scan.scan(conn, apply=True, workers=1, probe=probe)  # gone gets stamped
    # re-run: only the un-stamped (alive + the never-decided) are re-probed; gone is skipped
    again = media_scan.scan(conn, apply=True, workers=1, probe=probe)
    assert again["scanned"] == 1 and again["alive"] == 1  # only 'alive' reprobed
    # --recheck re-probes everything including the already-gone row
    rc = media_scan.scan(conn, apply=True, workers=1, recheck=True, probe=probe)
    assert rc["scanned"] == 2
