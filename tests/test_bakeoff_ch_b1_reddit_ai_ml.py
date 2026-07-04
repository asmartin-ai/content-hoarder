"""Bakeoff oracle — CH-B1: reddit ``ai_ml`` tagging.

Contract: ``categorize.reddit_tags(item)`` returns the multi-label tag list for a
reddit item. This oracle pins the ``ai_ml`` tag for that function.

* ``reddit_tags`` MUST emit ``ai_ml`` for items whose subreddit is an ML/AI
  community (e.g. ``MachineLearning``, ``datascience``).
* ``reddit_tags`` MUST emit ``ai_ml`` for items whose title carries an ML/AI
  keyword (e.g. "transformer", "LLM") when the subreddit itself does not map
  to a competing topic tag.
* ``reddit_tags`` MUST NOT emit ``ai_ml`` for an off-topic subreddit + off-topic
  title.
* ``reddit_tags`` MUST continue to emit ``coding`` (and NOT ``ai_ml``) for
  subreddits that are today classified as ``coding`` (e.g. ``learnpython``) —
  reclassification of an existing ``coding`` subreddit into ``ai_ml`` is a
  regression.
"""

from content_hoarder.categorize import reddit_tags


def _item(subreddit, title):
    return {"title": title, "metadata": {"subreddit": subreddit}}


def test_ml_subreddit_emits_ai_ml():
    assert "ai_ml" in reddit_tags(_item("MachineLearning", "Weekly discussion"))


def test_datascience_subreddit_emits_ai_ml():
    assert "ai_ml" in reddit_tags(_item("datascience", "Pandas question"))


def test_ml_title_keyword_emits_ai_ml():
    # Subreddit is neutral (no competing topic tag); title carries an ML keyword.
    assert "ai_ml" in reddit_tags(
        _item("all", "A new transformer architecture explained")
    )


def test_off_topic_subreddit_and_title_emit_no_ai_ml():
    tags = reddit_tags(_item("all", "NBA finals game thread"))
    assert "ai_ml" not in tags


def test_existing_coding_subreddit_still_emits_coding_not_ai_ml():
    tags = reddit_tags(_item("learnpython", "How do I read a CSV?"))
    assert "coding" in tags
    assert "ai_ml" not in tags


def test_learnmachinelearning_reclassified_to_ai_ml():
    # The ``learnmachinelearning`` subreddit is currently tagged ``coding``; this
    # oracle asserts it is classified as ``ai_ml`` instead. (The plan names this
    # case explicitly.)
    tags = reddit_tags(_item("learnmachinelearning", "Intro to neural nets"))
    assert "ai_ml" in tags
    assert "coding" not in tags
