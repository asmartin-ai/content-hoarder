"""Epic 20: resurfacing card — candidate ranking, rationing, dismiss/letgo semantics.

Design contract: docs/resurfacing-card-design.md (LOCKED 2026-06-11). The hard rules
pinned here: knowledge clusters only, min volume, one card per day, "Not now" = 30-day
silence, "Let it go" = reversible decay that never re-asks, reactivation outranks
dormancy.
"""
import json

from content_hoarder import db, models, resurface
from content_hoarder.web import create_app

NOW = 1_779_969_600  # 12:00 UTC on a fixed day — midday so no local TZ flips the date
DAY = 86400


class _First:
    """rng stub: always picks the top-ranked candidate (no tie-break randomness)."""
    @staticmethod
    def choice(seq):
        return seq[0]


def _seed_cluster(conn, sub=None, tag=None, n=12, first_seen=NOW - 200 * DAY,
                  prefix="t3", score=None):
    for i in range(n):
        md = {}
        if sub:
            md["subreddit"] = sub
        if tag:
            md["tags"] = [tag]
        if score is not None:
            md["triage_score"] = score
        it = models.new_item(source="reddit", source_id=f"{prefix}-{i}", kind="post",
                             title=f"{prefix} item {i}", metadata=md)
        db.merge_upsert(conn, it)
    # '-' separator on purpose: LIKE's '_' is a single-char wildcard ('b_%' would
    # also match 'bfresh-0' and re-stamp a sibling cluster's rows)
    conn.execute(
        "UPDATE items SET first_seen_utc=? WHERE source_id LIKE ?",
        (first_seen, f"{prefix}-%"),
    )
    conn.commit()


def test_no_candidate_on_empty_db(conn):
    assert resurface.candidate(conn, now=NOW, rng=_First) is None


def test_min_volume_enforced(conn):
    _seed_cluster(conn, sub="adhd", n=resurface.MIN_CLUSTER - 1)
    assert resurface.candidate(conn, now=NOW, rng=_First) is None


def test_unknown_subreddit_never_resurfaces(conn):
    # plenty of volume, but not a curated knowledge cluster
    _seed_cluster(conn, sub="gamingmemes", n=30)
    assert resurface.candidate(conn, now=NOW, rng=_First) is None


def test_dormant_cluster_card_shape(conn):
    _seed_cluster(conn, sub="adhd", n=12)
    card = resurface.candidate(conn, now=NOW, rng=_First)
    assert card["cluster"] == "subreddit:adhd"
    assert card["label"] == "r/adhd"
    assert card["count"] == 12
    assert card["last_added_utc"] == NOW - 200 * DAY
    assert card["reactivated"] is False
    assert len(card["sample"]) == 3 and {"fullname", "title", "thumbnail"} <= set(card["sample"][0])
    assert card["query"] == "subreddit:adhd status:inbox"


def test_fresh_cluster_is_not_a_candidate(conn):
    # active lately and not reactivation-shaped -> no question to ask
    _seed_cluster(conn, tag="coding", n=15, first_seen=NOW - 5 * DAY)
    assert resurface.candidate(conn, now=NOW, rng=_First) is None


def test_rationing_one_card_per_day(conn):
    _seed_cluster(conn, sub="adhd", n=12)
    assert resurface.candidate(conn, now=NOW, rng=_First) is not None
    assert resurface.candidate(conn, now=NOW + 3600, rng=_First) is None  # same day
    assert resurface.candidate(conn, now=NOW + DAY, rng=_First) is not None  # next day


def test_reactivation_outranks_dormancy(conn):
    # cluster A: deeply dormant, high volume
    _seed_cluster(conn, sub="askhistorians", n=30, first_seen=NOW - 400 * DAY, prefix="a")
    # cluster B: dormant base + a save 3 days ago = the reactivation signal (CH4)
    _seed_cluster(conn, sub="adhd", n=12, first_seen=NOW - 150 * DAY, prefix="b")
    _seed_cluster(conn, sub="adhd", n=1, first_seen=NOW - 3 * DAY, prefix="bfresh")
    card = resurface.candidate(conn, now=NOW, rng=_First)
    assert card["cluster"] == "subreddit:adhd"
    assert card["reactivated"] is True


def test_triage_score_ranks_dormant_clusters(conn):
    # equal dormancy; the model's propensity breaks the tie (Epic 10 integration point)
    _seed_cluster(conn, tag="science", n=12, score=0.05, prefix="lo")
    _seed_cluster(conn, tag="tips", n=12, score=0.60, prefix="hi")
    card = resurface.candidate(conn, now=NOW, rng=_First)
    assert card["cluster"] == "tag:tips"


