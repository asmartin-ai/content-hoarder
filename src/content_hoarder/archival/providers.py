"""Archive providers: PullPush.io (primary) and Arctic-Shift (fallback).

Optional, removable feature (network-only). Ported from reddit-saved-manager.

Each provider fetches reddit posts/comments by base36 id (no t3_/t1_ prefix) and
returns dicts keyed by id with a normalized field shape ready to overlay onto an
items row. Both archives use a ``{"data": [ ... ]}`` envelope.

Field availability (verified against the live APIs):
  posts    : id, title, selftext, author, subreddit, permalink, url, created_utc
  comments : id, body, author, subreddit, created_utc, (permalink/link_id vary)
PullPush comments omit ``permalink``; Arctic-Shift includes it — hence two providers.
"""
import html
import re
import time

from content_hoarder.archival import _http

# Reddit base36 ids are ASCII alphanumerics. Validate before putting ids in a URL so
# a malformed imported fullname can't corrupt the request or inject query params.
_VALID_ID = re.compile(r"^[A-Za-z0-9]+$")

PULLPUSH_BASE = "https://api.pullpush.io"
ARCTIC_BASE = "https://arctic-shift.photon-reddit.com"

_PLACEHOLDERS = {"[removed]", "[deleted]"}


def _bare_id(fullname: str) -> str:
    """Strip a t3_/t1_ prefix → bare base36 id. Both archives' comment-search
    endpoints expect the bare link id (PullPush returns HTTP 400 with the prefix)."""
    if fullname.startswith(("t1_", "t3_")):
        return fullname[3:]
    return fullname


def _norm_permalink(p: str) -> str:
    if not p:
        return ""
    return ("https://www.reddit.com" + p) if p.startswith("/") else p


def _media_url(rec: dict) -> str:
    """Best direct media URL: the reddit_video fallback_url, else the resolved dest URL."""
    rv = ((rec.get("media") or {}).get("reddit_video") or {}).get("fallback_url")
    if rv:
        return rv
    rv = ((rec.get("secure_media") or {}).get("reddit_video") or {}).get("fallback_url")
    if rv:
        return rv
    return rec.get("url_overridden_by_dest") or rec.get("url") or ""


def _thumb(rec: dict) -> str:
    """A thumbnail image URL: the hi-res preview image (HTML-unescaped), else the
    ``thumbnail`` field when it's a real URL (skips self/default/nsfw/spoiler sentinels)."""
    images = (rec.get("preview") or {}).get("images")
    if isinstance(images, list) and images and isinstance(images[0], dict):
        src = (images[0].get("source") or {}).get("url")
        if src:
            return html.unescape(src)
    t = rec.get("thumbnail") or ""
    return t if isinstance(t, str) and t.startswith("http") else ""


def _gallery(rec: dict) -> list:
    """Ordered list of full-size gallery image URLs from ``gallery_data`` + ``media_metadata``
    (both returned by the archives). Empty list for non-gallery posts."""
    if not rec.get("is_gallery"):
        return []
    mm = rec.get("media_metadata") or {}
    items = (rec.get("gallery_data") or {}).get("items") or []
    order = [it.get("media_id") for it in items if isinstance(it, dict)] or list(mm.keys())
    urls = []
    for mid in order:
        s = (mm.get(mid) or {}).get("s") or {}
        u = s.get("u") or s.get("gif") or s.get("mp4")
        if u:
            urls.append(html.unescape(u))
    return urls


def _media_type(rec: dict) -> str:
    """Classify a submission as image / reddit_video / gallery / link, or '' (unknown —
    the caller keeps the URL-heuristic value). Order matters: video and gallery win."""
    if rec.get("is_video") or (rec.get("media") or {}).get("reddit_video"):
        return "reddit_video"
    if rec.get("is_gallery"):
        return "gallery"
    hint = rec.get("post_hint")
    if hint == "image":
        return "image"
    if hint == "hosted:video":   # reddit-hosted video; "rich:video" is an external embed
        return "reddit_video"    # (YouTube, Streamable, …) → fall through so the URL heuristic wins
    if hint == "link":
        return "link"
    return ""


def _norm_post(rec: dict) -> dict:
    return {
        "title": rec.get("title") or "",
        "body": rec.get("selftext") or "",
        "author": rec.get("author") or "",
        "subreddit": rec.get("subreddit") or "",
        "permalink": _norm_permalink(rec.get("permalink") or ""),
        "url": rec.get("url") or "",
        "created_utc": rec.get("created_utc"),
        "score": rec.get("score") or 0,
        "over_18": 1 if rec.get("over_18") else 0,
        "media_type": _media_type(rec),
        "media_url": _media_url(rec),
        "thumbnail": _thumb(rec),
        "gallery": _gallery(rec),
    }


