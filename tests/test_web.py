import io
import json
from pathlib import Path

from content_hoarder import db, models
from content_hoarder.web import create_app

NOW = 2_000_000_000


def _seed(dbp):
    conn = db.connect(dbp)
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_a", kind="post",
                    title="Hedgehog", url="http://r/a", metadata={"subreddit": "hh"}))
    db.merge_upsert(conn, models.new_item(source="youtube", source_id="v1", kind="video",
                    title="Vid", url="https://youtu.be/v1"))
    conn.commit()
    conn.close()


def _client(tmp_db):
    _seed(tmp_db)
    return create_app(tmp_db).test_client()


def _seed_done_retention(dbp):
    conn = db.connect(dbp)
    try:
        db.merge_upsert(conn, models.new_item(
            source="reddit", source_id="old_done", kind="post", title="Old done",
            url="https://example.com/old", now=NOW - 5000,
        ))
        db.merge_upsert(conn, models.new_item(
            source="reddit", source_id="recent_done", kind="post", title="Recent done",
            url="https://example.com/recent", now=NOW - 4000,
        ))
        db.merge_upsert(conn, models.new_item(
            source="reddit", source_id="keep_me", kind="post", title="Keep me",
            url="https://example.com/keep", now=NOW - 3000,
        ))
        conn.execute(
            "UPDATE items SET status='done', processed_utc=?, status_prev='inbox' "
            "WHERE fullname='reddit:old_done'",
            (NOW - 31 * 86400,),
        )
        conn.execute(
            "UPDATE items SET status='done', processed_utc=?, status_prev='inbox' "
            "WHERE fullname='reddit:recent_done'",
            (NOW - 3 * 86400,),
        )
        conn.execute(
            "UPDATE items SET status='keep', processed_utc=?, status_prev='inbox' "
            "WHERE fullname='reddit:keep_me'",
            (NOW - 40 * 86400,),
        )
        conn.commit()
    finally:
        conn.close()


def test_items_search(tmp_db):
    r = _client(tmp_db).get("/items?q=hedgehog").get_json()
    assert r["items"][0]["fullname"] == "reddit:t3_a"


def test_items_fuzzy_default_and_exact_override(tmp_db):
    cl = _client(tmp_db)
    # fuzzy is the DEFAULT: a bare typo'd term matches (Epic 12 flip)
    r = cl.get("/items?q=hedgmog").get_json()
    assert any(i["fullname"] == "reddit:t3_a" for i in r["items"])
    # ?exact=1 (the repurposed checkbox) forces the exact path -> typo misses
    r = cl.get("/items?exact=1&q=hedgmog").get_json()
    assert not any(i["fullname"] == "reddit:t3_a" for i in r["items"])
    # quoted phrases are exact even in fuzzy default mode
    r = cl.get('/items?q="Hedgehog"').get_json()
    assert any(i["fullname"] == "reddit:t3_a" for i in r["items"])


def test_export_csv_json_and_tag_filter(tmp_db):
    cl = _client(tmp_db)
    conn = db.connect(tmp_db)
    db.merge_upsert(conn, models.new_item(
        source="reddit", source_id="t3_x", kind="post", title="X",
        metadata={"subreddit": "hh", "tags": ["nsfw_erotic"],
                  "permalink": "https://www.reddit.com/r/hh/comments/x/"}))
    conn.commit()
    conn.close()

    r = cl.get("/export?format=json&tag=nsfw_erotic").get_json()
    assert r["count"] == 1
    assert r["items"][0]["fullname"] == "reddit:t3_x"
    assert r["items"][0]["permalink"].endswith("/x/")

    # operator form is equivalent to the param form
    r2 = cl.get("/export?format=json&q=tag:nsfw_erotic").get_json()
    assert r2["count"] == 1

    body = cl.get("/export?format=csv&tag=nsfw_erotic")
    assert body.mimetype == "text/csv"
    text = body.data.decode("utf-8")
    assert text.splitlines()[0].startswith("fullname,source,")
    assert "reddit:t3_x" in text

    # unfiltered export returns everything (the 2 seeds + t3_x)
    assert cl.get("/export?format=json").get_json()["count"] == 3


