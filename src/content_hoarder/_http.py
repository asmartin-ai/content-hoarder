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

import time
import urllib.error
import urllib.request


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


def _opener():
    """Indirection seam so tests can monkeypatch the urlopen call without real network."""
    return urllib.request.urlopen


def request(url, *, method="GET", headers=None, data=None, timeout=20.0,
            retries=0, backoff=2.0, sleep=time.sleep, user_agent=None
            ) -> tuple[int, dict, bytes]:
    """GET/POST ``url`` and return ``(status, headers_dict, raw_bytes)``.

    On success the status is ``resp.status`` (defaulting to 200), ``headers_dict`` is
    ``dict(resp.headers)``, and ``raw_bytes`` is the undecoded body — adapters decode
    or JSON-parse as they see fit.

    Raises :class:`HttpError` on an HTTP error status, a URL/transport error, or a
    read timeout. When ``retries > 0``, a 429 or 5xx response is retried up to
    ``retries`` extra times with a ``Retry-After``-aware exponential backoff (header
    value if numeric, else ``backoff`` doubled each attempt); the final failure still
    raises ``HttpError`` carrying the last status / Retry-After / headers.
    """
    req_headers = dict(headers or {})
    if user_agent is not None:
        req_headers.setdefault("User-Agent", user_agent)
    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)

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
                sleep(ra if ra is not None else delay)
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
