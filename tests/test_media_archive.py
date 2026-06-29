"""media_archive: download + store media bytes per item, resumable (Epic 4 P1). Offline —
the HTTP fetch/downloader is injected."""

import json
import subprocess

from content_hoarder import config, db, media_archive, media_store, models


def _seed(conn, sid, **md):
    db.merge_upsert(
        conn,
        models.new_item(
            source="reddit", source_id=sid, kind="post", title=sid, metadata=md
        ),
    )


def _seed_source(conn, source, sid, **md):
    db.merge_upsert(
        conn,
        models.new_item(
            source=source, source_id=sid, kind="post", title=sid, metadata=md
        ),
    )


def _item(conn, fullname):
    row = db.get_item(conn, fullname)
    assert row is not None, fullname
    return row


def _md(conn, fullname):
    return json.loads(_item(conn, fullname)["metadata"] or "{}")


def _path_for(blob):
    path = media_store.path_for(blob)
    assert path is not None, blob
    return path


def test_vreddit_url_normalization():
    cases = [
        "https://v.redd.it/abc123",
        "https://v.redd.it/abc123/DASH_720.mp4?source=fallback",
        "https://v.redd.it/abc123/CMAF_1080.mp4?x=1",
        "https://v.redd.it/abc123/HLSPlaylist.m3u8?token=x",
        "https://v.redd.it/abc123/DASHPlaylist.mpd",
    ]
    for url in cases:
        assert media_archive.reddit_video_id(url) == "abc123"
        assert media_archive.canonical_vreddit_url(url) == "https://v.redd.it/abc123"
    assert (
        media_archive.reddit_video_id("https://www.reddit.com/r/x/comments/abc123/t/")
        is None
    )
    assert media_archive.reddit_video_id("https://i.redd.it/abc123.jpg") is None


def test_urls_for_scopes():
    assert media_archive._urls_for({"media_salvage_url": "u"}, "salvageable") == ["u"]
    assert media_archive._urls_for({"gallery_preview": ["a", "b"]}, "galleries") == [
        "a",
        "b",
    ]
    assert media_archive._urls_for(
        {"media_url": "https://i.redd.it/x.jpg"}, "images"
    ) == ["https://i.redd.it/x.jpg"]
    # a known-gone image is not re-fetched
    assert (
        media_archive._urls_for(
            {"media_url": "https://i.redd.it/x.jpg", "media_status": "gone"}, "images"
        )
        == []
    )
    assert media_archive._urls_for(
        {
            "media_urls": [
                "https://pbs.twimg.com/media/a.jpg?name=orig",
                "https://video.twimg.com/ext_tw_video/1/pu/vid/720x720/v.mp4",
                "https://pbs.twimg.com/media/a.jpg?name=orig",
            ]
        },
        "twitter",
    ) == [
        "https://pbs.twimg.com/media/a.jpg?name=orig",
        "https://video.twimg.com/ext_tw_video/1/pu/vid/720x720/v.mp4",
    ]


def test_archive_salvageable_and_galleries(conn, tmp_path, monkeypatch):
    monkeypatch.setattr(
        config, "db_path", lambda: str(tmp_path / "app.db")
    )  # media dir -> tmp/media
    _seed(conn, "salv", media_salvage_url="https://preview.redd.it/s.jpg")
    _seed(
        conn,
        "gal",
        gallery_preview=[
            "https://preview.redd.it/g1.jpg",
            "https://preview.redd.it/g2.jpg",
        ],
    )
    _seed(conn, "plain", media_url="https://i.redd.it/p.jpg")  # not in these scopes
    conn.commit()
    calls = []

    def fake(u, *, max_bytes):
        calls.append(u)
        return (b"BYTES-" + u.encode(), "image/jpeg")

    # dry run: counts the 3 URLs, fetches/writes nothing
    plan = media_archive.archive(
        conn, scopes=["salvageable", "galleries"], apply=False, fetch=fake, throttle=0
    )
    assert plan["urls"] == 3 and plan["archived"] == 0 and calls == []

    # apply: fetches + stores all 3, stamps archived_media
    res = media_archive.archive(
        conn, scopes=["salvageable", "galleries"], apply=True, fetch=fake, throttle=0
    )
    assert res["archived"] == 3 and res["failed"] == 0 and len(calls) == 3
    sm = _md(conn, "reddit:salv")
    blob = sm["archived_media"]["https://preview.redd.it/s.jpg"]
    assert blob.endswith(".jpg")
    assert _path_for(blob).read_bytes() == b"BYTES-https://preview.redd.it/s.jpg"
    assert "archived_media" not in _md(conn, "reddit:plain")

    # resumable: a second run finds nothing left to do
    again = media_archive.archive(
        conn, scopes=["salvageable", "galleries"], apply=True, fetch=fake, throttle=0
    )
    assert again["urls"] == 0 and again["archived"] == 0