def test_dismiss_no_renag_window(conn):
    _seed_cluster(conn, sub="adhd", n=12)
    resurface.dismiss(conn, "subreddit:adhd", now=NOW)
    assert resurface.candidate(conn, now=NOW + DAY, rng=_First) is None
    # window expired -> eligible again
    card = resurface.candidate(conn, now=NOW + 31 * DAY, rng=_First)
    assert card is not None and card["cluster"] == "subreddit:adhd"


def test_letgo_decays_never_reasks_and_undo_restores(conn):
    _seed_cluster(conn, sub="adhd", n=12)
    res = resurface.letgo(conn, "subreddit:adhd", now=NOW)
    assert res["total"] == 12 and isinstance(res["decayed_at"], int)
    # cluster decayed: items archived + stamped, never re-asked
    st = [r[0] for r in conn.execute("SELECT DISTINCT status FROM items")]
    assert st == ["archived"]
    assert resurface.candidate(conn, now=NOW + 100 * DAY, rng=_First) is None
    # undo: items back in inbox, stamp gone, cluster eligible again
    undo = resurface.undo_letgo(conn, "subreddit:adhd", res["decayed_at"])
    assert undo["total"] == 12
    assert conn.execute("SELECT COUNT(*) FROM items WHERE status='inbox'").fetchone()[0] == 12
    card = resurface.candidate(conn, now=NOW + 100 * DAY, rng=_First)
    assert card is not None


def test_letgo_same_second_waves_undo_independently(conn, monkeypatch):
    """B1 acceptance: letgo(A) then letgo(B) within the same wall-clock second, then
    undo_letgo(A) -> only A's rows return to inbox; B's stay decayed."""
    _seed_cluster(conn, sub="adhd", n=12, prefix="t3")
    _seed_cluster(conn, tag="tips", n=12, prefix="tip")
    monkeypatch.setattr(db.time, "time", lambda: NOW)  # frozen identical `now`
    a = resurface.letgo(conn, "subreddit:adhd")
    b = resurface.letgo(conn, "tag:tips")
    assert a["decayed_at"] != b["decayed_at"]
    resurface.undo_letgo(conn, "subreddit:adhd", a["decayed_at"])
    adhd_inbox = conn.execute(
        "SELECT COUNT(*) FROM items WHERE status='inbox' AND "
        "lower(json_extract(metadata,'$.subreddit'))='adhd'").fetchone()[0]
    tips_archived = conn.execute(
        "SELECT COUNT(*) FROM items WHERE status='archived' AND EXISTS "
        "(SELECT 1 FROM json_each(metadata,'$.tags') WHERE value='tips')").fetchone()[0]
    assert adhd_inbox == 12 and tips_archived == 12


def test_letgo_rejects_uncurated_cluster(conn):
    # the web layer must not be able to decay an arbitrary subreddit
    import pytest
    with pytest.raises(ValueError):
        resurface.letgo(conn, "subreddit:funny")
    with pytest.raises(ValueError):
        resurface.dismiss(conn, "tag:memes")


def test_state_round_trips_through_settings(conn):
    _seed_cluster(conn, sub="adhd", n=12)
    resurface.dismiss(conn, "subreddit:adhd", now=NOW)
    raw = db.get_setting(conn, resurface.STATE_KEY)
    state = json.loads(raw)
    assert state["subreddit:adhd"]["dismissed_until"] == NOW + 30 * DAY


# ---- routes -----------------------------------------------------------------

def _client(tmp_db, seed=True):
    if seed:
        c = db.connect(tmp_db)
        _seed_cluster(c, sub="adhd", n=12)
        c.close()
    return create_app(tmp_db).test_client()


def test_route_resurface_card_then_204(tmp_db):
    cl = _client(tmp_db)
    r = cl.get("/resurface")
    assert r.status_code == 200
    card = r.get_json()
    assert card["cluster"] == "subreddit:adhd" and len(card["sample"]) == 3
    # rationed: second open the same day gets nothing
    assert cl.get("/resurface").status_code == 204


def test_route_resurface_204_when_no_candidate(tmp_db):
    assert _client(tmp_db, seed=False).get("/resurface").status_code == 204


def test_route_dismiss_and_letgo_undo(tmp_db):
    cl = _client(tmp_db)
    assert cl.post("/resurface/dismiss", json={"cluster": "subreddit:adhd"}).status_code == 204
    assert cl.post("/resurface/dismiss", json={"cluster": "subreddit:nope"}).status_code == 400
    r = cl.post("/resurface/letgo", json={"cluster": "subreddit:adhd"}).get_json()
    assert r["total"] == 12
    u = cl.post("/resurface/letgo/undo",
                json={"cluster": "subreddit:adhd", "decayed_at": r["decayed_at"]}).get_json()
    assert u["total"] == 12
    assert cl.post("/resurface/letgo/undo",
                   json={"cluster": "subreddit:adhd"}).status_code == 400