def _norm_comment(rec: dict) -> dict:
    return {
        "body": rec.get("body") or "",
        "author": rec.get("author") or "",
        "subreddit": rec.get("subreddit") or "",
        "permalink": _norm_permalink(rec.get("permalink") or ""),
        "score": rec.get("score") or 0,
        "depth": 0,  # archives don't give a reliable tree; render flat
        "created_utc": rec.get("created_utc"),
    }


class ArchiveProvider:
    """Base provider: batching, throttling, and 429 backoff. Subclasses supply URLs."""

    name = "base"
    max_batch = 100

    def __init__(self, user_agent, *, min_interval: float = 0.0,
                 sleep=time.sleep, get_json=None, max_retries: int = 3):
        self.user_agent = user_agent
        self.min_interval = min_interval
        self._sleep = sleep
        self._get_json = get_json or _http.get_json
        self.max_retries = max_retries
        self._made_request = False

    # -- URL builders (overridden per provider) ------------------------------
    def _ids_url(self, kind: str, ids: list) -> str:
        raise NotImplementedError

    def _search_comments_url(self, link_fullname: str, limit: int) -> str:
        raise NotImplementedError

    # -- HTTP with throttle + backoff ----------------------------------------
    def _request(self, url: str) -> dict:
        if self._made_request and self.min_interval > 0:
            self._sleep(self.min_interval)
        delay = 2.0
        for attempt in range(self.max_retries + 1):
            try:
                self._made_request = True
                _status, _headers, data = self._get_json(url, self.user_agent)
                return data if isinstance(data, dict) else {"data": data}
            except _http.ArchiveError as e:
                if e.status == 429 and attempt < self.max_retries:
                    # e.retry_after is now the shared parser's numeric value (float|None),
                    # gaining the HTTP-date/negative guard the old `float(e.retry_after)`
                    # lacked; fall back to the doubling delay when it's absent.
                    wait = e.retry_after if e.retry_after is not None else delay
                    self._sleep(wait)
                    delay *= 2
                    continue
                raise
        return {}

    # -- Public fetches ------------------------------------------------------
    def _fetch(self, kind: str, ids: list, normalizer) -> dict:
        out = {}
        ids = [i for i in ids if _VALID_ID.match(i or "")]
        for i in range(0, len(ids), self.max_batch):
            batch = ids[i:i + self.max_batch]
            data = self._request(self._ids_url(kind, batch))
            for rec in (data.get("data") or []):
                rid = rec.get("id")
                if rid:
                    out[rid] = normalizer(rec)
        return out

    def fetch_posts(self, ids: list) -> dict:
        return self._fetch("posts", ids, _norm_post)

    def fetch_comments(self, ids: list) -> dict:
        return self._fetch("comments", ids, _norm_comment)

    def search_comments(self, link_fullname: str, limit: int = 200) -> list:
        data = self._request(self._search_comments_url(link_fullname, limit))
        return [_norm_comment(rec) for rec in (data.get("data") or [])]


class PullPushProvider(ArchiveProvider):
    name = "pullpush"
    max_batch = 100  # PullPush caps `size`/ids at 100

    def _ids_url(self, kind, ids):
        path = "submission" if kind == "posts" else "comment"
        return f"{PULLPUSH_BASE}/reddit/search/{path}/?ids={','.join(ids)}"

    def _search_comments_url(self, link_fullname, limit):
        return f"{PULLPUSH_BASE}/reddit/search/comment/?link_id={_bare_id(link_fullname)}&size={min(limit, 100)}"


class ArcticShiftProvider(ArchiveProvider):
    name = "arctic"
    max_batch = 500  # Arctic-Shift allows up to 500 ids/request

    def _ids_url(self, kind, ids):
        path = "posts" if kind == "posts" else "comments"
        return f"{ARCTIC_BASE}/api/{path}/ids?ids={','.join(ids)}"

    def _search_comments_url(self, link_fullname, limit):
        return f"{ARCTIC_BASE}/api/comments/search?link_id={_bare_id(link_fullname)}&limit={limit}"


def default_providers(user_agent, *, throttle: bool = True, order=("pullpush", "arctic")):
    """Build providers in priority order. ``throttle`` enables rate-limit spacing for
    bulk hydration; pass throttle=False for snappy single on-demand fetches."""
    factories = {
        "pullpush": lambda: PullPushProvider(user_agent, min_interval=4.0 if throttle else 0.0),
        "arctic": lambda: ArcticShiftProvider(user_agent, min_interval=0.4 if throttle else 0.0),
    }
    return [factories[name]() for name in order if name in factories]
