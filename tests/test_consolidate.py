import json

from content_hoarder import consolidate, db, models


def _seed(conn, items):
    for kw in items:
        db.merge_upsert(conn, models.new_item(**kw))
    conn.commit()


def _youtube(vid: str, **md):
    return dict(
        source="youtube",
        source_id=vid,
        kind="video",
        title=f"YT {vid}",
        url=f"https://youtu.be/{vid}",
        metadata=md,
    )


def _reddit(fullname_id: str, url: str, *, permalink: str = "", **md):
    meta = dict(md)
    if permalink:
        meta["permalink"] = permalink
    return dict(
        source="reddit",
        source_id=fullname_id,
        kind="post",
        title="Reddit post",
        url=url,
        metadata=meta,
    )


def test_reddit_link_to_existing_youtube_folds(tmp_db):
    vid = "Vfold000001"  # 11 chars
    conn = db.connect(tmp_db)
    _seed(
        conn,
        [
            _youtube(vid),
            _reddit(
                "t3_abc",
                f"https://www.youtube.com/watch?v={vid}&t=10",
                permalink="https://www.reddit.com/r/test/comments/abc/x/",
                subreddit="test",
            ),
        ],
    )

    res = consolidate.migrate(conn, apply=True)
    assert res["foldable"] == 1 and res["promoted"] == 0 and res["youtube_created"] == 0

    yt = db.get_item(conn, f"youtube:{vid}")
    yt_md = json.loads(yt["metadata"])
    assert yt_md["companions"] == [
        {
            "source": "reddit",
            "kind": "post",
            "permalink": "https://www.reddit.com/r/test/comments/abc/x/",
            "fullname": "reddit:t3_abc",
        }
    ]

    rd = db.get_item(conn, "reddit:t3_abc")
    rd_md = json.loads(rd["metadata"])
    assert rd_md["consolidated_into"] == f"youtube:{vid}"
    assert rd_md["subreddit"] == "test"  # non-destructive: unrelated metadata preserved


def test_reddit_link_to_no_youtube_promotes(tmp_db):
    """A link to a not-yet-saved video promotes a real youtube item and folds the post in."""
    vid = "Skp00000001"  # 11 chars
    conn = db.connect(tmp_db)
    _seed(
        conn,
        [
            _reddit(
                "t3_nope",
                f"https://youtu.be/{vid}",
                permalink="https://www.reddit.com/r/test/comments/nope/x/",
            )
        ],
    )

    res = consolidate.migrate(conn, apply=True)
    assert res["foldable"] == 0 and res["promoted"] == 1 and res["youtube_created"] == 1

    # A canonical youtube row now exists, built keylessly from the id.
    yt = db.get_item(conn, f"youtube:{vid}")
    assert yt is not None and yt["source"] == "youtube" and yt["kind"] == "video"
    assert yt["url"] == f"https://youtu.be/{vid}"
    yt_md = json.loads(yt["metadata"])
    assert yt_md["thumbnail"] == f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
    assert yt_md["promoted_by"] == "consolidate"
    assert yt_md["title_source"] == "companion"
    # The post is folded into it as a companion (discussion chip), not the raw video link.
    assert yt_md["companions"] == [
        {
            "source": "reddit",
            "kind": "post",
            "permalink": "https://www.reddit.com/r/test/comments/nope/x/",
            "fullname": "reddit:t3_nope",
        }
    ]
    rd = db.get_item(conn, "reddit:t3_nope")
    assert json.loads(rd["metadata"])["consolidated_into"] == f"youtube:{vid}"


def test_promote_preserves_archived_status(tmp_db):
    """A promoted video inherits the companion's triage status + processed time."""
    vid = "Arch000001x"  # 11 chars
    conn = db.connect(tmp_db)
    _seed(conn, [dict(
        source="reddit", source_id="t3_arch", kind="post", title="Reddit post",
        url=f"https://youtu.be/{vid}", status="archived", metadata={},
    )])
    conn.execute("UPDATE items SET processed_utc=? WHERE fullname=?", (12345, "reddit:t3_arch"))
    conn.commit()

    consolidate.migrate(conn, apply=True)

    yt = db.get_item(conn, f"youtube:{vid}")
    assert yt["status"] == "archived"  # don't resurrect a processed post into the inbox
    assert yt["processed_utc"] == 12345


def test_promote_strips_hn_video_marker_for_provisional_title(tmp_db):
    """The HN ``[video]`` submission marker is stripped from the provisional title."""
    vid = "Hnvid00001x"  # 11 chars
    conn = db.connect(tmp_db)
    _seed(
        conn,
        [
            dict(
                source="hackernews",
                source_id="999",
                kind="story",
                title="Antikythera Mechanism: an ancient computer [video] (2021)",
                url=f"https://www.youtube.com/watch?v={vid}",
                metadata={},
            )
        ],
    )

    consolidate.migrate(conn, apply=True)

    yt = db.get_item(conn, f"youtube:{vid}")
    assert yt["title"] == "Antikythera Mechanism: an ancient computer (2021)"


def test_two_posts_same_new_video_share_one_promoted_row(tmp_db):
    """Two posts on the same not-yet-saved video create one row with two companions."""
    vid = "Share00001x"  # 11 chars
    conn = db.connect(tmp_db)
    _seed(
        conn,
        [
            _reddit("t3_a", f"https://youtu.be/{vid}", permalink="https://www.reddit.com/r/x/comments/a/y/"),
            _reddit("t3_b", f"https://www.youtube.com/watch?v={vid}", permalink="https://www.reddit.com/r/x/comments/b/z/"),
        ],
    )

    res = consolidate.migrate(conn, apply=True)
    assert res["promoted"] == 2 and res["youtube_created"] == 1

    yt = db.get_item(conn, f"youtube:{vid}")
    fns = {c["fullname"] for c in json.loads(yt["metadata"])["companions"]}
    assert fns == {"reddit:t3_a", "reddit:t3_b"}


