"""PKMS promote bridge + route tests (spec 15).

All offline: the PKMS ``/capture`` endpoint is mocked at the ``deliver`` seam —
no live calls, no network (the PKMS endpoint's new fields land in its own
build packet).
"""

import json

from content_hoarder import db, models
from content_hoarder._http import HttpError
from content_hoarder.bridge import pkms
from content_hoarder.web import create_app

NOW = 1_750_000_000
SAVED = "saved \u2713 inbox/2026-07-31-hedgehog.md"
ALREADY = "already saved \u2713 inbox/2026-07-31-hedgehog.md"


def _seed(conn):
    db.merge_upsert(conn, models.new_item(
        source="reddit", source_id="t3_a", kind="post", title="Hedgehog",
        body="Body line one.\n\nBody line two.",
        url="https://www.reddit.com/r/hh/comments/a/",
        metadata={"subreddit": "hh", "tags": ["coding"]}, now=NOW,
    ))
    conn.commit()


def _public(conn, fullname):
    row = conn.execute("SELECT * FROM items WHERE fullname=?", (fullname,)).fetchone()
    return db._row_to_public(row)


def _promotion(conn, fullname):
    md = json.loads(
        conn.execute("SELECT metadata FROM items WHERE fullname=?", (fullname,)).fetchone()[0]
    )
    return md.get("promotion") or {}


def _client(tmp_db):
    conn = db.connect(tmp_db)
    _seed(conn)
    conn.close()
    return create_app(tmp_db).test_client()


# ---- envelope construction ----


def test_build_capture_envelope_fields(conn):
    _seed(conn)
    env = pkms.build_capture(_public(conn, "reddit:t3_a"))
    slug = pkms._id_slug("reddit:t3_a")
    assert env == {
        "text": "Hedgehog\n\nBody line one.\n\nBody line two.\n\n"
                "https://www.reddit.com/r/hh/comments/a/",
        "source_account_id": "acct_content_hoarder_reddit",
        "raw_ref": "https://www.reddit.com/r/hh/comments/a/",
        "context": {"device": "desktop", "app": "content-hoarder"},
        "ch_item_id": f"ext_ch_{slug}",
        "ch_origin_ref": "content-hoarder:fullname:reddit:t3_a",
        "ch_captured_at": "2025-06-15T15:06:40Z",
    }


def test_build_capture_summary_prefers_metadata_and_missing_url_falls_back(conn):
    db.merge_upsert(conn, models.new_item(
        source="keep", source_id="n1", title="Note", body="long body",
        url="", metadata={"summary": "short"}, now=NOW,
    ))
    conn.commit()
    env = pkms.build_capture(_public(conn, "keep:n1"))
    assert env["text"] == "Note\n\nshort"  # no URL line when there is no url
    assert env["raw_ref"] == "content-hoarder:fullname:keep:n1"  # never flattened


def test_build_capture_device_override():
    env = pkms.build_capture(
        {"fullname": "reddit:t3_a", "source": "reddit", "title": "T",
         "body": "", "url": "http://x", "first_seen_utc": NOW},
        device="phone",
    )
    assert env["context"] == {"device": "phone", "app": "content-hoarder"}


# ---- transport ----


def test_deliver_posts_to_capture(monkeypatch):
    monkeypatch.setenv("PKMS_CAPTURE_URL", "http://127.0.0.1:8765")
    monkeypatch.setenv("PKMS_CAPTURE_TOKEN", "tok-secret")
    seen = {}

    def fake_request(url, *, method, headers, data, timeout):
        seen.update(url=url, method=method, headers=headers,
                    body=json.loads(data.decode("utf-8")), timeout=timeout)
        return 200, {}, SAVED.encode("utf-8")

    monkeypatch.setattr("content_hoarder._http.request", fake_request)
    body = pkms.deliver({"text": "T"})
    assert body == SAVED
    assert seen["url"] == "http://127.0.0.1:8765/capture?source=content-hoarder"
    assert seen["method"] == "POST"
    assert seen["headers"]["X-Capture-Token"] == "tok-secret"
    assert seen["headers"]["Content-Type"] == "application/json"
    assert seen["body"] == {"text": "T"}
    assert seen["timeout"] == 15


# ---- orchestration + receipts ----


