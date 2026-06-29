"""T2 tag-coverage-expansion — oracle for the extended browser host/keyword maps.

Mirrors ``tests/test_bakeoff_f14_firefox_hn_tags.py`` in style. Pins the extended
``_BROWSER_HOST_TAGS`` / ``_BROWSER_KEYWORD_TAGS`` surface for both ``firefox_tags``
and ``hackernews_tags``:

  * the 7 new buckets (ai_ml, web_dev, self_hosted, linux, startups, crypto,
    productivity) — host-driven AND keyword-driven variants on distinct inputs;
  * existing-tag host extensions (vtubers, anime, minecraft, gaming, coding, science);
  * existing-tag keyword extensions (vtubers, anime, minecraft, japan);
  * no-match-still-returns-empty.

Deterministic, no DB, no network. Item shapes are the real connector shapes
(firefox: top-level ``url`` + ``metadata.domain``; hackernews: top-level ``url``).
"""

from content_hoarder import categorize as cat


# --------------------------------------------------------------------------- #
# helpers — build items in the exact shape the connectors emit
# --------------------------------------------------------------------------- #
def _firefox(title, url, domain=None):
    md = {"domain": domain if domain is not None else _host(url)}
    return {
        "source": "firefox",
        "kind": "tab",
        "title": title,
        "url": url,
        "metadata": md,
    }


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
# new buckets — ai_ml
# --------------------------------------------------------------------------- #
def test_hn_ai_ml_host():
    item = _hn("Claude 3.5 Sonnet", "https://www.anthropic.com/news/claude-3-5-sonnet")
    assert "ai_ml" in cat.hackernews_tags(item)


def test_hn_ai_ml_keyword():
    item = _hn("A deep dive into transformer architectures", "https://example.org/post")
    assert "ai_ml" in cat.hackernews_tags(item)


def test_ff_ai_ml_host():
    item = _firefox(
        "GPT-4 technical report", "https://openai.com/research/gpt-4", "openai.com"
    )
    assert "ai_ml" in cat.firefox_tags(item)


def test_ff_ai_ml_keyword():
    item = _firefox(
        "A practical guide to machine learning",
        "https://blog.example.com/x",
        "blog.example.com",
    )
    assert "ai_ml" in cat.firefox_tags(item)


# --------------------------------------------------------------------------- #
# new buckets — web_dev
# --------------------------------------------------------------------------- #
def test_hn_web_dev_host():
    item = _hn("Modern CSS techniques", "https://css-tricks.com/modern-css")
    assert "web_dev" in cat.hackernews_tags(item)


def test_hn_web_dev_keyword():
    item = _hn("A guide to React server components", "https://example.org/post")
    assert "web_dev" in cat.hackernews_tags(item)


def test_ff_web_dev_host():
    item = _firefox(
        "Smashing Magazine: frontend mastery",
        "https://smashingmagazine.com/x",
        "smashingmagazine.com",
    )
    assert "web_dev" in cat.firefox_tags(item)


def test_ff_web_dev_keyword():
    item = _firefox(
        "Why I switched my frontend to Svelte",
        "https://blog.example.com/x",
        "blog.example.com",
    )
    assert "web_dev" in cat.firefox_tags(item)


# --------------------------------------------------------------------------- #
# new buckets — self_hosted
# --------------------------------------------------------------------------- #
def test_hn_self_hosted_host():
    item = _hn("Self-hosting your photos with Nextcloud", "https://nextcloud.com/blog")
    assert "self_hosted" in cat.hackernews_tags(item)


def test_hn_self_hosted_keyword():
    item = _hn("My homelab rack tour for 2024", "https://example.org/post")
    assert "self_hosted" in cat.hackernews_tags(item)


def test_ff_self_hosted_host():
    item = _firefox(
        "LinuxServer.io docker images", "https://linuxserver.io/", "linuxserver.io"
    )
    assert "self_hosted" in cat.firefox_tags(item)


def test_ff_self_hosted_keyword():
    item = _firefox(
        "Building a home server for media",
        "https://blog.example.com/x",
        "blog.example.com",
    )
    assert "self_hosted" in cat.firefox_tags(item)


