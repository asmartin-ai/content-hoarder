import json

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


def test_nsfw_tags_from_external_rules(tmp_path, monkeypatch):
    # Rules load from a gitignored JSON; use synthetic names so no real NSFW data lives in tests.
    rules = {
        "talk_subs": ["talky"],
        "erotic_subs": ["allowsub", "tricky_named_sub"],
        "sfw_exclude": ["safe_xtoken_sub"],
        "erotic_keywords": ["xtoken"],
    }
    p = tmp_path / "nsfw.json"
    p.write_text(json.dumps(rules), encoding="utf-8")
    monkeypatch.setenv("CONTENT_HOARDER_NSFW_RULES", str(p))
    rt = categorize.reddit_tags
    assert rt(_item(sub="allowsub")) == ["nsfw_erotic"]            # explicit erotic allowlist
    assert rt(_item(sub="tricky_named_sub")) == ["nsfw_erotic"]
    assert rt(_item(sub="talky")) == ["nsfw_talk"]                 # discussion allowlist
    assert rt(_item(sub="some_xtoken_sub")) == ["nsfw_erotic"]     # keyword long-tail (substring)
    assert rt(_item(sub="safe_xtoken_sub")) == []                  # sfw_exclude wins over keyword
    # over_18 residual -> nsfw_other, combined with real topic tags
    assert rt(_item(sub="NonCredibleDefense", over_18=1)) == ["nsfw_other", "defense", "memes"]
    assert "nsfw_other" not in rt(_item(sub="NonCredibleDefense"))  # not flagged -> no nsfw
    assert rt(_item(sub="plainsub")) == []                         # unknown -> no nsfw tag


def test_nsfw_disabled_without_rules_file(tmp_path, monkeypatch):
    # No rules file -> erotic/talk classification is silently off (graceful for a fresh clone);
    # the over_18 residual is built-in (not rules-driven), so it still applies.
    monkeypatch.setenv("CONTENT_HOARDER_NSFW_RULES", str(tmp_path / "missing.json"))
    assert categorize.reddit_tags(_item(sub="anything")) == []
    assert categorize.reddit_tags(_item(sub="anything", over_18=1)) == ["nsfw_other"]


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


# --- Epic 21: gaming / esports / ephemeral buckets ---------------------------------


def test_gaming_and_esports_bucket_mapping():
    rt = categorize.reddit_tags
    assert rt(_item(sub="leagueoflegends")) == ["esports"]
    assert rt(_item(sub="Overwatch")) == ["esports"]
    assert rt(_item(sub="shittyrainbow6")) == ["esports", "memes"]
    assert rt(_item(sub="pcmasterrace")) == ["gaming"]
    assert rt(_item(sub="GamingCircleJerk")) == ["gaming", "memes"]
    # modded-MC joins minecraft (user decision: modded goes with feedthebeast)
    assert rt(_item(sub="CreateMod")) == ["minecraft"]
    assert rt(_item(sub="minecraftmemes")) == ["minecraft", "memes"]
    # game development is coding, not gaming
    assert rt(_item(sub="gamedev")) == ["coding"]


def test_ephemeral_subreddit_map():
    # Deal subs are ephemeral-ONLY — no gaming co-tag. The ephemeral decay wave is
    # age-gated; a gaming co-tag would let the ungated gaming wave sweep live promos.
    assert categorize.reddit_tags(_item(sub="GameDeals")) == ["ephemeral"]
    assert categorize.reddit_tags(_item(sub="buildapcsales")) == ["ephemeral"]


def test_ephemeral_keyword_fallback_unmapped_only():
    rt = categorize.reddit_tags
    # unmapped sub + distinctive promo phrasing -> ephemeral
    assert rt(_item(sub="randomsub", title="Steam summer giveaway for charity")) == ["ephemeral"]
    assert rt(_item(sub="randomsub", title="RTX 5080 30% off today")) == ["ephemeral"]
    assert rt(_item(sub="randomsub", title="Humble Bundle has a new pack")) == ["ephemeral"]
    # mapped sub already carries a topic -> keyword fallback never fires
    assert rt(_item(sub="leagueoflegends", title="skin giveaway")) == ["esports"]


def test_ephemeral_keywords_conservative():
    rt = categorize.reddit_tags
    # bare "free" / "sale" / "event" / " off" must NOT tag (false-positive magnets)
    assert rt(_item(sub="randomsub", title="free will is an illusion")) == []
    assert rt(_item(sub="randomsub", title="the sale of the century, a memoir")) == []
    assert rt(_item(sub="randomsub", title="main event recap thread")) == []
    assert rt(_item(sub="randomsub", title="turned off my phone for a week")) == []


def test_new_tags_in_filter_vocab(conn):
    for t in ("esports", "gaming", "ephemeral"):
        assert t in categorize.REDDIT_TAGS and t in categorize.FILTER_TAGS
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_g", kind="post",
                    title="g", metadata={"subreddit": "gamedeals", "tags": ["ephemeral"]}))
    conn.commit()
    assert db.tag_counts(conn)["ephemeral"] == 1
