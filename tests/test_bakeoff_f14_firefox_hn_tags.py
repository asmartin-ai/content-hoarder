"""F14 oracle (RED) — firefox_tags / hackernews_tags knowledge-bucket tagging.

Pins the contract for two not-yet-built pure functions in
``content_hoarder.categorize`` that mirror the existing ``youtube_tags``:

  * ``firefox_tags(item)``   — tags a Firefox-tab item
  * ``hackernews_tags(item)`` — tags a Hacker-News item

Both must:
  * be pure (item dict -> ``list[str]``), like ``youtube_tags``;
  * assign tags from the item's host (URL / ``metadata.domain``) + title keywords;
  * support the EXISTING ``gaming`` and ``defense`` buckets;
  * support a NEW ``investing`` bucket (bloomberg/markets/stocks/earnings/...);
  * return ``[]`` on no match.

Item shapes used here are the REAL ones the connectors emit
(``src/content_hoarder/connectors/firefox.py`` and ``hackernews.py``):

  firefox: top-level ``url`` + ``metadata.domain`` (lowercased host), ``source="firefox"``.
  hackernews: top-level ``url`` (the article URL) + ``metadata.hn_url``, ``source="hackernews"``.

These are deterministic unit tests (no DB, no network). They are RED until the
two functions exist; once implemented they must satisfy every assertion below.
"""

from content_hoarder import categorize as cat


# --------------------------------------------------------------------------- #
# helpers — build items in the exact shape the connectors emit
# --------------------------------------------------------------------------- #
def _firefox(title, url, domain=None):
    md = {"domain": domain if domain is not None else _host(url)}
    return {"source": "firefox", "kind": "tab", "title": title, "url": url, "metadata": md}


def _hn(title, url):
    return {
        "source": "hackernews",
        "kind": "story",
        "title": title,
        "url": url,
        "metadata": {"hn_url": "https://news.ycombinator.com/item?id=1"},
    }


def _host(url):
    import re

    m = re.match(r"https?://([^/]+)", url or "", re.I)
    return m.group(1).lower() if m else ""


# --------------------------------------------------------------------------- #
# existence + return-type contract
# --------------------------------------------------------------------------- #
def test_firefox_tags_exists_and_returns_list():
    assert hasattr(cat, "firefox_tags"), "categorize.firefox_tags must exist (F14)"
    out = cat.firefox_tags(_firefox("Anything at all", "https://example.com/page"))
    assert isinstance(out, list)
    assert all(isinstance(t, str) for t in out)


def test_hackernews_tags_exists_and_returns_list():
    assert hasattr(cat, "hackernews_tags"), "categorize.hackernews_tags must exist (F14)"
    out = cat.hackernews_tags(_hn("Anything at all", "https://example.com/page"))
    assert isinstance(out, list)
    assert all(isinstance(t, str) for t in out)


# --------------------------------------------------------------------------- #
# firefox_tags — bucket assignment
# --------------------------------------------------------------------------- #
def test_firefox_gaming_bucket():
    # host-driven
    item = _firefox("Patch notes 1.21", "https://store.steampowered.com/app/123", "store.steampowered.com")
    assert "gaming" in cat.firefox_tags(item)
    # title-keyword-driven (distinct input — not the same case)
    item2 = _firefox("My Steam library backlog is huge", "https://blog.example.com/post", "blog.example.com")
    assert "gaming" in cat.firefox_tags(item2)


def test_firefox_defense_bucket():
    item = _firefox("F-35 program update", "https://www.defensenews.com/air/", "www.defensenews.com")
    assert "defense" in cat.firefox_tags(item)
    item2 = _firefox("Analysis of the latest military aircraft", "https://news.example.com/x", "news.example.com")
    assert "defense" in cat.firefox_tags(item2)


def test_firefox_investing_bucket_new():
    # NEW bucket: clearly-investing host
    item = _firefox("Markets wrap: stocks rally", "https://www.bloomberg.com/markets", "www.bloomberg.com")
    assert "investing" in cat.firefox_tags(item)
    # NEW bucket: title-keyword-driven on a neutral host
    item2 = _firefox("Q3 earnings beat sends the stock soaring", "https://blog.example.com/post", "blog.example.com")
    assert "investing" in cat.firefox_tags(item2)


def test_firefox_no_match_is_empty():
    item = _firefox("How to bake sourdough bread at home", "https://example.com/recipe", "example.com")
    assert cat.firefox_tags(item) == []


# --------------------------------------------------------------------------- #
# hackernews_tags — bucket assignment
# --------------------------------------------------------------------------- #
def test_hackernews_gaming_bucket():
    item = _hn("Show HN: my open-source game engine", "https://store.steampowered.com/app/999")
    assert "gaming" in cat.hackernews_tags(item)
    item2 = _hn("Reverse-engineering an old video game's save format", "https://example.org/post")
    assert "gaming" in cat.hackernews_tags(item2)


def test_hackernews_defense_bucket():
    item = _hn("Inside a modern missile defense radar", "https://www.defensenews.com/x")
    assert "defense" in cat.hackernews_tags(item)
    item2 = _hn("The economics of military drone warfare", "https://example.org/post")
    assert "defense" in cat.hackernews_tags(item2)


def test_hackernews_investing_bucket_new():
    item = _hn("Bloomberg: bond yields and the stock market selloff", "https://www.bloomberg.com/news/x")
    assert "investing" in cat.hackernews_tags(item)
    item2 = _hn("Ask HN: how do you think about index-fund investing?", "https://example.org/post")
    assert "investing" in cat.hackernews_tags(item2)


def test_hackernews_no_match_is_empty():
    item = _hn("A gentle introduction to category theory", "https://example.org/cat-theory")
    assert cat.hackernews_tags(item) == []