# --------------------------------------------------------------------------- #
# new buckets — linux
# --------------------------------------------------------------------------- #
def test_hn_linux_host():
    item = _hn("Kernel development update", "https://kernel.org/log")
    assert "linux" in cat.hackernews_tags(item)


def test_hn_linux_keyword():
    item = _hn(
        "Why I switched from Windows to Linux on the desktop",
        "https://example.org/post",
    )
    assert "linux" in cat.hackernews_tags(item)


def test_ff_linux_host():
    item = _firefox(
        "Arch Linux wiki: installation guide", "https://archlinux.org/", "archlinux.org"
    )
    assert "linux" in cat.firefox_tags(item)


def test_ff_linux_keyword():
    item = _firefox(
        "Migrating my setup to Wayland",
        "https://blog.example.com/x",
        "blog.example.com",
    )
    assert "linux" in cat.firefox_tags(item)


# --------------------------------------------------------------------------- #
# new buckets — startups
# --------------------------------------------------------------------------- #
def test_hn_startups_host():
    item = _hn("YC W24 batch demo day recap", "https://www.ycombinator.com/blog/w24")
    assert "startups" in cat.hackernews_tags(item)


def test_hn_startups_keyword():
    item = _hn("How we raised our seed round", "https://example.org/post")
    assert "startups" in cat.hackernews_tags(item)


def test_ff_startups_host():
    item = _firefox(
        "TechCrunch: startup news", "https://techcrunch.com/x", "techcrunch.com"
    )
    assert "startups" in cat.firefox_tags(item)


def test_ff_startups_keyword():
    item = _firefox(
        "Life as an indie hacker", "https://blog.example.com/x", "blog.example.com"
    )
    assert "startups" in cat.firefox_tags(item)


# --------------------------------------------------------------------------- #
# new buckets — crypto
# --------------------------------------------------------------------------- #
def test_hn_crypto_host():
    item = _hn("Ethereum roadmap update", "https://ethereum.org/en/roadmap/")
    assert "crypto" in cat.hackernews_tags(item)


def test_hn_crypto_keyword():
    item = _hn("Understanding the Bitcoin blockchain", "https://example.org/post")
    assert "crypto" in cat.hackernews_tags(item)


def test_ff_crypto_host():
    item = _firefox(
        "CoinDesk: market coverage", "https://coindesk.com/x", "coindesk.com"
    )
    assert "crypto" in cat.firefox_tags(item)


def test_ff_crypto_keyword():
    item = _firefox(
        "A beginner's guide to DeFi protocols",
        "https://blog.example.com/x",
        "blog.example.com",
    )
    assert "crypto" in cat.firefox_tags(item)


# --------------------------------------------------------------------------- #
# new buckets — productivity
# --------------------------------------------------------------------------- #
def test_hn_productivity_host():
    item = _hn("Notion's new AI features", "https://notion.so/blog/ai")
    assert "productivity" in cat.hackernews_tags(item)


def test_hn_productivity_keyword():
    item = _hn("My productivity system after ten years", "https://example.org/post")
    assert "productivity" in cat.hackernews_tags(item)


def test_ff_productivity_host():
    item = _firefox("Obsidian: a second brain", "https://obsidian.md/", "obsidian.md")
    assert "productivity" in cat.firefox_tags(item)


def test_ff_productivity_keyword():
    item = _firefox(
        "The pomodoro technique revisited",
        "https://blog.example.com/x",
        "blog.example.com",
    )
    assert "productivity" in cat.firefox_tags(item)


# --------------------------------------------------------------------------- #
# existing-tag host extensions — vtubers
# --------------------------------------------------------------------------- #
def test_ff_vtubers_host():
    item = _firefox(
        "Hololive English",
        "https://hololive.hololivepro.com/en/",
        "hololive.hololivepro.com",
    )
    assert "vtubers" in cat.firefox_tags(item)


def test_hn_vtubers_host():
    item = _hn("Nijisanji talents announced", "https://nijisanji.tv/members")
    assert "vtubers" in cat.hackernews_tags(item)


def test_ff_vtubers_keyword():
    item = _firefox(
        "Best VTuber concerts of 2024", "https://blog.example.com/x", "blog.example.com"
    )
    assert "vtubers" in cat.firefox_tags(item)


