"""Heuristic content categorizer: tag items listenable / watch / wotagei / unknown.

No LLM (validate heuristic accuracy first). The category is stored on
``metadata.category`` for compatibility and mirrored into ``metadata.tags`` for
the browse filters. YouTube videos are the default target. An LLM auto-classifier
is a separate backlog item.
"""
from __future__ import annotations

import json
import re
import time
from functools import lru_cache
from pathlib import Path

from content_hoarder import config, db
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
    """Categorize a source's items, mirroring visible categories into tags."""
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
    for it in rows:
        cat = categorize_item(it)
        counts[cat] = counts.get(cat, 0) + 1
        db.set_category(conn, it["fullname"], cat)
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
    "nsfw_erotic", "nsfw_talk", "nsfw_other", "vtubers", "coding", "japan",
    "anime", "memes", "minecraft", "defense", "science", "tips",
    "esports", "gaming", "ephemeral",
)

# The curated vocabulary the browse tag-rail filters on: the reddit topic/NSFW tags plus the
# YouTube processing-area tags (mirrored from metadata.category by db.set_category). Anything
# ELSE that lands in metadata.tags — notably YouTube per-video keywords from the enrich pass —
# is deliberately NOT a filter facet, so the rail stays a small, meaningful set (~18 tags)
# instead of the tens of thousands of raw keywords. db.tag_counts restricts to this set.
FILTER_TAGS = REDDIT_TAGS + db.PROCESSING_TAGS

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

# Epic 21 (2026-06-10): gaming/esports/ephemeral buckets for the decay backfill.
# Subdivision per user spec: esports titles separate from casual/general gaming; modded-MC
# subs join the existing minecraft bucket (feedthebeast precedent). All entries
# corpus-confirmed against the live inbox (read-only inventory, 2026-06-10).
# NOTE: deal subs are ephemeral-ONLY (no gaming co-tag) — the ephemeral decay wave is
# age-gated so still-live promos survive; a gaming co-tag would sweep them ungated.
_SUBREDDIT_TAGS.update({
    # esports titles (LoL / OW / CS / R6 / Valorant)
    "leagueoflegends": ["esports"], "leagueofmemes": ["esports", "memes"],
    "summonerschool": ["esports"], "valorant": ["esports"],
    "globaloffensive": ["esports"], "csgo": ["esports"],
    "overwatch": ["esports"], "competitiveoverwatch": ["esports"],
    "overwatchuniversity": ["esports"], "overwatch_memes": ["esports", "memes"],
    "rainbow6": ["esports"], "shittyrainbow6": ["esports", "memes"],
    "r6proleague": ["esports"], "esports": ["esports"],
    # casual / general gaming
    "gaming": ["gaming"], "games": ["gaming"], "truegaming": ["gaming"],
    "pcgaming": ["gaming"], "pcmasterrace": ["gaming"], "patientgamers": ["gaming"],
    "steam": ["gaming"], "gamingcirclejerk": ["gaming", "memes"], "girlgamers": ["gaming"],
    "projectzomboid": ["gaming"], "stellaris": ["gaming"], "hoi4": ["gaming"],
    "kaiserreich": ["gaming"], "civ": ["gaming"], "rimworld": ["gaming"],
    "aoe2": ["gaming"], "battlefield_one": ["gaming"], "cyberpunkgame": ["gaming"],
    "darkestdungeon": ["gaming"], "hadesthegame": ["gaming"], "satisfactorygame": ["gaming"],
    "osugame": ["gaming"], "ddlc": ["gaming"], "katawashoujo": ["gaming"],
    "coffinofandyandleyley": ["gaming"], "girlsfrontline": ["gaming"], "azurelane": ["gaming"],
    # modded-MC joiners (user decision: modded goes with feedthebeast = minecraft)
    "createmod": ["minecraft"], "minecraftmemes": ["minecraft", "memes"],
    "minecraftbuilds": ["minecraft"],
    # game development is coding, not gaming
    "gamedev": ["coding"],
    # ephemeral: deal/promo subs — time-limited by nature ("likely easy to let go")
    "gamedeals": ["ephemeral"], "buildapcsales": ["ephemeral"],
    "freegamefindings": ["ephemeral"], "frugalmalefashion": ["ephemeral"],
    "freebies": ["ephemeral"],
})

