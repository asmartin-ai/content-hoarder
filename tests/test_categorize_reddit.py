from content_hoarder import categorize, db, models


def _item(sub="", title="", body="", over_18=0):
    return {"metadata": {"subreddit": sub, "over_18": over_18}, "title": title, "body": body}


def test_subreddit_map_single_and_multilabel():
    assert categorize.reddit_tags(_item(sub="feedthebeast")) == ["minecraft"]
    assert categorize.reddit_tags(_item(sub="feedthememes")) == ["minecraft", "memes"]
    assert categorize.reddit_tags(_item(sub="ProgrammerHumor")) == ["coding", "memes"]
    assert categorize.reddit_tags(_item(sub="NonCredibleDefense")) == ["defense", "memes"]
    assert categorize.reddit_tags(_item(sub="greentext")) == ["memes"]
    assert categorize.reddit_tags(_item(sub="space")) == ["science"]
    assert categorize.reddit_tags(_item(sub="LifeProTips")) == ["tips"]


def test_nsfw_erotic_talk_other_and_sfw_exclusions():
    rt = categorize.reddit_tags
    # explicit erotic allowlist (subreddit-driven, no over_18 needed)
    assert rt(_item(sub="cosplaygirls")) == ["nsfw_erotic"]
    assert rt(_item(sub="TooCuteForPorn")) == ["nsfw_erotic"]      # erotic despite the name
    assert rt(_item(sub="wholesomehentai")) == ["nsfw_erotic"]
    # long-tail erotic token catch
    assert rt(_item(sub="SomeRandomGoneWild")) == ["nsfw_erotic"]
    # nsfw_talk (discussion)
    assert rt(_item(sub="sex")) == ["nsfw_talk"]
    assert rt(_item(sub="RoleReversal")) == ["nsfw_talk"]
    # SFW "*Porn" aesthetic / pun / news subs are never NSFW; topic tag preserved
    assert rt(_item(sub="EarthPorn")) == []
    assert rt(_item(sub="MilitaryPorn")) == ["defense"]
    assert "nsfw_erotic" not in rt(_item(sub="anime_titties"))     # world-news sub, not erotic
    assert "nsfw_erotic" not in rt(_item(sub="planesgonewild"))    # aviation pun
    # over_18 residual -> nsfw_other (non-erotic flagged), combined with topic tags
    assert rt(_item(sub="NonCredibleDefense", over_18=1)) == ["nsfw_other", "defense", "memes"]
    assert "nsfw_other" not in rt(_item(sub="NonCredibleDefense"))  # not flagged -> no nsfw


def test_keyword_fallback_only_when_no_topic():
    # unmapped subreddit, but the title carries a topic keyword
    assert categorize.reddit_tags(_item(sub="randomsub", title="my new Minecraft base")) == ["minecraft"]
    # mapped subreddit already gave a topic -> keyword fallback does NOT add more
    assert categorize.reddit_tags(_item(sub="space", title="a minecraft mod")) == ["science"]
    # nothing matches -> untagged
    assert categorize.reddit_tags(_item(sub="AskReddit", title="what's your favorite color?")) == []


def test_tag_filter_and_counts(conn):
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_x", kind="post",
                    title="x", metadata={"subreddit": "feedthememes", "tags": ["minecraft", "memes"]}))
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_y", kind="post",
                    title="y", metadata={"subreddit": "anime", "tags": ["anime", "memes"]}))
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_z", kind="post",
                    title="z", metadata={"subreddit": "askreddit"}))  # untagged
    conn.commit()
    # tags= matches any element of the metadata.tags list (OR across the selected tags)
    assert {r["fullname"] for r in db.search_items(conn, source="reddit", tags=["minecraft"])} == {"reddit:t3_x"}
    assert {r["fullname"] for r in db.search_items(conn, source="reddit", tags=["memes"])} == \
        {"reddit:t3_x", "reddit:t3_y"}
    # multiple tags -> union
    assert {r["fullname"] for r in db.search_items(conn, source="reddit", tags=["minecraft", "anime"])} == \
        {"reddit:t3_x", "reddit:t3_y"}
    counts = db.tag_counts(conn)
    assert counts["memes"] == 2 and counts["minecraft"] == 1 and counts["anime"] == 1
    assert "askreddit" not in counts  # untagged item contributes nothing


def test_tag_reddit_source_dry_run_then_write(conn):
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_a", kind="post",
                    title="modpack help", metadata={"subreddit": "feedthebeast"}))
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_b", kind="post",
                    title="lol", metadata={"subreddit": "ProgrammerHumor"}))
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_c", kind="post",
                    title="opinion?", metadata={"subreddit": "AskReddit"}))  # untagged
    conn.commit()

    dry = categorize.tag_reddit_source(conn, dry_run=True)
    assert dry["dry_run"] is True and dry["selected"] == 3
    assert dry["by_tag"]["minecraft"] == 1 and dry["by_tag"]["memes"] == 1 and dry["by_tag"]["coding"] == 1
    assert dry["untagged"] == 1
    # dry run must NOT write
    assert "tags" not in (db.get_item(conn, "reddit:t3_a")["metadata"] or "")

    wrote = categorize.tag_reddit_source(conn, dry_run=False)
    assert wrote["tagged"] == 2 and wrote["untagged"] == 1
    import json
    md_a = json.loads(db.get_item(conn, "reddit:t3_a")["metadata"])
    assert md_a["tags"] == ["minecraft"]
