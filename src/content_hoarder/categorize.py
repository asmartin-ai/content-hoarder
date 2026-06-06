"""Heuristic content categorizer: tag items listenable / watch / wotagei / unknown.

No LLM (asmartin-ai wants to validate heuristic accuracy first). The category is stored on
``metadata.category`` non-destructively and is re-runnable. YouTube videos are the
default target. An LLM auto-classifier is a separate backlog item.
"""
from __future__ import annotations

import re
import time

from content_hoarder import db
from content_hoarder.models import parse_metadata

# Title keywords that mark a wotagei (ヲタ芸) idol-event performance.
_WOTAGEI_RE = re.compile(r"ヲタ芸|オタ芸|ﾜｵﾀ|wotagei|\bwota\b", re.IGNORECASE)

# Channels that are reliably "listenable" (audio-first: long-form talk, music, podcasts).
# Word-boundaried so short tokens (e.g. "lofi") don't match unrelated names like
# "LoFire Productions". "<Artist> - Topic" is YouTube's auto music-channel suffix.
_LISTENABLE_CHANNEL_RE = re.compile(
    r"isaac arthur|perun|lemmino|\blo-?fi\b|\s-\stopic|\bpodcast|\baudiobook|full album|soundtrack",
    re.IGNORECASE,
)

LISTENABLE_MIN_SECONDS = 30 * 60   # >= 30 min  => likely listenable
WATCH_MAX_SECONDS = 5 * 60         # <= 5 min   => short, watch

VALID_CATEGORIES = ("listenable", "watch", "wotagei", "unknown")


def categorize(title: str, channel: str, duration) -> str:
    """Return a category from the heuristics. ``duration`` is seconds (int) or None.

    Order matters: wotagei (most specific) → allowlisted channel → duration thresholds.
    """
    if _WOTAGEI_RE.search(title or ""):
        return "wotagei"
    if _LISTENABLE_CHANNEL_RE.search(channel or ""):
        return "listenable"
    try:
        secs = int(duration)
    except (TypeError, ValueError):
        secs = 0
    if secs >= LISTENABLE_MIN_SECONDS:
        return "listenable"
    if 0 < secs <= WATCH_MAX_SECONDS:
        return "watch"
    return "unknown"


def categorize_item(item: dict) -> str:
    md = item.get("metadata") or {}
    return categorize(item.get("title", ""), md.get("channel", ""), md.get("duration"))


def categorize_source(conn, source: str = "youtube", *, limit=None, retry: bool = False) -> dict:
    """Categorize a source's items, storing ``metadata.category``. Returns counts."""
    where = ["source = ?"]
    params: list = [source]
    if not retry:
        where.append("json_extract(metadata, '$.category') IS NULL")
    sql = "SELECT * FROM items WHERE " + " AND ".join(where) + " ORDER BY last_seen_utc DESC"
    if limit:
        sql += " LIMIT ?"
        params.append(int(limit))
    rows = [db._row_to_public(r) for r in conn.execute(sql, params).fetchall()]
    counts = {c: 0 for c in VALID_CATEGORIES}
    now = int(time.time())
    for it in rows:
        cat = categorize_item(it)
        counts[cat] = counts.get(cat, 0) + 1
        db.merge_upsert(conn, {"fullname": it["fullname"],
                               "metadata": {"category": cat}, "last_seen_utc": now})
    conn.commit()
    return {"selected": len(rows), "by_category": counts}


# ---------------------------------------------------------------------------
# Reddit multi-label tagging (metadata.tags) — keyless heuristics.
#
# Reddit items get a LIST of tags (a post can be both "minecraft" AND "memes"),
# unlike YouTube's single processing-area category. Re-runnable + non-destructive;
# stored on metadata.tags, which build_search_text already folds into the FTS blob.
# Tune the rules against `categorize --source reddit --dry-run` before writing.
# ---------------------------------------------------------------------------

REDDIT_TAGS = (
    "nsfw_erotic", "nsfw_other", "vtubers", "coding", "japan",
    "anime", "memes", "minecraft", "defense", "science", "tips",
)