def test_sources_and_stats(tmp_db):
    cl = _client(tmp_db)
    ids = {s["id"] for s in cl.get("/sources").get_json()["sources"]}
    assert {"reddit", "youtube"} <= ids
    assert cl.get("/stats").get_json()["total"] == 2


def test_done_retention_settings_get_and_persist(tmp_db, monkeypatch):
    monkeypatch.setattr("content_hoarder.web.time.time", lambda: NOW)
    cl = _client(tmp_db)
    _seed_done_retention(tmp_db)

    res = cl.get("/settings/done-retention")
    assert res.status_code == 200
    body = res.get_json()
    assert body["retention_days"] == 30
    assert body["preview"]["total"] == 1
    assert body["preview"]["cutoff"] == NOW - 30 * 86400

    saved = cl.post("/settings/done-retention", json={"retention_days": 90})
    assert saved.status_code == 200
    body = saved.get_json()
    assert body["retention_days"] == 90
    assert body["preview"]["total"] == 0

    with db.connect(tmp_db) as conn:
        assert db.get_setting(conn, "done_retention_days") == "90"


def test_done_retention_settings_reject_invalid_days(tmp_db):
    cl = _client(tmp_db)
    for payload in ({}, {"retention_days": "abc"}, {"retention_days": 0}, {"retention_days": -7}):
        res = cl.post("/settings/done-retention", json=payload)
        assert res.status_code == 400
        assert "retention_days" in res.get_json()["error"]


def test_done_retention_purge_applies_backup_audit_and_keeps_non_done_rows(tmp_db, monkeypatch):
    monkeypatch.setattr("content_hoarder.web.time.time", lambda: NOW)
    cl = _client(tmp_db)
    _seed_done_retention(tmp_db)

    preview = cl.get("/settings/done-retention").get_json()["preview"]
    res = cl.post("/settings/done-retention/purge", json={
        "expected_total": preview["total"],
        "expected_cutoff": preview["cutoff"],
    })
    assert res.status_code == 200
    body = res.get_json()
    assert body["purged"]["total"] == 1
    assert body["purged"]["applied"] is True
    assert body["preview"]["total"] == 0

    tmp_dir = Path(tmp_db).parent
    backups = list(tmp_dir.glob("app.backup-pre-purge-done-*.db"))
    assert len(backups) == 1
    assert body["purged"]["backup"] == str(backups[0])

    audit_path = tmp_dir / "delete-audit.jsonl"
    assert audit_path.exists()
    audit = json.loads(audit_path.read_text(encoding="utf-8").strip().splitlines()[-1])
    assert audit["op"] == "purge_done"
    assert audit["total"] == 1
    assert audit["backup"] == str(backups[0])
    assert audit["victims"][0]["fullname"] == "reddit:old_done"

    with db.connect(tmp_db) as conn:
        rows = {
            row["fullname"]: row["status"]
            for row in conn.execute("SELECT fullname, status FROM items").fetchall()
        }
    assert "reddit:old_done" not in rows
    assert rows["reddit:recent_done"] == "done"
    assert rows["reddit:keep_me"] == "keep"
    assert rows["reddit:t3_a"] == "inbox"


def test_status_undo_bulk(tmp_db):
    cl = _client(tmp_db)
    assert cl.post("/items/reddit:t3_a/status", json={"status": "keep"}).get_json()["status"] == "keep"
    assert cl.post("/items/reddit:t3_a/undo").get_json()["status"] == "inbox"
    assert cl.post("/bulk/status", json={"fullnames": ["youtube:v1"], "status": "archived"}).get_json()["updated"] == 1


def test_random(tmp_db):
    assert len(_client(tmp_db).get("/random?n=10").get_json()["items"]) == 2


def test_invalid_status(tmp_db):
    assert _client(tmp_db).post("/items/reddit:t3_a/status", json={"status": "bogus"}).status_code == 400


def test_malformed_params_dont_500(tmp_db):
    cl = _client(tmp_db)
    assert cl.get("/items?limit=abc&offset=-9&is_saved=x").status_code == 200
    assert cl.get("/random?n=notanumber").status_code == 200


