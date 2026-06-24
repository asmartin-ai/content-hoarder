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
import json
import re
import time
import urllib.parse

from content_hoarder.archival import _http
from content_hoarder.archival._http import ArchiveError

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


def _gallery_preview(rec: dict, target: int = 1080) -> list:
    """Sized (~``target`` px wide) pre-signed preview variants, PARALLEL (same order + length)
    to ``_gallery`` (Epic 13 P2 perf). The ``s.u`` originals are huge (preview.redd.it
    width=5000); ``media_metadata[mid]['p']`` is an ascending ``[{x,y,u}]`` list of pre-signed
    smaller renditions. Pick the largest entry not exceeding ``target`` (else the smallest
    available); fall back to the full ``s.u`` when a frame has no ``p``. Gated on the same
    ``full`` presence as ``_gallery`` so the two arrays stay index-aligned (the frontend keys
    off equal lengths)."""
    if not rec.get("is_gallery"):
        return []
    mm = rec.get("media_metadata") or {}
    items = (rec.get("gallery_data") or {}).get("items") or []
    order = [it.get("media_id") for it in items if isinstance(it, dict)] or list(mm.keys())
    out = []
    for mid in order:
        meta = mm.get(mid) or {}
        s = meta.get("s") or {}
        full = s.get("u") or s.get("gif") or s.get("mp4")
        if not full:
            continue  # mirror _gallery's skip so indexes line up
        previews = [p for p in (meta.get("p") or [])
                    if isinstance(p, dict) and p.get("u")]
        chosen = full
        if previews:
            le = [p for p in previews if (p.get("x") or 0) <= target]
            pick = (max(le, key=lambda p: p.get("x") or 0) if le
                    else min(previews, key=lambda p: p.get("x") or 0))
            chosen = pick.get("u") or full
        out.append(html.unescape(chosen))
    return out


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
        "gallery_preview": _gallery_preview(rec),
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