def test_archive_failed_fetch_is_counted_not_stamped(conn, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "db_path", lambda: str(tmp_path / "app.db"))
    _seed(conn, "x", media_salvage_url="https://preview.redd.it/dead.jpg")
    conn.commit()
    res = media_archive.archive(
        conn,
        scopes=["salvageable"],
        apply=True,
        throttle=0,
        fetch=lambda u, *, max_bytes: (None, "http_404"),
    )
    assert res["failed"] == 1 and res["archived"] == 0
    assert "archived_media" not in _md(conn, "reddit:x")


def test_archive_item_limit(conn, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "db_path", lambda: str(tmp_path / "app.db"))
    for i in range(5):
        _seed(conn, f"s{i}", media_salvage_url=f"https://preview.redd.it/{i}.jpg")
    conn.commit()
    res = media_archive.archive(
        conn,
        scopes=["salvageable"],
        apply=True,
        limit=2,
        throttle=0,
        fetch=lambda u, *, max_bytes: (b"x", "image/jpeg"),
    )
    assert res["items"] == 2 and res["archived"] == 2


def test_archive_video_dry_run_selects_candidates_and_skips_present_blob(
    conn, tmp_path, monkeypatch
):
    monkeypatch.setattr(config, "db_path", lambda: str(tmp_path / "app.db"))
    present_blob = media_store.store(b"already", mime="video/mp4")
    _seed(
        conn,
        "fallback",
        media_type="reddit_video",
        media_url="https://v.redd.it/abc123/DASH_720.mp4?source=fallback",
    )
    _seed(conn, "bare", media_type="reddit_video", media_url="https://v.redd.it/bareid")
    _seed(
        conn, "loose", media_type="reddit_media", media_url="https://v.redd.it/looseid"
    )
    _seed(
        conn, "text", media_type="link", media_url="https://example.test/not-video.jpg"
    )
    _seed(
        conn,
        "done",
        media_type="reddit_video",
        media_url="https://v.redd.it/doneid/DASH_720.mp4",
        archived_media={"https://v.redd.it/doneid/DASH_720.mp4": present_blob},
    )
    _seed(
        conn,
        "stale",
        media_type="reddit_video",
        media_url="https://v.redd.it/staleid/DASH_720.mp4",
        archived_media={"https://v.redd.it/staleid/DASH_720.mp4": "a" * 64 + ".mp4"},
    )
    conn.commit()
    calls = []

    def fake_downloader(*args, **kwargs):
        calls.append(args)
        raise AssertionError("dry run must not call the downloader")

    plan = media_archive.archive(
        conn,
        scopes=["videos"],
        apply=False,
        video_downloader=fake_downloader,
        throttle=0,
    )
    assert plan["items"] == 4
    assert plan["urls"] == 4
    assert plan["skipped"] == 1
    assert calls == []