# -- CSRF / DNS-rebinding guard ----------------------------------------------

def test_cross_origin_post_rejected(tmp_db):
    """A malicious page's no-cors POST carries its own Origin — must be refused."""
    r = _client(tmp_db).post("/items/reddit:t3_a/status", json={"status": "keep"},
                             headers={"Origin": "https://evil.example"})
    assert r.status_code == 403


def test_same_origin_post_allowed(tmp_db):
    r = _client(tmp_db).post("/items/reddit:t3_a/status", json={"status": "keep"},
                             headers={"Origin": "http://localhost"})
    assert r.status_code == 200 and r.get_json()["status"] == "keep"


def test_no_origin_post_allowed(tmp_db):
    """curl/CLI posts carry no Origin; they must keep working."""
    r = _client(tmp_db).post("/items/reddit:t3_a/status", json={"status": "keep"})
    assert r.status_code == 200


def test_rebound_host_rejected(tmp_db):
    """DNS rebinding presents a public hostname in Host — refuse even GETs."""
    cl = _client(tmp_db)
    assert cl.get("/items", headers={"Host": "evil.example.com"}).status_code == 403
    assert cl.post("/items/reddit:t3_a/status", json={"status": "keep"},
                   headers={"Host": "evil.example.com"}).status_code == 403


def test_tailscale_and_lan_hosts_allowed(tmp_db):
    cl = _client(tmp_db)
    assert cl.get("/items", headers={"Host": "100.101.102.103:8788"}).status_code == 200
    assert cl.get("/items", headers={"Host": "192.168.1.20:8788"}).status_code == 200


# -- undo of a drained Done (live re-save / divergence warning) ---------------

def _drain_done(tmp_db):
    """Mark t3_a Done with unsave-on-done enabled, then simulate a completed drain
    (queue row 'done' + is_saved flipped) exactly as reddit_unsave.drain() leaves it."""
    conn = db.connect(tmp_db)
    db.set_setting(conn, "reddit_unsave_on_done", "1")
    db.set_status(conn, "reddit:t3_a", "done")
    conn.execute("UPDATE reddit_unsave SET state='done' WHERE fullname='reddit:t3_a'")
    conn.execute("UPDATE items SET is_saved=0 WHERE fullname='reddit:t3_a'")
    conn.commit()
    conn.close()


def test_undo_drained_done_warns_when_resave_fails(tmp_db):
    cl = _client(tmp_db)
    _drain_done(tmp_db)
    r = cl.post("/items/reddit:t3_a/undo").get_json()
    assert r["status"] == "inbox"
    assert "warning" in r          # no cookie configured -> live re-save impossible
    assert r["is_saved"] == 0      # still divergent, and the response says so


def test_undo_drained_done_resaves(tmp_db, monkeypatch):
    from content_hoarder import reddit_unsave as ru
    cl = _client(tmp_db)
    _drain_done(tmp_db)

    def fake_resave(c, fullname, **kw):  # what ru.resave does on success, sans network
        c.execute("UPDATE items SET is_saved=1 WHERE fullname=?", (fullname,))
        c.execute("DELETE FROM reddit_unsave WHERE fullname=?", (fullname,))
        c.commit()
        return True

    monkeypatch.setattr(ru, "resave", fake_resave)
    r = cl.post("/items/reddit:t3_a/undo").get_json()
    assert r["status"] == "inbox" and r["is_saved"] == 1 and "warning" not in r


def test_undo_pending_done_needs_no_resave(tmp_db):
    """A Done undone before any drain ran just cancels the queued row locally."""
    cl = _client(tmp_db)
    conn = db.connect(tmp_db)
    db.set_setting(conn, "reddit_unsave_on_done", "1")
    db.set_status(conn, "reddit:t3_a", "done")   # queued as 'pending'
    conn.close()
    r = cl.post("/items/reddit:t3_a/undo").get_json()
    assert r["status"] == "inbox" and "warning" not in r
    conn = db.connect(tmp_db)
    assert conn.execute("SELECT COUNT(*) FROM reddit_unsave").fetchone()[0] == 0
    conn.close()


