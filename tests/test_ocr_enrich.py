"""Spec 14 — OCR enrich pass (write path). Offline; engine is injected."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from content_hoarder import db, media_store, models, ocr

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "ocr" / "hello.png"


def _connect(tmp_path, monkeypatch, name="ocr.db"):
    db_path = tmp_path / name
    monkeypatch.setenv("CONTENT_HOARDER_DB", str(db_path))
    c = db.connect(str(db_path))
    db.init_db(c)
    return c


def _fake_engine(path, *, lang="eng", min_confidence=40.0):
    return {
        "text": "CONTENTHOARDER",
        "mean_confidence": 90.0,
        "engine": "fake",
        "engine_version": "0",
    }


def _fake_empty(path, *, lang="eng", min_confidence=40.0):
    return {
        "text": "",
        "mean_confidence": 10.0,
        "engine": "fake",
        "engine_version": "0",
        "skip_reason": "low_confidence",
    }


def _seed(conn, tmp_path, source_id="ocrtest1"):
    media_store.media_dir().mkdir(parents=True, exist_ok=True)
    src = FIXTURE if FIXTURE.exists() else tmp_path / "hello.png"
    if not src.exists():
        from PIL import Image

        Image.new("RGB", (200, 80), (255, 255, 255)).save(src)
    blob = media_store.store_path(
        src, mime="image/png", url="https://i.redd.it/x.png"
    )
    item = models.new_item(
        source="reddit",
        source_id=source_id,
        kind="post",
        title="ocr seed",
        url="https://www.reddit.com/r/test/comments/%s/x/" % source_id,
        metadata={
            "media_type": "image",
            "media_url": "https://i.redd.it/x.png",
            "permalink": "/r/test/comments/%s/x/" % source_id,
            "archived_media": {"https://i.redd.it/x.png": blob},
        },
    )
    db.merge_upsert(conn, item)
    conn.commit()
    return item["fullname"], blob


def test_local_image_blobs_finds_archived_png(tmp_path, monkeypatch):
    c = _connect(tmp_path, monkeypatch)
    fn, blob = _seed(c, tmp_path)
    md = json.loads(
        c.execute("SELECT metadata FROM items WHERE fullname=?", (fn,)).fetchone()[0]
    )
    blobs = ocr.local_image_blobs(md)
    assert blobs and blobs[0][1] == blob
    c.close()


def test_ocr_item_apply_writes_ocr_text_and_search(tmp_path, monkeypatch):
    c = _connect(tmp_path, monkeypatch, "ocr2.db")
    fn, _blob = _seed(c, tmp_path)
    res = ocr.ocr_item(c, fn, apply=True, engine=_fake_engine)
    assert res["status"] == "ok"
    assert res["chars"] > 0
    row = dict(c.execute("SELECT * FROM items WHERE fullname=?", (fn,)).fetchone())
    md = json.loads(row["metadata"])
    assert md.get("ocr_text") == "CONTENTHOARDER"
    assert md.get("ocr_at")
    assert "CONTENTHOARDER" in (row["search_text"] or "")
    hits = db.search_items(c, "CONTENTHOARDER")
    assert any(h["fullname"] == fn for h in hits)
    c.close()


def test_ocr_item_dry_run_does_not_write(tmp_path, monkeypatch):
    c = _connect(tmp_path, monkeypatch, "ocr3.db")
    fn, _ = _seed(c, tmp_path)
    res = ocr.ocr_item(c, fn, apply=False, engine=_fake_engine)
    assert res["status"] == "would_ocr"
    md = json.loads(
        c.execute("SELECT metadata FROM items WHERE fullname=?", (fn,)).fetchone()[0]
    )
    assert "ocr_text" not in md
    c.close()


def test_ocr_skip_if_present_unless_force(tmp_path, monkeypatch):
    c = _connect(tmp_path, monkeypatch, "ocr4.db")
    fn, _ = _seed(c, tmp_path)
    assert ocr.ocr_item(c, fn, apply=True, engine=_fake_engine)["status"] == "ok"
    assert ocr.ocr_item(c, fn, apply=True, engine=_fake_engine)["status"] == "skipped"
    assert (
        ocr.ocr_item(c, fn, apply=True, force=True, engine=_fake_engine)["status"]
        == "ok"
    )
    c.close()


def test_ocr_empty_does_not_set_truthy_ocr_text(tmp_path, monkeypatch):
    c = _connect(tmp_path, monkeypatch, "ocr5.db")
    fn, _ = _seed(c, tmp_path)
    res = ocr.ocr_item(c, fn, apply=True, engine=_fake_empty)
    assert res["status"] == "empty"
    md = json.loads(
        c.execute("SELECT metadata FROM items WHERE fullname=?", (fn,)).fetchone()[0]
    )
    assert not md.get("ocr_text")
    assert md.get("ocr_empty") is True
    assert md.get("ocr_at")
    c.close()


def test_ocr_all_limit(tmp_path, monkeypatch):
    c = _connect(tmp_path, monkeypatch, "ocr6.db")
    for i in range(3):
        _seed(c, tmp_path, source_id=f"ocrlim{i}")
    res = ocr.ocr_all(c, limit=2, apply=True, engine=_fake_engine)
    assert res["items"] == 2
    assert res["ocr_ok"] == 2
    c.close()