# Untagged-tail coverage expansion (Epic 21 rehearsal, 2026-06-10): conservative mappings
# into EXISTING buckets only, from the post-retag top-200 untagged inbox inventory. Skipped
# on purpose: discussion subs (askreddit, bestof, iama, ...), fiction (scp, writingprompts,
# humansarespaceorcs), streaming (livestreamfail, offlinetv — no bucket), knowledge/identity
# (adhd, adhdwomen — future resurfacing material, never decay), personal (iastate).
_SUBREDDIT_TAGS.update({
    # anime (series / fandom / gif subs)
    "animegifs": ["anime"], "animenocontext": ["anime", "memes"],
    "animememes": ["anime", "memes"], "historyanimemes": ["anime", "memes"],
    "spyxfamily": ["anime"], "kiminonawa": ["anime"], "evangelion": ["anime"],
    "domesticgirlfriend": ["anime"], "kanojookarishimasu": ["anime"],
    "wholesomeyuri": ["anime"], "nagatoro": ["anime"], "seishunbutayarou": ["anime"],
    # memes / humor (screenshot-humor subs; r/tinder + r/comics deliberately NOT mapped —
    # user decision 2026-06-10: they don't belong in the memes decay bucket)
    "whenthe": ["memes"], "bi_irl": ["memes"], "newgreentexts": ["memes"],
    "anarchychess": ["memes"], "cursedcomments": ["memes"], "unexpected": ["memes"],
    "brandnewsentence": ["memes"], "murderedbywords": ["memes"],
    "nonpoliticaltwitter": ["memes"], "blursedimages": ["memes"], "tihi": ["memes"],
    "suspiciouslyspecific": ["memes"], "hopeposting": ["memes"], "discord_irl": ["memes"],
    "youtubehaiku": ["memes"], "perfectlycutscreams": ["memes"],
    "maybemaybemaybe": ["memes"], "hmmm": ["memes"], "meme": ["memes"],
    "chadtopia": ["memes"], "extrafabulouscomics": ["memes"],
    "politicalcompassmemes": ["memes"], "politicalhumor": ["memes"],
    "dndmemes": ["memes"], "roughromanmemes": ["memes"], "oddlyspecific": ["memes"],
    "physicsmemes": ["science", "memes"], "mathmemes": ["science", "memes"],
    "shermanposting": ["defense", "memes"],
    # defense / military
    "military": ["defense"],
    # science / engineering
    "spacex": ["science"], "engineeringporn": ["science"],
    # coding / computing
    "learnpython": ["coding"], "learnmachinelearning": ["coding"],
    "linux": ["coding"], "hacking": ["coding"], "howtohack": ["coding"],
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
    # Ephemeral promo/sale/event vocabulary — deliberately specific phrases only (never bare
    # "free"/"sale"/"deal"/"event": false-positive magnets). The decay wave for this tag is
    # age-gated, so a rare false positive is recoverable and a true-but-recent promo survives.
    # (?<!dead ) guards the idiom "a dead giveaway" — a real corpus false positive.
    ("ephemeral", re.compile(
        r"\b(?<!dead )giveaway\b|\d+\s*%\s*off\b|\bsale\s+ends\b|\blast\s+chance\b"
        r"|\blimited[- ]time\b|\bfree\s+until\b|\bfree\s+weekend\b|\bfree\s+to\s+keep\b"
        r"|\bhumble\s+bundle\b|\bpromo\s+code\b|\bcoupon\b|\bexpires\b|\bflash\s+sale\b",
        re.IGNORECASE)),
]

# NSFW classification is subreddit-driven (the over_18 flag is too sparse to rely on). The rule
# lists are intentionally NOT in source — they load from a gitignored JSON
# (CONTENT_HOARDER_NSFW_RULES, default "nsfw_rules.json"; see nsfw_rules.example.json for the
# schema). Without that file, reddit items simply aren't NSFW-tagged. Three tags:
#   nsfw_erotic — sexual imagery   nsfw_talk — NSFW discussion   nsfw_other — over_18 residual
@lru_cache(maxsize=8)
def _load_nsfw_rules(path: str) -> dict:
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = {}
    low = lambda xs: frozenset(str(x).lower() for x in (xs or []))  # noqa: E731
    kws = [str(k) for k in (raw.get("erotic_keywords") or [])]
    return {
        "talk": low(raw.get("talk_subs")),
        "erotic": low(raw.get("erotic_subs")),
        "exclude": low(raw.get("sfw_exclude")),
        "kw": re.compile("|".join(kws), re.IGNORECASE) if kws else None,
    }


def _nsfw_tag(sub: str, md: dict):
    """The single NSFW tag for a subreddit (or None). Subreddit-driven (rules from the gitignored
    config); over_18 is only the last-resort residual for non-erotic flagged content."""
    r = _load_nsfw_rules(config.get("CONTENT_HOARDER_NSFW_RULES") or "nsfw_rules.json")
    if sub in r["talk"]:
        return "nsfw_talk"
    if sub in r["erotic"]:
        return "nsfw_erotic"
    if r["kw"] is not None and sub not in r["exclude"] and r["kw"].search(sub):
        return "nsfw_erotic"
    if md.get("over_18"):
        return "nsfw_other"
    return None


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
    nsfw = _nsfw_tag(sub, md)
    if nsfw:
        add(nsfw)

    for t in _SUBREDDIT_TAGS.get(sub, []):
        add(t)

    _NSFW = ("nsfw_erotic", "nsfw_talk", "nsfw_other")
    has_topic = any(t not in _NSFW for t in tags)
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