def test_suggest_unconfigured_503(tmp_db, monkeypatch):
    monkeypatch.setenv("LLM_BASE_URL", "")
    assert _client(tmp_db).post("/items/reddit:t3_a/suggest").status_code == 503


def test_import_upload(tmp_db, fixtures):
    cl = _client(tmp_db)
    with open(fixtures / "keep" / "Keep" / "note1.json", "rb") as fh:
        r = cl.post("/import", data={"file": (fh, "note1.json")},
                    content_type="multipart/form-data").get_json()
    assert r["imported"] >= 1


def _yt_playlist(*ids):
    return {"_type": "playlist", "title": "WL", "id": "PL",
            "entries": [{"id": i, "title": i.upper()} for i in ids]}


def test_import_prepare_counts_without_writing_then_commit(tmp_db):
    cl = _client(tmp_db)  # seeds 2 items
    blob = json.dumps(_yt_playlist("abc123", "def456")).encode()
    data = {"file": (io.BytesIO(blob), "wl.json")}
    pr = cl.post("/import/prepare", data=data, content_type="multipart/form-data").get_json()
    assert pr["count"] == 2 and pr["new"] == 2 and pr["source"] == "youtube"
    assert cl.get("/stats").get_json()["total"] == 2  # prepare must NOT write
    res = cl.post("/import/commit", json={"token": pr["token"]}).get_json()
    assert res["imported"] == 2
    assert cl.get("/stats").get_json()["total"] == 4  # commit wrote


def test_import_prepare_url_via_ytdlp(tmp_db, monkeypatch):
    import content_hoarder.web as web

    class FakeProc:
        returncode = 0
        stdout = json.dumps(_yt_playlist("zzz999"))
        stderr = ""

    monkeypatch.setattr(web.shutil, "which", lambda name: "yt-dlp")
    monkeypatch.setattr(web.subprocess, "run", lambda *a, **k: FakeProc())
    cl = _client(tmp_db)
    pr = cl.post("/import/prepare", json={"url": "https://www.youtube.com/playlist?list=PL"}).get_json()
    assert pr["count"] == 1 and pr["source"] == "youtube"


def test_import_prepare_rejects_non_youtube_url(tmp_db):
    assert _client(tmp_db).post("/import/prepare", json={"url": "https://example.com/x"}).status_code == 400


def test_import_commit_expired_token(tmp_db):
    assert _client(tmp_db).post("/import/commit", json={"token": "nope"}).status_code == 400


def test_media_route_serves_blob_and_404s(tmp_path, monkeypatch):
    """/media/<blob> serves a content-addressed local blob (Epic 4 P1) with an immutable
    cache header, and 404s on a missing or path-traversal-shaped id."""
    from content_hoarder import config, media_store
    dbp = tmp_path / "app.db"
    monkeypatch.setattr(config, "db_path", lambda: str(dbp))
    db.connect(str(dbp)).close()                       # init the app DB
    blob = media_store.store(b"IMGBYTES", mime="image/png")  # -> tmp/media/<hash>.png
    cl = create_app(str(dbp)).test_client()

    r = cl.get("/media/" + blob)
    assert r.status_code == 200 and r.data == b"IMGBYTES"
    assert "image/png" in r.headers["Content-Type"]
    assert "immutable" in r.headers.get("Cache-Control", "")
    vblob = media_store.store(b"VIDBYTES", mime="video/mp4")
    vr = cl.get("/media/" + vblob)
    assert vr.status_code == 200 and vr.data == b"VIDBYTES"
    assert "video/mp4" in vr.headers["Content-Type"]
    # missing blob + traversal-shaped id both 404 (never touch the filesystem unsafely)
    assert cl.get("/media/" + ("a" * 64) + ".png").status_code == 404
    assert cl.get("/media/notarealhash").status_code == 404


