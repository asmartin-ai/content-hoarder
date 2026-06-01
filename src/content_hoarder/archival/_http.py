"""Tiny stdlib HTTP GET helper for archive providers.

Optional, removable feature (network-only). No authentication, no third-party
libraries — just urllib with a User-Agent, a timeout, and structured errors so
providers can implement 429 backoff. Ported from reddit-saved-manager.
"""
import json
import urllib.error
import urllib.request


class ArchiveError(Exception):
    """Raised on any non-success HTTP / network / decode condition.

    ``status`` is the HTTP status code (when available) so callers can special-case
    429 (rate limited); ``retry_after`` carries the Retry-After header if present.
    """

    def __init__(self, message: str, status: int = None, retry_after=None):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


def get_json(url: str, user_agent: str, timeout: float = 20.0):
    """GET ``url`` and parse JSON. Returns (status, headers_dict, parsed_json).

    Raises ArchiveError on HTTP errors, network failures, or invalid JSON.
    """
    req = urllib.request.Request(
        url,
        headers={"User-Agent": user_agent, "Accept": "application/json"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            headers = dict(resp.headers)
            status = getattr(resp, "status", 200) or 200
    except urllib.error.HTTPError as e:
        retry_after = e.headers.get("Retry-After") if e.headers else None
        raise ArchiveError(
            f"HTTP {e.code} for {url}", status=e.code, retry_after=retry_after
        ) from e
    except urllib.error.URLError as e:
        raise ArchiveError(f"network error for {url}: {e.reason}") from e
    # Read timeouts surface as socket.timeout (TimeoutError, an OSError subclass) and
    # do NOT go through URLError — catch them so a stall can't escape unwrapped.
    except (TimeoutError, OSError) as e:
        raise ArchiveError(f"connection error for {url}: {e}") from e

    try:
        return status, headers, json.loads(raw)
    except json.JSONDecodeError as e:
        raise ArchiveError(f"invalid JSON from {url}: {e}") from e