def test_hn_vtubers_keyword():
    item = _hn("A history of the VTuber phenomenon", "https://example.org/post")
    assert "vtubers" in cat.hackernews_tags(item)


# --------------------------------------------------------------------------- #
# existing-tag host extensions — anime
# --------------------------------------------------------------------------- #
def test_ff_anime_host():
    item = _firefox(
        "Crunchyroll spring lineup", "https://crunchyroll.com/lineup", "crunchyroll.com"
    )
    assert "anime" in cat.firefox_tags(item)


def test_hn_anime_host():
    item = _hn("Aniwave domain changes explained", "https://aniwave.to/news")
    assert "anime" in cat.hackernews_tags(item)


def test_ff_anime_keyword():
    item = _firefox(
        "The best manga of the decade", "https://blog.example.com/x", "blog.example.com"
    )
    assert "anime" in cat.firefox_tags(item)


# --------------------------------------------------------------------------- #
# existing-tag host extensions — minecraft
# --------------------------------------------------------------------------- #
def test_ff_minecraft_host():
    item = _firefox(
        "Modrinth: top mods this month", "https://modrinth.com/mods", "modrinth.com"
    )
    assert "minecraft" in cat.firefox_tags(item)


def test_hn_minecraft_host():
    item = _hn("Feed the Beast modpack roundup", "https://feed-the-beast.com/")
    assert "minecraft" in cat.hackernews_tags(item)


def test_ff_minecraft_keyword():
    item = _firefox(
        "Building a Minecraft survival base",
        "https://blog.example.com/x",
        "blog.example.com",
    )
    assert "minecraft" in cat.firefox_tags(item)


# --------------------------------------------------------------------------- #
# existing-tag host extensions — gaming (wiki sub-sites)
# --------------------------------------------------------------------------- #
def test_ff_gaming_wiki_host():
    item = _firefox(
        "Stardew Valley wiki: bundles",
        "https://stardewvalleywiki.com/bundles",
        "stardewvalleywiki.com",
    )
    assert "gaming" in cat.firefox_tags(item)


def test_hn_gaming_wiki_host():
    item = _hn(
        "Project Zomboid beginner's guide", "https://pzwiki.net/wiki/Getting_Started"
    )
    assert "gaming" in cat.hackernews_tags(item)


# --------------------------------------------------------------------------- #
# existing-tag host extensions — coding
# --------------------------------------------------------------------------- #
def test_ff_coding_host():
    item = _firefox(
        "A great Stack Overflow answer",
        "https://stackoverflow.com/q/12345",
        "stackoverflow.com",
    )
    assert "coding" in cat.firefox_tags(item)


def test_hn_coding_host():
    item = _hn("Show HN: my new GitHub project", "https://github.com/me/my-project")
    assert "coding" in cat.hackernews_tags(item)


# --------------------------------------------------------------------------- #
# existing-tag host extensions — science
# --------------------------------------------------------------------------- #
def test_hn_science_host_nature():
    item = _hn("New discovery", "https://www.nature.com/articles/d41586-023-04045-8")
    assert "science" in cat.hackernews_tags(item)


def test_ff_science_host_arxiv():
    item = _firefox(
        "arXiv: new ML paper", "https://arxiv.org/abs/2401.00001", "arxiv.org"
    )
    assert "science" in cat.firefox_tags(item)


# --------------------------------------------------------------------------- #
# existing-tag keyword extension — japan
# --------------------------------------------------------------------------- #
def test_hn_japan_keyword():
    item = _hn("A photographic tour of Tokyo", "https://example.org/post")
    assert "japan" in cat.hackernews_tags(item)


def test_ff_japan_keyword():
    item = _firefox(
        "Learning the Japanese language as an adult",
        "https://blog.example.com/x",
        "blog.example.com",
    )
    assert "japan" in cat.firefox_tags(item)


# --------------------------------------------------------------------------- #
# no-match still empty
# --------------------------------------------------------------------------- #
def test_ff_no_match_still_empty():
    item = _firefox("Random recipe blog", "https://example.com/food", "example.com")
    assert cat.firefox_tags(item) == []


def test_hn_no_match_still_empty():
    item = _hn(
        "A gentle introduction to category theory", "https://example.org/cat-theory"
    )
    assert cat.hackernews_tags(item) == []