def test_import_prepare_temp_file_cleaned_on_exit(tmp_db):
    """B4: a previewed-but-never-committed staged temp file is removed by the
    process-exit cleanup, not just the next /import/prepare's 1-hour TTL sweep."""
    import os

    _seed(tmp_db)
    app = create_app(tmp_db)
    cl = app.test_client()
    blob = json.dumps(_yt_playlist("abc123", "def456")).encode()
    data = {"file": (io.BytesIO(blob), "wl.json")}
    cl.post("/import/prepare", data=data, content_type="multipart/form-data")
    paths = [v["path"] for v in app._prepared.values()]
    assert paths and all(os.path.exists(p) for p in paths)  # staged, never committed
    app._cleanup_all_prepared()
    assert not app._prepared
    assert all(not os.path.exists(p) for p in paths)


def test_recover_route(tmp_db, monkeypatch):
    import content_hoarder.archival.service as svc
    seen = {}

    def fake(c, fn, **k):
        seen.update(k)
        return {"recovered": True, "title": "X", "body": "Y", "url": "Z",
                "bytes_archived": 0}

    monkeypatch.setattr(svc, "recover_one", fake)
    r = _client(tmp_db).post("/items/reddit:t3_a/recover")
    assert r.status_code == 200 and r.get_json()["recovered"] is True
    # The live route must wire archive.today (a non-empty media_providers list), not leave
    # it dormant — this is the assertion that the feature is actually live in the app.
    assert seen.get("media_providers"), "route did not pass media_providers (archive.today dormant)"


def test_recover_route_non_reddit_400(tmp_db):
    # real recover_one short-circuits for a non-reddit item (no network)
    assert _client(tmp_db).post("/items/youtube:v1/recover").status_code == 400


def test_set_body_route(tmp_db):
    cl = _client(tmp_db)
    r = cl.post("/items/reddit:t3_a/body", json={"body": "fresh hedgehog notes"})
    assert r.status_code == 200
    data = r.get_json()
    assert data["body"] == "fresh hedgehog notes"
    assert data["metadata"]["body_edited_at"]
    assert cl.get("/items?q=fresh hedgehog notes").get_json()["items"][0]["fullname"] == "reddit:t3_a"


def test_set_body_route_unknown_item(tmp_db):
    assert _client(tmp_db).post("/items/reddit:t3_nope/body", json={"body": "x"}).status_code == 404


def test_reddit_unsave_status_and_enable(tmp_db):
    cl = _client(tmp_db)
    s = cl.get("/reddit/unsave/status").get_json()
    assert s == {"configured": False, "username": None, "enabled": False,
                 "pending": 0, "failed": 0}
    assert cl.post("/reddit/unsave/enable", json={"enabled": True}).get_json()["enabled"] is True
    assert cl.get("/reddit/unsave/status").get_json()["enabled"] is True


def test_reddit_unsave_drain_default_is_dry_run(tmp_db, monkeypatch):
    import content_hoarder.reddit_unsave as ru

    calls = []

    def fake_drain(conn, **kwargs):
        calls.append(kwargs)
        assert kwargs.get("dry_run") is True
        return {"dry_run": True, "selected": 1, "by_subreddit": {"hh": 1}, "sample": []}

    monkeypatch.setattr(ru, "drain", fake_drain)
    r = _client(tmp_db).post("/reddit/unsave/drain", json={})
    data = r.get_json()
    assert r.status_code == 200
    assert data["dry_run"] is True
    assert data["live_required"] == ["live", "confirm"]
    assert calls and calls[0]["limit"] == 50


def test_reddit_unsave_drain_live_requires_confirm(tmp_db, monkeypatch):
    import content_hoarder.reddit_unsave as ru

    calls = []

    def fake_drain(conn, **kwargs):
        calls.append(kwargs)
        assert kwargs.get("dry_run") is True
        return {"dry_run": True, "selected": 1, "by_subreddit": {"hh": 1}, "sample": []}

    monkeypatch.setattr(ru, "drain", fake_drain)
    r = _client(tmp_db).post("/reddit/unsave/drain", json={"live": True})
    data = r.get_json()
    assert r.status_code == 409
    assert data["ok"] is False
    assert data["dry_run"] is True
    assert "confirm" in data["error"]
    assert calls and calls[0]["dry_run"] is True


