"""Offline tests for archive.today media-byte recovery (Epic 4 P2).

``ArchiveTodayProvider`` is URL-keyed + HTML + recovers media BYTES (not metadata) —
it runs as a post-chain step in ``recover_one()`` only when ``media_status='gone'``
after PullPush/Arctic. All transport (``fetch_html=``) and byte-fetching (``fetch_bytes=``)
is injected — no network.
"""
import json

from content_hoarder import db, media_store, models
from content_hoarder.archival import service as archival
from content_hoarder.archival._http import ArchiveError
from content_hoarder.archival.providers import ArchiveTodayProvider

UA = "ua"


def _seed_gone(conn):
    db.merge_upsert(conn, models.new_item(
        source="reddit", source_id="t3_gone", kind="post",
        title="Some title", body="text",
        metadata={"permalink": "/r/x/comments/gone/t/",
                  "media_url": "https://i.redd.it/dead.jpg",
                  "media_status": "gone"}))
    conn.commit()


def _snapshot_html(img_url, title="Archived Page"):
    return (f'<html><head><meta property="og:image" content="{img_url}">'
            f'<meta property="og:title" content="{title}"></head>'
            f'<body><img src="{img_url}"></body></html>')


def _fake_fetch_bytes(url, *, max_bytes=15728640):
    """The media_archive byte-fetcher shape: (bytes, mime) or (None, reason)."""
    return (b"\x89PNG\r\n\x1a\nFAKEIMAGEBYTES", "image/png")


# ---------------- Task 2: explicit archive.today integration ----------------

def test_recover_one_default_does_not_archive_media(tmp_db):
    conn = db.connect(tmp_db)
    _seed_gone(conn)

    res = archival.recover_one(conn, "reddit:t3_gone", providers=[])
    assert res["bytes_archived"] == 0
    assert "archive_today" not in res
    md = json.loads(db.get_item(conn, "reddit:t3_gone")["metadata"])
    assert md.get("archived_media") in (None, {})
    assert md["media_status"] == "gone"


def test_recover_one_archives_bytes_when_media_gone_explicit(tmp_db):
    conn = db.connect(tmp_db)
    _seed_gone(conn)

    at = ArchiveTodayProvider(
        UA, min_interval=0.0,
        fetch_html=lambda url, **kw: _snapshot_html("https://archive.ph/img/abc.jpg"))

    res = archival.recover_one(
        conn, "reddit:t3_gone",
        media_providers=[at], fetch_bytes=_fake_fetch_bytes, apply_bytes=True)
    assert res["bytes_archived"] >= 1

    md = json.loads(db.get_item(conn, "reddit:t3_gone")["metadata"])
    assert md["media_status"] == "recovered_archive_today"
    assert md["archived_media"]  # {original_or_snapshot_url: blob_id}

    for blob in md["archived_media"].values():
        assert media_store.path_for(blob) is not None  # on disk + servable


def test_recover_one_skips_archive_today_when_media_live(tmp_db):
    """If media_status is NOT 'gone', archive.today must NOT be consulted."""
    conn = db.connect(tmp_db)
    db.merge_upsert(conn, models.new_item(
        source="reddit", source_id="t3_live", kind="post",
        title="T", body="b",
        metadata={"media_url": "https://i.redd.it/live.jpg", "media_status": "ok"}))
    conn.commit()

    called = {"n": 0}

    class Boom(ArchiveTodayProvider):
        def recover_media(self, *a, **k):
            called["n"] += 1
            return []

    res = archival.recover_one(conn, "reddit:t3_live", media_providers=[Boom(UA)],
                               fetch_bytes=lambda *a, **k: (None, ""), apply_bytes=True)
    assert called["n"] == 0  # never consulted — media wasn't gone
    assert res.get("bytes_archived", 0) == 0


def test_recover_one_dry_run_counts_without_writing(tmp_db):
    conn = db.connect(tmp_db)
    _seed_gone(conn)
    at = ArchiveTodayProvider(
        UA, min_interval=0.0,
        fetch_html=lambda *a, **k: _snapshot_html("https://archive.ph/img/x.jpg"))

    res = archival.recover_one(conn, "reddit:t3_gone", media_providers=[at],
                               fetch_bytes=lambda *a, **k: (b"x", "image/png"),
                               apply_bytes=False)
    assert res["bytes_archived"] >= 1
    md = json.loads(db.get_item(conn, "reddit:t3_gone")["metadata"])
    assert md.get("archived_media") in (None, {})      # nothing written
    assert md["media_status"] == "gone"                # unchanged


# ---------------- Task 3: provider unit + failure paths ----------------

def test_provider_no_media_url_returns_empty():
    p = ArchiveTodayProvider(UA, fetch_html=lambda *a, **k: "")
    assert p.recover_media({"metadata": {"media_status": "gone"}}) == []


def test_provider_extracts_og_image_and_inline_imgs():
    html = ('<meta property="og:image" content="https://archive.ph/a.jpg">'
            '<img src="https://i.redd.it/orig.jpg">')
    p = ArchiveTodayProvider(UA, fetch_html=lambda *a, **k: html)
    res = p.recover_media({"metadata": {
        "media_url": "https://i.redd.it/orig.jpg", "media_status": "gone"}})
    urls = [c["url"] for c in res]
    assert "https://archive.ph/a.jpg" in urls
    assert "https://i.redd.it/orig.jpg" in urls


def test_provider_cloudflare_403_skips_silently():
    def boom(url, **kw):
        raise ArchiveError("HTTP 403 (Cloudflare)", status=403)
    p = ArchiveTodayProvider(UA, fetch_html=boom)
    res = p.recover_media({"metadata": {
        "media_url": "https://i.redd.it/x.jpg", "media_status": "gone"}})
    assert res == []  # loud-fail tolerant: a blocked snapshot is a soft miss


def test_provider_gallery_looks_up_each_frame():
    seen = []

    def fake(url, **kw):
        # the snapshot_url is archive.ph/newest/<quoted orig>; unquote to read it
        import urllib.parse
        inner = urllib.parse.unquote(url.split("/newest/")[-1])
        seen.append(inner)
        return f'<img src="{inner}">'  # echo the original back as a candidate

    p = ArchiveTodayProvider(UA, min_interval=0.0, fetch_html=fake)
    res = p.recover_media({"metadata": {
        "media_url": "https://i.redd.it/main.jpg", "media_status": "gone",
        "gallery": ["https://i.redd.it/g1.jpg", "https://i.redd.it/g2.jpg"]}})
    assert any("main.jpg" in s for s in seen)
    assert any("g1.jpg" in s for s in seen)
    assert any("g2.jpg" in s for s in seen)
    assert len(res) >= 3  # all three frames resolved a candidate