# subreddit (lowercased) -> tags. Seeded from the corpus's top subreddits + well-known
# communities; the long tail is caught by the keyword rules below. Multi-label by design
# (e.g. feedthememes = minecraft + memes; programmerhumor = coding + memes).
_SUBREDDIT_TAGS = {
    # vtubers
    "hololive": ["vtubers"], "okbuddyhololive": ["vtubers", "memes"],
    "nijisanji": ["vtubers"], "virtualyoutubers": ["vtubers"], "vtubers": ["vtubers"],
    # anime
    "anime": ["anime"], "animemes": ["anime", "memes"], "anime_irl": ["anime", "memes"],
    "wholesomeanimemes": ["anime", "memes"], "goodanimemes": ["anime", "memes"],
    "manga": ["anime"], "awwnime": ["anime"], "okbuddybaka": ["anime", "memes"],
    "oregairusnafu": ["anime"], "characterarcs": ["anime", "memes"], "animewallpaper": ["anime"],
    # minecraft
    "minecraft": ["minecraft"], "feedthebeast": ["minecraft"], "feedthememes": ["minecraft", "memes"],
    "technicalminecraft": ["minecraft"], "mcpe": ["minecraft"], "admincraft": ["minecraft"],
    # coding
    "programming": ["coding"], "learnprogramming": ["coding"], "programmerhumor": ["coding", "memes"],
    "webdev": ["coding"], "javascript": ["coding"], "python": ["coding"], "rust": ["coding"],
    "cpp": ["coding"], "golang": ["coding"], "compsci": ["coding"], "cscareerquestions": ["coding"],
    "experienceddevs": ["coding"], "engineeringstudents": ["coding"],
    # defense / military
    "noncredibledefense": ["defense", "memes"], "noncrediblediplomacy": ["defense", "memes"],
    "lesscredibledefence": ["defense"], "credibledefense": ["defense"], "warcollege": ["defense"],
    "combatfootage": ["defense"], "militaryporn": ["defense"], "tankporn": ["defense"],
    "aviation": ["defense"], "warthunder": ["defense"],
    # japan
    "japan": ["japan"], "japanlife": ["japan"], "japantravel": ["japan"],
    "learnjapanese": ["japan"], "japanpics": ["japan"],
    # science & space
    "space": ["science"], "spaceporn": ["science"], "askscience": ["science"], "science": ["science"],
    "nasa": ["science"], "astrophotography": ["science"], "physics": ["science"], "futurology": ["science"],
    # tips & guides
    "lifeprotips": ["tips"], "youshouldknow": ["tips"], "coolguides": ["tips"],
    "explainlikeimfive": ["tips"], "todayilearned": ["tips"], "diy": ["tips"],
    "howto": ["tips"], "internetisbeautiful": ["tips"], "dataisbeautiful": ["tips"],
    # generic memes
    "memes": ["memes"], "dankmemes": ["memes"], "greentext": ["memes"], "meirl": ["memes"],
    "me_irl": ["memes"], "wholesomememes": ["memes"], "wholesomegreentext": ["memes"],
    "4chan": ["memes"], "tumblr": ["memes"], "adviceanimals": ["memes"],
    "comedyheaven": ["memes"], "terriblefacebookmemes": ["memes"], "adhdmeme": ["memes"],
}

# Coverage expansion (top-150 subreddit scan). Conservative: only confident mappings into the
# existing buckets; gaming/general/discussion subs are intentionally left untagged.
_SUBREDDIT_TAGS.update({
    # anime (series / fandom / weeb podcasts)
    "trashtaste": ["anime"], "bocchitherock": ["anime"], "sonobisquedoll": ["anime"],
    "shingekinokyojin": ["anime"], "killlakill": ["anime"],
    "evangelionmemes": ["anime", "memes"], "okbuddyumamusume": ["anime", "memes"],
    "okbuddytracen": ["anime", "memes"],
    # vtubers
    "vtubercirclejerk": ["vtubers", "memes"],
    # coding / maker
    "raspberry_pi": ["coding"], "arduino": ["coding"],
    # defense / military / war
    "warplaneporn": ["defense"], "acecombat": ["defense"], "ukraine": ["defense"],
    "ukrainewarvideoreport": ["defense"], "ukrainianconflict": ["defense"],
    # science & tech
    "technology": ["science"],
    # tips & guides
    "lifehacks": ["tips"], "socialskills": ["tips"], "outoftheloop": ["tips"],
    # japan
    "japanesepeopletwitter": ["japan", "memes"],
    # generic memes / humor
    "historymemes": ["memes"], "polandball": ["memes"], "2meirl4meirl": ["memes"],
    "starterpacks": ["memes"], "shitposting": ["memes"], "holup": ["memes"],
    "bikinibottomtwitter": ["memes"], "whitepeopletwitter": ["memes"],
    "blackpeopletwitter": ["memes"], "curatedtumblr": ["memes"], "worldjerking": ["memes"],
    "dankmemesfromsite19": ["memes"], "funny": ["memes"], "okbuddyphd": ["memes"],
    "196": ["memes"], "okbuddyvicodin": ["memes"], "bookscirclejerk": ["memes"],
})