def test_reddit_unsave_drain_live_with_double_confirm(tmp_db, monkeypatch):
    import content_hoarder.reddit_unsave as ru

    calls = []

    def fake_drain(conn, **kwargs):
        calls.append(kwargs)
        assert kwargs.get("dry_run") is False
        assert kwargs.get("audit") is not None
        return {"selected": 1, "unsaved": 1, "failed": 0, "auth_error": False, "remaining": 0}

    monkeypatch.setattr(ru, "drain", fake_drain)
    r = _client(tmp_db).post(
        "/reddit/unsave/drain", json={"live": True, "confirm": True, "max": 7}
    )
    data = r.get_json()
    assert r.status_code == 200
    assert data["unsaved"] == 1
    assert calls and calls[0]["limit"] == 7


def test_reddit_unsave_auth_route(tmp_db, monkeypatch):
    import content_hoarder.reddit_unsave as ru
    monkeypatch.setattr(ru, "login", lambda c, cookie, **k: "asmartin-ai")
    cl = _client(tmp_db)
    assert cl.post("/reddit/unsave/auth", json={}).status_code == 400  # no cookie
    r = cl.post("/reddit/unsave/auth", json={"cookie": "ck"}).get_json()
    assert r == {"ok": True, "username": "asmartin-ai"}


def test_set_category(tmp_db):
    cl = _client(tmp_db)
    r = cl.post("/items/youtube:v1/category", json={"category": "listenable"})
    assert r.status_code == 200 and r.get_json()["category"] == "listenable"
    assert cl.get("/items?category=listenable").get_json()["items"][0]["fullname"] == "youtube:v1"
    tagged = cl.get("/items?tag=listenable").get_json()["items"]
    assert tagged[0]["fullname"] == "youtube:v1"
    assert tagged[0]["metadata"]["tags"] == ["listenable"]
    cats = {c["id"]: c["count"] for c in cl.get("/categories").get_json()["categories"]}
    assert cats["listenable"] == 1
    assert cl.get("/tags").get_json()["tags"]["listenable"] == 1
    cl.post("/items/youtube:v1/category", json={"category": "unknown"})
    assert cl.get("/items?tag=listenable").get_json()["items"] == []
    assert cl.get("/items?category=unknown").get_json()["items"][0]["fullname"] == "youtube:v1"
    assert cl.post("/items/youtube:v1/category", json={"category": "bogus"}).status_code == 400
    assert cl.post("/items/youtube:nope/category", json={"category": "watch"}).status_code == 404


def test_cross_filtered_counts(tmp_db):
    cl = _client(tmp_db)  # seeds reddit:t3_a + youtube:v1, both inbox
    cl.post("/items/reddit:t3_a/status", json={"status": "keep"})
    # status counts cross-filtered by source
    s = cl.get("/stats?source=reddit").get_json()
    assert s["total"] == 1
    assert s["by_status"].get("keep") == 1 and s["by_status"].get("inbox", 0) == 0
    # source counts cross-filtered by status; reddit still listed even at 0
    src = {x["id"]: x["count"] for x in cl.get("/sources?status=inbox").get_json()["sources"]}
    assert src.get("youtube") == 1 and src.get("reddit") == 0 and "reddit" in src
    cl.post("/items/youtube:v1/category", json={"category": "watch"})
    assert cl.get("/tags?source=youtube&status=inbox").get_json()["tags"] == {"watch": 1}
    assert cl.get("/tags?source=youtube&status=keep").get_json()["tags"] == {}


def test_categories_route_cross_filters_by_source_and_status(tmp_db):
    cl = _client(tmp_db)
    cl.post("/items/youtube:v1/category", json={"category": "listenable"})
    cl.post("/items/reddit:t3_a/category", json={"category": "watch"})
    cl.post("/items/reddit:t3_a/status", json={"status": "keep"})

    cats = cl.get("/categories?source=reddit&status=keep").get_json()
    counts = {x["id"]: x["count"] for x in cats["categories"]}

    assert cats["total"] == 1
    assert counts == {"listenable": 0, "watch": 1, "wotagei": 0, "unknown": 0}