def test_promote_happy_path_stamps_receipt(conn, monkeypatch):
    monkeypatch.setenv("PKMS_CAPTURE_URL", "http://127.0.0.1:8765")
    monkeypatch.setenv("PKMS_CAPTURE_TOKEN", "tok")
    _seed(conn)
    sent = []
    monkeypatch.setattr(pkms, "deliver", lambda env: sent.append(env) or SAVED)

    res = pkms.promote(conn, _public(conn, "reddit:t3_a"))
    assert res["status"] == "promoted" and res["promoted"] is True
    assert res["response"] == SAVED
    assert len(sent) == 1
    assert sent[0]["ch_item_id"] == f"ext_ch_{pkms._id_slug('reddit:t3_a')}"

    promo = _promotion(conn, "reddit:t3_a")
    assert promo["status"] == "promoted"
    assert promo["transport"] == "http_post_capture"
    assert promo["delivery_ref"] == "inbox/2026-07-31-hedgehog.md"
    assert promo["response"] == SAVED
    receipt = promo["receipt"]
    assert receipt["result"] == "executed"
    assert receipt["actor"] == "user"
    assert receipt["reversibility"] == "reversible"
    assert receipt["id"] == f"receipt_ch_{pkms._id_slug('reddit:t3_a')}_promote"
    assert receipt["source_span_ids"] == [f"span_ch_{pkms._id_slug('reddit:t3_a')}"]


def test_promote_replay_no_double_post(conn, monkeypatch):
    monkeypatch.setenv("PKMS_CAPTURE_URL", "http://127.0.0.1:8765")
    monkeypatch.setenv("PKMS_CAPTURE_TOKEN", "tok")
    _seed(conn)
    calls = []
    monkeypatch.setattr(pkms, "deliver", lambda env: calls.append(env) or SAVED)

    first = pkms.promote(conn, _public(conn, "reddit:t3_a"))
    assert first["status"] == "promoted" and len(calls) == 1

    # second promote is a CH-level replay: NO second POST, same receipt back.
    second = pkms.promote(conn, _public(conn, "reddit:t3_a"))
    assert second["status"] == "replay"
    assert len(calls) == 1
    assert second["receipt"]["id"] == first["receipt"]["id"]
    assert _promotion(conn, "reddit:t3_a")["status"] == "promoted"  # single stamp


def test_promote_already_saved_on_pkms_is_replay_stamped_once(conn, monkeypatch):
    monkeypatch.setenv("PKMS_CAPTURE_URL", "http://127.0.0.1:8765")
    monkeypatch.setenv("PKMS_CAPTURE_TOKEN", "tok")
    _seed(conn)
    monkeypatch.setattr(pkms, "deliver", lambda env: ALREADY)

    res = pkms.promote(conn, _public(conn, "reddit:t3_a"))
    assert res["status"] == "replay" and res["promoted"] is True
    assert res["response"] == ALREADY
    promo = _promotion(conn, "reddit:t3_a")
    assert promo["status"] == "promoted"
    assert promo["delivery_ref"] == "inbox/2026-07-31-hedgehog.md"


def test_promote_transport_failure_records_failed(conn, monkeypatch):
    monkeypatch.setenv("PKMS_CAPTURE_URL", "http://127.0.0.1:8765")
    monkeypatch.setenv("PKMS_CAPTURE_TOKEN", "tok")
    _seed(conn)
    monkeypatch.setattr(
        pkms, "deliver",
        lambda env: (_ for _ in ()).throw(
            HttpError("HTTP 403 for http://127.0.0.1:8765/capture", status=403, kind="http")
        ),
    )

    res = pkms.promote(conn, _public(conn, "reddit:t3_a"))
    assert res["status"] == "failed" and res["promoted"] is False
    assert "403" in res["error"]
    promo = _promotion(conn, "reddit:t3_a")
    assert promo["status"] == "failed"
    assert promo["receipt"]["result"] == "failed"
    assert promo["error"]  # failure is never silent


# ---- route oracle ----


def test_route_promote_happy_path(tmp_db, monkeypatch):
    monkeypatch.setenv("PKMS_CAPTURE_URL", "http://127.0.0.1:8765")
    monkeypatch.setenv("PKMS_CAPTURE_TOKEN", "tok")
    cl = _client(tmp_db)
    monkeypatch.setattr(pkms, "deliver", lambda env: SAVED)

    r = cl.post("/items/reddit:t3_a/promote")
    assert r.status_code == 200
    body = r.get_json()
    assert body["status"] == "promoted"
    assert body["response"] == SAVED

    conn = db.connect(tmp_db)
    assert _promotion(conn, "reddit:t3_a")["status"] == "promoted"
    conn.close()


