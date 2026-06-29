import json

from content_hoarder import db, firefox_tabs
from content_hoarder.connectors.firefox import FIREFOX_TABS_SCHEMA
from content_hoarder.web import create_app

TOKEN = "test-firefox-token"


def _client(tmp_db, *, configure_token=True):
    if configure_token:
        conn = db.connect(tmp_db)
        firefox_tabs.store_token_hash(conn, TOKEN)
        conn.close()
    return create_app(tmp_db).test_client()


def _payload():
    return {
        "schema": FIREFOX_TABS_SCHEMA,
        "source": "webextension",
        "captured_at": 1_770_000_000,
        "snapshot_id": "snap-1",
        "tabs": [
            {
                "url": "https://example.com/article",
                "title": "Example article",
                "favIconUrl": "https://example.com/favicon.ico",
                "windowId": 3,
                "index": 0,
                "pinned": False,
                "active": True,
                "discarded": False,
                "lastAccessed": 1_770_000_000_123,
            },
            {
                "url": "https://www.youtube.com/watch?v=q_ZTwCx1VSI&list=WL",
                "title": "(2) Fauna's physics lecture - YouTube",
                "windowId": 3,
                "pinned": True,
            },
            {"url": "about:config", "title": "Config"},
            {"url": "https://example.com/private", "incognito": True},
        ],
    }


def test_firefox_tabs_ingest_requires_configured_token(tmp_db):
    res = _client(tmp_db, configure_token=False).post(
        "/import/firefox-tabs",
        json=_payload(),
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert res.status_code == 503


def test_firefox_tabs_ingest_rejects_missing_and_wrong_token(tmp_db):
    cl = _client(tmp_db)
    assert cl.post("/import/firefox-tabs", json=_payload()).status_code == 401
    res = cl.post(
        "/import/firefox-tabs",
        json=_payload(),
        headers={"Authorization": "Bearer wrong"},
    )
    assert res.status_code == 403


def test_firefox_tabs_ingest_rejects_malformed_payload(tmp_db):
    cl = _client(tmp_db)
    res = cl.post(
        "/import/firefox-tabs",
        json={"schema": "wrong", "tabs": []},
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert res.status_code == 400
    assert "schema" in res.get_json()["error"]

    res = cl.post(
        "/import/firefox-tabs",
        data="not json",
        content_type="text/plain",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert res.status_code == 400


def test_firefox_tabs_ingest_valid_token_imports_tabs(tmp_db):
    cl = _client(tmp_db)
    res = cl.post(
        "/import/firefox-tabs",
        json=_payload(),
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert res.status_code == 200
    body = res.get_json()
    assert body["imported"] == 2
    assert body["skipped"] == 2
    assert body["errors"] == []
    assert body["youtube_promoted"] == 1
    assert "youtube:q_ZTwCx1VSI" in body["sample"]

    conn = db.connect(tmp_db)
    try:
        firefox_rows = db.search_items(conn, "", open_in_firefox=True, source="firefox")
        assert len(firefox_rows) == 1
        row = firefox_rows[0]
        assert row["url"] == "https://example.com/article"
        md = row["metadata"]
        assert md["open_in_firefox"] is True
        assert md["firefox_capture_source"] == "webextension"
        assert md["firefox_captured_at"] == 1_770_000_000
        assert md["firefox_snapshot_id"] == "snap-1"
        assert md["firefox_last_accessed_ms"] == 1_770_000_000_123

        yt = db.get_item(conn, "youtube:q_ZTwCx1VSI")
        assert yt is not None
        ymd = json.loads(yt["metadata"])
        assert ymd["open_in_firefox"] is True
        assert (
            ymd["firefox_original_url"]
            == "https://www.youtube.com/watch?v=q_ZTwCx1VSI&list=WL"
        )
    finally:
        conn.close()


def test_firefox_tabs_ingest_allows_tokened_cross_origin_extension_post(tmp_db):
    cl = _client(tmp_db)
    res = cl.post(
        "/import/firefox-tabs",
        json=_payload(),
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Origin": "moz-extension://00000000-0000-0000-0000-000000000000",
        },
    )
    assert res.status_code == 200


def test_firefox_tabs_ingest_accepts_legacy_header(tmp_db):
    cl = _client(tmp_db)
    res = cl.post(
        "/import/firefox-tabs",
        json=_payload(),
        headers={"X-Content-Hoarder-Token": TOKEN},
    )
    assert res.status_code == 200