def test_items_search_operators(tmp_db):
    # Seed a DB specifically for operator coverage.
    conn = db.connect(tmp_db)
    db.merge_upsert(conn, models.new_item(
        source="reddit",
        source_id="t3_a",
        kind="post",
        title="Hedgehog removed",
        created_utc=1672444800,  # 2022-12-31
        now=1000,
        metadata={"subreddit": "hh", "tags": ["coding", "memes", "nsfw_other"], "score": 150},
    ))
    db.merge_upsert(conn, models.new_item(
        source="reddit",
        source_id="t3_b",
        kind="post",
        title="Hedgehog ok",
        created_utc=1675209600,  # 2023-02-01
        now=2000,
        metadata={"subreddit": "hh", "tags": ["coding"], "score": 10},
    ))
    db.merge_upsert(conn, models.new_item(
        source="youtube",
        source_id="v1",
        kind="video",
        title="Vid",
        created_utc=1675209600,
        now=3000,
    ))
    conn.commit()
    conn.close()

    cl = create_app(tmp_db).test_client()

    # source: operator
    r = cl.get("/items?q=source:reddit").get_json()
    assert {i["fullname"] for i in r["items"]} == {"reddit:t3_a", "reddit:t3_b"}

    # precedence: operator wins over explicit query param when present
    r = cl.get("/items?source=youtube&q=source:reddit").get_json()
    assert {i["fullname"] for i in r["items"]} == {"reddit:t3_a", "reddit:t3_b"}

    # tags: AND via repetition
    r = cl.get("/items?q=tag:coding%20tag:memes").get_json()
    assert {i["fullname"] for i in r["items"]} == {"reddit:t3_a"}

    # tags: OR via comma
    r = cl.get("/items?q=tag:memes,coding").get_json()
    assert {i["fullname"] for i in r["items"]} == {"reddit:t3_a", "reddit:t3_b"}

    # is:nsfw => membership in nsfw_* tags
    r = cl.get("/items?q=is:nsfw").get_json()
    assert {i["fullname"] for i in r["items"]} == {"reddit:t3_a"}

    # before/after date bounds
    r = cl.get("/items?q=before:2023-01-01").get_json()
    assert {i["fullname"] for i in r["items"]} == {"reddit:t3_a"}

    r = cl.get("/items?q=after:2023-01-01").get_json()
    assert {i["fullname"] for i in r["items"]} == {"reddit:t3_b", "youtube:v1"}

    # score:
    r = cl.get("/items?q=score:>100").get_json()
    assert {i["fullname"] for i in r["items"]} == {"reddit:t3_a"}

    # -negation combines with FTS free-text
    r = cl.get("/items?q=hedgehog%20-removed").get_json()
    assert {i["fullname"] for i in r["items"]} == {"reddit:t3_b"}

    # malformed operators degrade to free text and must not 500
    assert cl.get("/items?q=before:notadate").status_code == 200


# --- malformed numeric params (delegation/05+06) ------------------------------

def test_drain_malformed_max_no_500(tmp_db):
    cl = _client(tmp_db)
    assert cl.post("/reddit/unsave/drain", json={"max": "garbage"}).status_code == 200
    assert cl.post("/reddit/unsave/drain").status_code == 200  # no body at all


def test_sync_malformed_max_pages_no_500(tmp_db):
    assert _client(tmp_db).post("/reddit/sync", json={"max_pages": "garbage"}).status_code == 200


def test_reddit_sync_auto_disabled_by_default(tmp_db):
    """The PWA-open hook no-ops (and never starts a sync) until autosync is opted in."""
    r = _client(tmp_db).post("/reddit/sync/auto").get_json()
    assert r == {"skipped": "disabled"}


def test_reddit_sync_auto_runs_when_enabled(tmp_db):
    """Enabled but with no reddit auth -> the inner sync reports auth_error, not a 500."""
    from content_hoarder import reddit_sync
    _seed(tmp_db)
    c = db.connect(tmp_db)
    reddit_sync.set_autosync_enabled(c, True)
    c.close()
    r = create_app(tmp_db).test_client().post("/reddit/sync/auto").get_json()
    assert r.get("skipped") is None
    assert r["mode"] in ("incremental", "reconcile")
    assert r["result"]["auth_error"] is True
