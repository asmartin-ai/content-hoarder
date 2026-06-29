"""media_store: content-addressed on-disk blob store (Epic 4 P1)."""

from content_hoarder import media_store


def test_store_is_content_addressed_and_idempotent(tmp_path):
    d = tmp_path / "media"
    b = b"\x89PNG fake image bytes"
    id1 = media_store.store(b, mime="image/png", base_dir=d)
    assert id1.endswith(".png") and len(id1.split(".")[0]) == 64
    f = d / id1
    assert f.exists() and f.read_bytes() == b
    mtime = f.stat().st_mtime_ns
    # same bytes -> same id, file NOT rewritten (dedup)
    assert media_store.store(b, mime="image/png", base_dir=d) == id1
    assert f.stat().st_mtime_ns == mtime
    # different bytes -> different id
    assert media_store.store(b + b"x", mime="image/png", base_dir=d) != id1


def test_store_path_streams_video_and_dedups(tmp_path):
    d = tmp_path / "media"
    src = tmp_path / "fixture.mp4"
    data = b"\x00\x00\x00 ftypmp42" + (b"x" * 4096)
    src.write_bytes(data)

    blob = media_store.store_path(src, mime="video/mp4", base_dir=d, chunk_size=1024)
    assert blob.endswith(".mp4") and len(blob.split(".")[0]) == 64
    stored = media_store.path_for(blob, base_dir=d)
    assert stored is not None and stored.read_bytes() == data
    mtime = stored.stat().st_mtime_ns

    assert (
        media_store.store_path(src, mime="video/mp4", base_dir=d, chunk_size=512)
        == blob
    )
    assert stored.stat().st_mtime_ns == mtime


def test_store_path_extension_can_come_from_source_url(tmp_path):
    d = tmp_path / "media"
    src = tmp_path / "downloaded"
    src.write_bytes(b"webm-ish")
    blob = media_store.store_path(
        src, url="https://example.test/video.webm?x=1", base_dir=d
    )
    assert blob.endswith(".webm")


def test_ext_and_mime():
    assert media_store.ext_for("image/jpeg") == ".jpg"
    assert media_store.ext_for("image/webp; charset=binary") == ".webp"
    assert media_store.ext_for("", "https://i.redd.it/x.webp") == ".webp"
    assert media_store.ext_for("video/mp4") == ".mp4"
    assert media_store.ext_for("", "https://video.twimg.com/x/v.webm?tag=1") == ".webm"
    assert media_store.ext_for("", "") == ".bin"
    assert media_store.mime_for("abc.png") == "image/png"
    assert media_store.mime_for("abc.mp4") == "video/mp4"
    assert media_store.mime_for("abc.bin") == "application/octet-stream"


def test_id_validation_blocks_traversal(tmp_path):
    h = "a" * 64
    assert media_store.is_valid_id(h + ".jpg") and media_store.is_valid_id(h + ".mp4")
    assert media_store.is_valid_id(h)
    for bad in ("../etc/passwd", h + ".exe", "nothex.jpg", "", h + "/x"):
        assert not media_store.is_valid_id(bad)


def test_path_for_resolves_and_rejects(tmp_path):
    d = tmp_path / "media"
    d.mkdir()
    h = "b" * 64
    assert media_store.path_for("../x", base_dir=d) is None
    assert media_store.path_for(h, base_dir=d) is None  # not stored yet
    (d / (h + ".jpg")).write_bytes(b"x")
    assert media_store.path_for(h + ".jpg", base_dir=d).name == h + ".jpg"
    assert (
        media_store.path_for(h, base_dir=d).name == h + ".jpg"
    )  # bare hash finds the ext
    (d / (h + ".jpg")).unlink()
    (d / (h + ".mp4")).write_bytes(b"v")
    assert media_store.path_for(h, base_dir=d).name == h + ".mp4"