def test_archive_video_apply_stamps_compatible_metadata_and_is_idempotent(
    conn, tmp_path, monkeypatch
):
    monkeypatch.setattr(config, "db_path", lambda: str(tmp_path / "app.db"))
    _seed(
        conn,
        "vid",
        media_type="reddit_video",
        media_url="https://v.redd.it/abc123/DASH_720.mp4?source=fallback",
        reddit_video={"has_audio": True, "duration": 12},
    )
    conn.commit()
    calls = []

    def fake_downloader(candidate, temp_dir, *, max_bytes, timeout):
        calls.append(candidate)
        p = tmp_path / "out.mp4"
        p.write_bytes(b"\x00\x00\x00 ftypmp42fake muxed video")
        return p, {
            "mime": "video/mp4",
            "downloader": "fake",
            "container": "mp4",
            "has_audio": True,
        }

    plan = media_archive.archive(
        conn,
        scopes=["videos"],
        apply=False,
        video_downloader=fake_downloader,
        throttle=0,
    )
    assert plan["items"] == 1 and plan["archived"] == 0 and calls == []

    res = media_archive.archive(
        conn,
        scopes=["videos"],
        apply=True,
        video_downloader=fake_downloader,
        throttle=0,
    )
    assert res["items"] == 1 and res["archived"] == 1 and res["failed"] == 0
    md = _md(conn, "reddit:vid")
    arch = md["archived_media"]
    assert set(arch) == {
        "https://v.redd.it/abc123/DASH_720.mp4?source=fallback",
        "https://v.redd.it/abc123",
    }
    blob = arch["https://v.redd.it/abc123"]
    assert blob.endswith(".mp4")
    assert arch["https://v.redd.it/abc123/DASH_720.mp4?source=fallback"] == blob
    assert _path_for(blob).read_bytes().endswith(b"fake muxed video")
    details = md["archived_media_details"]["https://v.redd.it/abc123"]
    assert details["kind"] == "reddit_video"
    assert details["blob"] == blob
    assert details["downloader"] == "fake"
    assert details["has_audio"] is True
    assert details["bytes"] == len(b"\x00\x00\x00 ftypmp42fake muxed video")

    again = media_archive.archive(
        conn,
        scopes=["videos"],
        apply=True,
        video_downloader=fake_downloader,
        throttle=0,
    )
    assert again["items"] == 0 and again["archived"] == 0 and again["skipped"] == 1
    assert len(calls) == 1


def test_default_video_downloader_missing_binary(monkeypatch, tmp_path):
    monkeypatch.setattr(media_archive.shutil, "which", lambda name: None)
    path, info = media_archive.default_video_downloader(
        {"source_url": "https://www.reddit.com/r/x/comments/abc/t/"},
        tmp_path,
    )
    assert path is None and info == "missing_downloader"


def test_default_video_downloader_invokes_ytdlp_and_returns_output(
    monkeypatch, tmp_path
):
    out = tmp_path / "abc.mp4"
    out.write_bytes(b"muxed")
    captured = {}
    monkeypatch.setattr(media_archive.shutil, "which", lambda name: "yt-dlp")

    def fake_run(cmd, *, capture_output, text, timeout, check, env):
        captured["cmd"] = cmd
        captured["timeout"] = timeout
        captured["env"] = env
        return subprocess.CompletedProcess(cmd, 0, stdout=str(out) + "\n", stderr="")

    monkeypatch.setattr(media_archive.subprocess, "run", fake_run)
    path, info = media_archive.default_video_downloader(
        {"source_url": "https://www.reddit.com/r/x/comments/abc/t/"},
        tmp_path,
        max_bytes=10,
        timeout=12,
    )
    assert path == out
    assert isinstance(info, dict)
    assert info["mime"] == "video/mp4"
    assert info["downloader"] == "yt-dlp"
    assert info["has_audio"] is True
    cmd = captured["cmd"]
    assert "--no-playlist" in cmd
    assert cmd[cmd.index("--format") + 1] == "bv*+ba"
    assert cmd[-1] == "https://www.reddit.com/r/x/comments/abc/t/"
    assert captured["timeout"] == 12
    assert captured["env"]["TMP"] == str(tmp_path)
    assert captured["env"]["TEMP"] == str(tmp_path)


def test_default_video_downloader_classifies_timeout(monkeypatch, tmp_path):
    monkeypatch.setattr(media_archive.shutil, "which", lambda name: "yt-dlp")

    def fake_run(cmd, *, capture_output, text, timeout, check, env):
        raise subprocess.TimeoutExpired(cmd, timeout)

    monkeypatch.setattr(media_archive.subprocess, "run", fake_run)
    path, info = media_archive.default_video_downloader({"source_url": "u"}, tmp_path)
    assert path is None and info == "timeout"