def _norm_comment_tree(rec: dict) -> dict:
    """Normalize a comment record for thread-tree reconstruction, preserving id/parent_id."""
    return {
        "id": rec.get("id") or "",
        "parent_id": rec.get("parent_id") or "",
        "author": rec.get("author") or "",
        "body": rec.get("body") or "",
        "score": rec.get("score") or 0,
        "created_utc": rec.get("created_utc"),
        "permalink": rec.get("permalink") or "",
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

    def search_comments_tree(self, link_fullname: str, limit: int = 200) -> list:
        data = self._request(self._search_comments_url(link_fullname, limit))
        return [_norm_comment_tree(rec) for rec in (data.get("data") or [])]


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


class ArchiveTodayProvider:
    """Recover media bytes for a reddit item from archive.today snapshots.

    archive.today runs a different crawler than the Wayback Machine and stores the
    original page **with inlined images**, so it can recover the actual bytes for
    images whose ``i.redd.it`` / ``preview.redd.it`` originals are now 404
    (``media_status='gone'``) — something the PullPush/Arctic metadata archives cannot
    do (they store metadata + dead preview URLs only). It's the single most-used link
    archiver (~44% share vs Wayback's ~29%), so it frequently holds snapshots Wayback missed.

    URL-keyed (not id-keyed), HTML (not JSON), Cloudflare-gated, no bulk API →
    per-item only, wired into ``recover_one()`` as a post-chain step. The fetcher + HTML
    parser are injectable (``fetch_html=``) so the whole path is offline-testable.

    This does NOT subclass ``ArchiveProvider`` — that contract is reddit-id-keyed + JSON
    + metadata-only. ``recover_media`` returns only image URLs; the caller does the byte
    fetch via ``media_archive``'s injected fetcher + stores via ``media_store``.
    """
    name = "archive_today"
    NEWEST = "https://archive.ph/newest/{url}"
    # og:image meta (attribute-order agnostic) + inlined <img src>. archive.today stores
    # images on its own CDN (archive.ph/<id>/...) or proxies the original host.
    _OG_IMAGE = re.compile(r'<meta\b[^>]*property=["\']og:image["\'][^>]*>', re.I)
    _OG_TITLE = re.compile(r'<meta\b[^>]*property=["\']og:title["\'][^>]*>', re.I)
    _CONTENT = re.compile(r'content=["\']([^"\']+)["\']', re.I)
    _IMG_SRC = re.compile(r'<img\b[^>]*\bsrc=["\']([^"\']+)["\']', re.I)

    def __init__(self, user_agent, *, min_interval: float = 2.0, sleep=time.sleep,
                 fetch_html=None, max_retries: int = 2):
        self.user_agent = user_agent
        self.min_interval = min_interval
        self._sleep = sleep
        self._fetch_html = fetch_html or self._default_fetch_html
        self.max_retries = max_retries
        self._made_request = False  # throttle flag: space successive snapshot lookups

    def _default_fetch_html(self, url, *, timeout: float = 20.0) -> str:
        """GET ``url`` → HTML text. Cloudflare challenge pages surface as 403/429 → ArchiveError.
        Reuses the shared transport (which already honors Retry-After on 429)."""
        try:
            _status, _headers, raw = _http.request(
                url, method="GET",
                headers={"User-Agent": self.user_agent, "Accept": "text/html"},
                timeout=timeout, retries=self.max_retries, sleep=self._sleep,
            )
        except _http.HttpError as e:
            raise ArchiveError(f"HTTP error for {url}: {e}", status=e.status,
                               retry_after=e.retry_after) from e
        return raw.decode("utf-8", errors="replace")

    def _snapshot_url(self, original_url: str) -> str:
        """``archive.ph/newest/<url>`` redirects to the latest snapshot. Quoted so a URL with
        query params doesn't break the path."""
        return self.NEWEST.format(url=urllib.parse.quote(original_url, safe=""))

    def recover_media(self, item: dict, *, want_gallery: bool = True) -> list:
        """Resolve the image URLs a snapshot holds for one reddit item.

        Returns ``[{"url": <snapshot_img_url>, "title": <og:title or "">}]`` ordered as in
        the snapshot (og:image first, then inlined ``<img>``s), de-duped. The CALLER fetches
        the actual bytes via ``media_archive``'s injected fetcher and stores them via
        ``media_store`` — this method only resolves WHICH URLs exist, keeping it cheap and
        fully testable without real network.

        Returns ``[]`` when the item has no original media URL to look up, no snapshot
        exists, the snapshot has no recoverable images, or any network/Cloudflare error
        (loud-fail tolerant: a blocked snapshot is a soft miss, not a crash).
        """
        urls = self._item_image_urls(item, want_gallery=want_gallery)
        if not urls:
            return []
        results = []
        for orig in urls:
            if self._made_request and self.min_interval > 0:
                self._sleep(self.min_interval)
            try:
                html_text = self._fetch_html(self._snapshot_url(orig))
            except ArchiveError:
                self._made_request = True
                continue  # this image had no snapshot / was Cloudflare-blocked → skip it
            self._made_request = True
            results.extend(self._extract_images(html_text))
        return results

    # -- helpers -------------------------------------------------------------
    @staticmethod
    def _item_image_urls(item: dict, *, want_gallery: bool = True) -> list:
        """The original image URLs to look up on archive.today, from the item's media
        metadata. Prefers the direct ``media_url``; galleries add each frame. These are the
        URLs that were 404 (gone) — archive.today may have snapshotted them while live."""
        md = item.get("metadata") or {}
        if isinstance(md, str):
            md = json.loads(md) if md else {}
        out = []
        u = md.get("media_url") or ""
        if u and u.startswith("http"):
            out.append(u)
        if want_gallery:
            out += [g for g in (md.get("gallery") or [])
                    if isinstance(g, str) and g.startswith("http")]
        seen: set = set()
        return [x for x in out if not (x in seen or seen.add(x))]

    def _extract_images(self, html_text: str) -> list:
        """From a snapshot's HTML, the candidate image URLs it holds.

        Prefer og:image (the canonical hero image); fall back to inlined ``<img src>``s.
        Carries the og:title as an informational hint (PullPush/Arctic own the real title
        recovery, so it's only attached for completeness, not written by the service)."""
        html_text = html_text or ""
        title = ""
        tm = self._OG_TITLE.search(html_text)
        if tm:
            cm = self._CONTENT.search(tm.group(0))
            if cm:
                title = html.unescape(cm.group(1)).strip()

        out = []
        om = self._OG_IMAGE.search(html_text)
        if om:
            cm = self._CONTENT.search(om.group(0))
            if cm:
                out.append(html.unescape(cm.group(1)))
        out += (html.unescape(m.group(1)) for m in self._IMG_SRC.finditer(html_text))

        seen: set = set()
        uniq = []
        for cand in out:
            cand = cand.strip()
            if cand.startswith("http") and cand not in seen:
                seen.add(cand)
                uniq.append({"url": cand, "title": title})
        return uniq


def default_providers(user_agent, *, throttle: bool = True, order=("pullpush", "arctic")):
    """Build providers in priority order. ``throttle`` enables rate-limit spacing for
    bulk hydration; pass throttle=False for snappy single on-demand fetches."""
    factories = {
        "pullpush": lambda: PullPushProvider(user_agent, min_interval=4.0 if throttle else 0.0),
        "arctic": lambda: ArcticShiftProvider(user_agent, min_interval=0.4 if throttle else 0.0),
    }
    return [factories[name]() for name in order if name in factories]


def default_media_providers(user_agent, *, throttle: bool = True):
    """archive.today media-byte recovery provider (last-resort bytes). ``throttle`` spaces
    successive snapshot lookups; pass ``throttle=False`` for a snappy single on-demand fetch."""
    return [ArchiveTodayProvider(user_agent, min_interval=2.0 if throttle else 0.0)]