# Keyword fallback for items whose subreddit isn't mapped — applied to the subreddit name +
# title ONLY (never body: incidental body mentions, e.g. an AskReddit answer that says "Japan",
# caused false positives) and only when the subreddit map produced no topic tag. Word-bounded.
_KEYWORD_TAGS = [
    ("minecraft", re.compile(r"\bminecraft\b|\bmodpack\b", re.IGNORECASE)),
    ("anime", re.compile(r"\banime\b|\bmanga\b|\bwaifu\b", re.IGNORECASE)),
    ("vtubers", re.compile(r"\bvtuber\b|hololive|nijisanji", re.IGNORECASE)),
    ("defense", re.compile(r"\bnon[- ]?credible\b", re.IGNORECASE)),
    ("japan", re.compile(r"\bjapan(ese)?\b", re.IGNORECASE)),
]

# Erotic-vs-other split for over_18 items. Erotic = sexual; everything else flagged 18+
# (gore, shock, combat footage, etc.) -> nsfw_other. Small seeds — tune against the dry-run.
_EROTIC_SUBS = {"gonewild", "nsfw", "rule34", "hentai", "ecchi", "hololewd"}
_EROTIC_RE = re.compile(r"\b(hentai|ecchi|lewd|rule ?34)\b", re.IGNORECASE)


def reddit_tags(item: dict) -> list[str]:
    """Ordered, de-duplicated tags for a reddit item (may be empty -> untagged)."""
    md = item.get("metadata") or {}
    sub = (md.get("subreddit") or "").lower()
    title = item.get("title") or ""
    tags: list[str] = []

    def add(t: str) -> None:
        if t not in tags:
            tags.append(t)

    # NSFW is an independent axis — it combines with whatever topic tags follow.
    if md.get("over_18"):
        add("nsfw_erotic" if (sub in _EROTIC_SUBS or _EROTIC_RE.search(title)) else "nsfw_other")

    for t in _SUBREDDIT_TAGS.get(sub, []):
        add(t)

    has_topic = any(t not in ("nsfw_erotic", "nsfw_other") for t in tags)
    if not has_topic:
        hay = sub + " " + title  # subreddit + title only — body mentions are too noisy
        for tag, rx in _KEYWORD_TAGS:
            if rx.search(hay):
                add(tag)
    return tags


def tag_reddit_source(conn, *, limit=None, retry: bool = False,
                      dry_run: bool = False, samples: int = 6) -> dict:
    """Multi-label tag reddit items into ``metadata.tags``.

    ``dry_run`` previews without writing, returning per-tag counts + sample subreddits/titles
    and an ``untagged`` count so heuristic accuracy can be validated before committing. A real
    run skips already-tagged items unless ``retry`` is set.
    """
    where = ["source = 'reddit'"]
    if not retry and not dry_run:
        where.append("json_extract(metadata, '$.tags') IS NULL")
    sql = ("SELECT fullname, title, metadata FROM items WHERE "
           + " AND ".join(where) + " ORDER BY last_seen_utc DESC")
    params: list = []
    if limit:
        sql += " LIMIT ?"
        params.append(int(limit))
    rows = conn.execute(sql, params).fetchall()  # lean columns only (no raw_json)

    by_tag = {t: 0 for t in REDDIT_TAGS}
    sample: dict = {t: [] for t in REDDIT_TAGS}
    untagged = 0
    untagged_sample: list = []
    now = int(time.time())

    for r in rows:
        md = parse_metadata(r["metadata"])
        tags = reddit_tags({"title": r["title"], "metadata": md})
        label = f"r/{md.get('subreddit') or '?'}: {(r['title'] or '')[:60]}"
        if tags:
            for t in tags:
                by_tag[t] = by_tag.get(t, 0) + 1
                if len(sample[t]) < samples:
                    sample[t].append(label)
            if not dry_run:
                db.merge_upsert(conn, {"fullname": r["fullname"],
                                       "metadata": {"tags": tags}, "last_seen_utc": now})
        else:
            untagged += 1
            if len(untagged_sample) < samples * 2:
                untagged_sample.append(label)
    if not dry_run:
        conn.commit()

    return {
        "selected": len(rows),
        "dry_run": dry_run,
        "tagged": len(rows) - untagged,
        "untagged": untagged,
        "by_tag": {t: c for t, c in by_tag.items() if c},
        "samples": {t: s for t, s in sample.items() if s},
        "untagged_sample": untagged_sample,
    }