def test_default_video_downloader_classifies_mux_failure(monkeypatch, tmp_path):
    monkeypatch.setattr(media_archive.shutil, "which", lambda name: "yt-dlp")

    def fake_run(cmd, *, capture_output, text, timeout, check, env):
        return subprocess.CompletedProcess(
            cmd, 1, stdout="", stderr="ffmpeg merge failed"
        )

    monkeypatch.setattr(media_archive.subprocess, "run", fake_run)
    path, info = media_archive.default_video_downloader({"source_url": "u"}, tmp_path)
    assert path is None and info == "missing_ffmpeg_or_mux_failed"


def test_default_video_downloader_classifies_extractor_error(monkeypatch, tmp_path):
    monkeypatch.setattr(media_archive.shutil, "which", lambda name: "yt-dlp")

    def fake_run(cmd, *, capture_output, text, timeout, check, env):
        return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="reddit says no")

    monkeypatch.setattr(media_archive.subprocess, "run", fake_run)
    path, info = media_archive.default_video_downloader({"source_url": "u"}, tmp_path)
    assert path is None and info == "extractor_error"


def test_default_video_downloader_deletes_too_large_output(monkeypatch, tmp_path):
    out = tmp_path / "too-big.mp4"
    out.write_bytes(b"0123456789")
    monkeypatch.setattr(media_archive.shutil, "which", lambda name: "yt-dlp")

    def fake_run(cmd, *, capture_output, text, timeout, check, env):
        return subprocess.CompletedProcess(cmd, 0, stdout=str(out), stderr="")

    monkeypatch.setattr(media_archive.subprocess, "run", fake_run)
    path, info = media_archive.default_video_downloader(
        {"source_url": "u"}, tmp_path, max_bytes=5
    )
    assert path is None and info == "too_large"
    assert not out.exists()


def test_archive_video_failure_does_not_stamp_metadata(conn, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "db_path", lambda: str(tmp_path / "app.db"))
    _seed(conn, "vid", media_type="reddit_video", media_url="https://v.redd.it/abc123")
    conn.commit()

    def fake_downloader(candidate, temp_dir, *, max_bytes, timeout):
        return None, "missing_downloader"

    res = media_archive.archive(
        conn,
        scopes=["videos"],
        apply=True,
        video_downloader=fake_downloader,
        throttle=0,
    )
    assert res["failed"] == 1 and res["fail_reasons"] == {"missing_downloader": 1}
    assert "archived_media" not in _md(conn, "reddit:vid")


def test_archive_twitter_images(conn, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "db_path", lambda: str(tmp_path / "app.db"))
    img = "https://pbs.twimg.com/media/abc123.jpg?name=orig"
    vid = "https://video.twimg.com/ext_tw_video/1/pu/vid/720x720/v.mp4"
    _seed_source(
        conn,
        "twitter",
        "tw1",
        media_urls=[
            img,
            vid,
        ],
    )
    _seed(conn, "reddit", media_url="https://i.redd.it/x.jpg")
    conn.commit()
    calls = []

    def fake(u, *, max_bytes):
        calls.append(u)
        mime = "video/mp4" if u.endswith(".mp4") else "image/jpeg"
        return (b"TW-" + u.encode(), mime)

    plan = media_archive.archive(
        conn, scopes=["twitter"], apply=False, fetch=fake, throttle=0
    )
    assert plan["items"] == 1 and plan["urls"] == 2 and plan["archived"] == 0
    assert calls == []

    res = media_archive.archive(
        conn, scopes=["twitter"], apply=True, fetch=fake, throttle=0
    )
    assert res["items"] == 1 and res["archived"] == 2 and res["failed"] == 0
    assert calls == [img, vid]
    md = _md(conn, "twitter:tw1")
    blob = md["archived_media"][img]
    assert blob.endswith(".jpg")
    assert _path_for(blob).read_bytes() == b"TW-" + img.encode()
    vblob = md["archived_media"][vid]
    assert vblob.endswith(".mp4")
    assert _path_for(vblob).read_bytes() == b"TW-" + vid.encode()

    again = media_archive.archive(
        conn, scopes=["twitter"], apply=True, fetch=fake, throttle=0
    )
    assert again["urls"] == 0 and again["archived"] == 0