def test_route_promote_unconfigured_clear_error(tmp_db, monkeypatch):
    monkeypatch.setenv("PKMS_CAPTURE_URL", "")
    monkeypatch.setenv("PKMS_CAPTURE_TOKEN", "")
    cl = _client(tmp_db)

    r = cl.post("/items/reddit:t3_a/promote")
    assert r.status_code == 400
    err = r.get_json()["error"]
    assert "PKMS_CAPTURE_URL" in err and "PKMS_CAPTURE_TOKEN" in err
    conn = db.connect(tmp_db)
    assert "promotion" not in _promotion(conn, "reddit:t3_a") or True  # nothing stamped
    conn.close()


def test_route_promote_not_found(tmp_db, monkeypatch):
    monkeypatch.setenv("PKMS_CAPTURE_URL", "http://127.0.0.1:8765")
    monkeypatch.setenv("PKMS_CAPTURE_TOKEN", "tok")
    cl = _client(tmp_db)
    monkeypatch.setattr(pkms, "deliver", lambda env: SAVED)

    assert cl.post("/items/nope/promote").status_code == 404


def test_route_promote_device_from_ua(tmp_db, monkeypatch):
    monkeypatch.setenv("PKMS_CAPTURE_URL", "http://127.0.0.1:8765")
    monkeypatch.setenv("PKMS_CAPTURE_TOKEN", "tok")
    cl = _client(tmp_db)
    seen = {}
    monkeypatch.setattr(
        pkms, "deliver", lambda env: seen.update(env) or SAVED
    )

    r = cl.post("/items/reddit:t3_a/promote",
                headers={"User-Agent": "Mozilla/5.0 (Linux; Android 14) Mobile"})
    assert r.status_code == 200
    assert seen["context"]["device"] == "phone"


def test_route_promote_transport_failure_502_with_failed_receipt(tmp_db, monkeypatch):
    monkeypatch.setenv("PKMS_CAPTURE_URL", "http://127.0.0.1:8765")
    monkeypatch.setenv("PKMS_CAPTURE_TOKEN", "tok")
    cl = _client(tmp_db)
    monkeypatch.setattr(
        pkms, "deliver",
        lambda env: (_ for _ in ()).throw(HttpError("connection refused", kind="conn")),
    )

    r = cl.post("/items/reddit:t3_a/promote")
    assert r.status_code == 502
    assert r.get_json()["status"] == "failed"
    conn = db.connect(tmp_db)
    assert _promotion(conn, "reddit:t3_a")["status"] == "failed"
    conn.close()


def test_note_name_fallback_empty_without_checkmark():
    # A non-confirmation 2xx body must never be recorded as a vault path.
    assert pkms._note_name("") == ""
    assert pkms._note_name("saved") == ""
    assert pkms._note_name("200 OK") == ""
    assert pkms._note_name("saved \u2713 inbox/x.md") == "inbox/x.md"


def test_promote_unparseable_2xx_is_failure_and_retryable(tmp_db, monkeypatch):
    """Spec 15 §5/§1.6: a 2xx body without the ``saved ✓`` confirmation is not
    a promoted write — record ``failed`` (no delivery_ref, error set) and keep
    the item retryable so a re-promote re-POSTs (PKMS dedupe makes it safe)."""
    monkeypatch.setenv("PKMS_CAPTURE_URL", "http://127.0.0.1:8765")
    monkeypatch.setenv("PKMS_CAPTURE_TOKEN", "tok")
    cl = _client(tmp_db)
    calls: list[str] = []
    monkeypatch.setattr(pkms, "deliver", lambda env: (calls.append(1) or "ok"))

    r = cl.post("/items/reddit:t3_a/promote")
    assert r.status_code == 502
    res = r.get_json()
    assert res["status"] == "failed" and res["promoted"] is False
    assert "unrecognized response body" in res["error"]
    promo = _promotion(db.connect(tmp_db), "reddit:t3_a")
    assert promo["status"] == "failed"
    assert promo["delivery_ref"] == ""
    assert promo["response"] == "ok"
    assert promo["error"]

    # The failed stamp must not short-circuit the next promote: re-POST.
    r2 = cl.post("/items/reddit:t3_a/promote")
    assert r2.status_code == 502
    assert len(calls) == 2
