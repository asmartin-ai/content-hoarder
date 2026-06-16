"""One shared stdlib HTTP transport primitive for every network caller.

No third-party libraries — just ``urllib`` with a User-Agent, a timeout, optional
``Retry-After``-aware backoff, and a single structured error type. Each caller keeps
its own thin adapter (with its own return shape and error policy) on top of
:func:`request`; this module only owns the transport mechanics and the
``Retry-After`` parsing they all used to hand-roll.

Lives at the top level (sibling to ``config.py``) on purpose: the archival feature
is "optional/removable", but reddit/youtube/karakeep all depend on this primitive,
so it must not sit under ``archival/``.
"""

from __future__ import annotations

import random
import time
import urllib.error
import urllib.parse
import urllib.request

_RETRY_JITTER_CAP = 60.0  # seconds; full-jitter backoff never waits longer than this

# Global rate cap: never pace inter-request gaps faster than this, even if a caller passes a
# tiny throttle. ~0.6s ≈ Reddit's authenticated 100 QPM budget; the real defaults (drain 1.0s,
# hydrate 2.0s) sit far above it, so this only guards against misconfiguration.
MIN_THROTTLE = 0.6


class HttpError(Exception):
    """Raised by :func:`request` on any non-success HTTP / network / transport condition.

    ``status`` is the HTTP status code when the failure was an HTTP error response
    (None for a transport-level failure — DNS, refused connection, read timeout).
    ``retry_after`` is the parsed numeric ``Retry-After`` (seconds) when present.
    ``headers`` carries the response headers as a plain dict when available (so a
    caller that treats HTTP errors as data — e.g. reddit's POST helper — can recover
    them). ``kind`` discriminates the original failure class for callers that
    reconstruct branch-specific messages: ``"http"`` (HTTPError), ``"url"``
    (URLError), or ``"conn"`` (timeout / other OSError). ``reason`` mirrors
    ``URLError.reason`` for the ``"url"`` kind.
    """

    def __init__(self, message, *, status=None, retry_after=None, headers=None,
                 kind=None, reason=None):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after
        self.headers = headers if headers is not None else {}
        self.kind = kind
        self.reason = reason


def retry_after_seconds(headers) -> float | None:
    """Numeric ``Retry-After`` value from a (case-insensitively searched) header dict.

    None when absent or non-numeric (e.g. an RFC 7231 HTTP-date) — the caller falls
    back to its own backoff delay. Case-insensitive because the headers arrive as a
    plain dict (``dict(resp.headers)``) with whatever casing the server sent. A
    negative value is treated as absent.
    """
    if not headers:
        return None
    ra = next((v for k, v in headers.items() if k.lower() == "retry-after"), None)
    if not ra:
        return None
    try:
        seconds = float(ra)
    except (TypeError, ValueError):
        return None
    return seconds if seconds >= 0 else None


def full_jitter_delay(base: float, attempt: int, *, cap: float = _RETRY_JITTER_CAP,
                      rng=random.random) -> float:
    """AWS "full jitter" backoff: a uniform random wait in ``[0, min(cap, base * 2**attempt)]``.

    Lowest upstream load / no thundering herd — we optimize for being polite to the server,
    not for our own completion time. ``attempt`` is 0-based; ``rng`` (default
    ``random.random``) is injectable so tests stay deterministic.
    """
    return rng() * min(cap, base * (2 ** attempt))


def jittered_throttle(base: float, *, rng=random.random) -> float:
    """A steady-state politeness delay jittered around ``base`` — uniform in
    ``[0.75*base, 1.75*base)`` so no two successive gaps are identical (kills the
    exact-interval bot fingerprint). For ``base=2.0`` this is the de-risking spec's
    ``uniform(1.5, 3.5)``. ``rng`` injectable for deterministic tests.
    """
    return base * (0.75 + rng())


def _opener():
    """Indirection seam so tests can monkeypatch the urlopen call without real network."""
    return urllib.request.urlopen