def test_undo_deletes_promoted_row(tmp_db):
    """Undo removes a promoted youtube row wholesale and unmarks its companion."""
    vid = "UndoP0001xy"  # 11 chars
    conn = db.connect(tmp_db)
    _seed(conn, [_reddit("t3_up", f"https://youtu.be/{vid}")])

    consolidate.migrate(conn, apply=True)
    assert db.get_item(conn, f"youtube:{vid}") is not None  # created

    res = consolidate.unconsolidate(conn, apply=True)
    assert res["promoted_rows_deleted"] == 1
    assert db.get_item(conn, f"youtube:{vid}") is None  # round-trips away
    rd = db.get_item(conn, "reddit:t3_up")
    assert "consolidated_into" not in json.loads(rd["metadata"])


def test_idempotency_running_twice_does_not_double_companions(tmp_db):
    vid = "Idem0000001"  # 11 chars
    conn = db.connect(tmp_db)
    _seed(
        conn,
        [
            _youtube(vid),
            _reddit("t3_dup", f"https://youtu.be/{vid}"),
        ],
    )

    consolidate.migrate(conn, apply=True)
    consolidate.migrate(conn, apply=True)

    yt = db.get_item(conn, f"youtube:{vid}")
    yt_md = json.loads(yt["metadata"])
    assert len(yt_md.get("companions") or []) == 1
    assert yt_md["companions"][0]["fullname"] == "reddit:t3_dup"


def test_undo_round_trip(tmp_db):
    vid = "Undo0000001"  # 11 chars
    conn = db.connect(tmp_db)
    _seed(
        conn,
        [
            _youtube(vid, playlist="WL"),
            _reddit("t3_u", f"https://www.youtube.com/watch?v={vid}"),
        ],
    )

    consolidate.migrate(conn, apply=True)
    consolidate.unconsolidate(conn, apply=True)

    yt = db.get_item(conn, f"youtube:{vid}")
    yt_md = json.loads(yt["metadata"])
    assert "companions" not in yt_md
    assert yt_md["playlist"] == "WL"  # non-destructive: unrelated metadata preserved

    rd = db.get_item(conn, "reddit:t3_u")
    rd_md = json.loads(rd["metadata"])
    assert "consolidated_into" not in rd_md


def test_hackernews_companion_links_to_thread(tmp_db):
    """An HN companion links to the HN discussion thread, not the matched video URL."""
    vid = "Hn000000001"  # 11 chars
    conn = db.connect(tmp_db)
    _seed(
        conn,
        [
            _youtube(vid),
            dict(
                source="hackernews",
                source_id="28608860",
                kind="story",
                title="HN story",
                url=f"https://www.youtube.com/watch?v={vid}",
                metadata={},
            ),
        ],
    )

    consolidate.migrate(conn, apply=True)

    yt = db.get_item(conn, f"youtube:{vid}")
    yt_md = json.loads(yt["metadata"])
    comp = yt_md["companions"][0]
    assert comp["fullname"] == "hackernews:28608860"
    assert comp["url"] == "https://news.ycombinator.com/item?id=28608860"
    assert "permalink" not in comp


def test_url_fallback_for_other_companion(tmp_db):
    """A non-reddit, non-HN companion with no permalink falls back to its URL."""
    vid = "Url00000001"  # 11 chars
    conn = db.connect(tmp_db)
    _seed(
        conn,
        [
            _youtube(vid),
            dict(
                source="obsidian",
                source_id="note-1",
                kind="note",
                title="A note",
                url=f"https://www.youtube.com/watch?v={vid}",
                metadata={},
            ),
        ],
    )

    consolidate.migrate(conn, apply=True)

    yt = db.get_item(conn, f"youtube:{vid}")
    yt_md = json.loads(yt["metadata"])
    comp = yt_md["companions"][0]
    assert comp["fullname"] == "obsidian:note-1"
    assert comp["url"] == f"https://www.youtube.com/watch?v={vid}"
    assert "permalink" not in comp


def test_plan_skips_already_folded_row(tmp_db):
    """plan() does not re-count a row already consolidated into its target."""
    vid = "Plan0000001"  # 11 chars
    conn = db.connect(tmp_db)
    _seed(
        conn,
        [
            _youtube(vid),
            _reddit("t3_p", f"https://youtu.be/{vid}"),
        ],
    )

    consolidate.migrate(conn, apply=True)

    assert consolidate.plan(conn)["foldable"] == []
    assert consolidate.migrate(conn, apply=False)["foldable"] == 0


def test_search_items_hides_consolidated_companions(tmp_db):
    """search_items excludes consolidated companions by default, shows them on request."""
    vid = "Srch0000001"  # 11 chars
    conn = db.connect(tmp_db)
    _seed(
        conn,
        [
            _youtube(vid),
            _reddit("t3_s", f"https://youtu.be/{vid}"),
        ],
    )

    consolidate.migrate(conn, apply=True)

    fns = {r["fullname"] for r in db.search_items(conn)}
    assert "reddit:t3_s" not in fns
    assert f"youtube:{vid}" in fns

    fns2 = {r["fullname"] for r in db.search_items(conn, include_consolidated=True)}
    assert "reddit:t3_s" in fns2
