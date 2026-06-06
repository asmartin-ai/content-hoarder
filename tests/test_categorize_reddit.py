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


def test_nsfw_erotic_vs_other():
    # over_18 + an erotic sub -> nsfw_erotic; over_18 elsewhere -> nsfw_other (+ topic tags).
    assert categorize.reddit_tags(_item(sub="gonewild", over_18=1)) == ["nsfw_erotic"]
    assert categorize.reddit_tags(_item(sub="NonCredibleDefense", over_18=1)) == \
        ["nsfw_other", "defense", "memes"]
    # not flagged 18+ -> no nsfw tag at all
    assert "nsfw_other" not in categorize.reddit_tags(_item(sub="NonCredibleDefense"))


def test_keyword_fallback_only_when_no_topic():
    # unmapped subreddit, but the title carries a topic keyword
    assert categorize.reddit_tags(_item(sub="randomsub", title="my new Minecraft base")) == ["minecraft"]
    # mapped subreddit already gave a topic -> keyword fallback does NOT add more
    assert categorize.reddit_tags(_item(sub="space", title="a minecraft mod")) == ["science"]
    # nothing matches -> untagged
    assert categorize.reddit_tags(_item(sub="AskReddit", title="what's your favorite color?")) == []


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