def _ascii_safe_url(url: str) -> str:
    """Percent-encode a URL's path + query so urllib can send it.

    ``http.client`` encodes the request line as ASCII and raises ``UnicodeEncodeError`` on any
    non-ASCII char in the URL — e.g. a unicode slug in a legacy Reddit permalink
    (``/r/x/comments/abc/café/``). We transform the URL **only when it isn't already ASCII**, so
    every existing (ASCII) URL is returned byte-for-byte unchanged and no current behavior moves.
    The broad ``safe`` sets include ``%``, preserving any pre-existing ``%xx`` escapes (no
    double-encoding) and the query's ``=&`` structure. The host is assumed ASCII (true for our
    endpoints); a non-ASCII host would need IDNA, which no caller hits."""
    try:
        url.encode("ascii")
        return url                       # common case: already ASCII -> unchanged
    except UnicodeEncodeError:
        p = urllib.parse.urlsplit(url)
        path = urllib.parse.quote(p.path, safe="/%:@-._~!$&'()*+,;=")
        query = urllib.parse.quote(p.query, safe="=&%:@-._~!$'()*+,;/?")
        return urllib.parse.urlunsplit((p.scheme, p.netloc, path, query, p.fragment))


def request(url, *, method="GET", headers=None, data=None, timeout=20.0,
            retries=0, backoff=2.0, sleep=time.sleep, user_agent=None,
            jitter=False, rng=random.random) -> tuple[int, dict, bytes]:
    """GET/POST ``url`` and return ``(status, headers_dict, raw_bytes)``.

    On success the status is ``resp.status`` (defaulting to 200), ``headers_dict`` is
    ``dict(resp.headers)``, and ``raw_bytes`` is the undecoded body — adapters decode
    or JSON-parse as they see fit.

    Raises :class:`HttpError` on an HTTP error status, a URL/transport error, or a
    read timeout. When ``retries > 0``, a 429 or 5xx response is retried up to
    ``retries`` extra times: a numeric ``Retry-After`` is always honored exactly;
    otherwise the wait is ``backoff`` doubled each attempt, or — when ``jitter=True`` —
    AWS full-jitter (:func:`full_jitter_delay`, the lower-load default). The final
    failure still raises ``HttpError`` carrying the last status / Retry-After / headers.
    """
    req_headers = dict(headers or {})
    if user_agent is not None:
        req_headers.setdefault("User-Agent", user_agent)
    req = urllib.request.Request(_ascii_safe_url(url), data=data, headers=req_headers,
                                 method=method)

    delay = backoff
    for attempt in range(retries + 1):
        try:
            with _opener()(req, timeout=timeout) as resp:
                raw = resp.read()
                resp_headers = dict(resp.headers)
                status = getattr(resp, "status", 200) or 200
                return status, resp_headers, raw
        except urllib.error.HTTPError as e:
            resp_headers = dict(e.headers or {})
            ra = retry_after_seconds(resp_headers)
            if attempt < retries and (e.code == 429 or 500 <= e.code < 600):
                if ra is not None:
                    sleep(ra)                                   # authoritative — honor exactly
                elif jitter:
                    sleep(full_jitter_delay(backoff, attempt, rng=rng))
                else:
                    sleep(delay)
                delay *= 2
                continue
            raise HttpError(
                f"HTTP {e.code} for {url}", status=e.code, retry_after=ra,
                headers=resp_headers, kind="http",
            ) from e
        except urllib.error.URLError as e:
            # URLError is an OSError subclass; catch it before the generic OSError
            # branch so a DNS/refused failure is tagged "url" (network reason) not "conn".
            raise HttpError(
                f"network error for {url}: {e.reason}", kind="url", reason=e.reason,
            ) from e
        # Read timeouts surface as socket.timeout (TimeoutError, an OSError subclass)
        # and do NOT go through URLError — catch them so a stall can't escape unwrapped.
        except (TimeoutError, OSError) as e:
            raise HttpError(f"connection error for {url}: {e}", kind="conn") from e
