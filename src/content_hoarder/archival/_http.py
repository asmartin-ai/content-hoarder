"""Tiny stdlib HTTP GET helper for archive providers.

Optional, removable feature (network-only). No authentication, no third-party
libraries — a thin JSON adapter over the shared ``content_hoarder._http.request``
transport, preserving the structured ``ArchiveError`` (with ``status``/``retry_after``)
that providers use for 429 backoff. Ported from reddit-saved-manager.
"""
import json

from content_hoarder import _http


class ArchiveError(Exception):
    """Raised on any non-success HTTP / network / decode condition.

    ``status`` is the HTTP status code (when available) so callers can special-case
    429 (rate limited); ``retry_after`` carries the parsed numeric Retry-After delay
    in seconds (None when absent, non-numeric, or negative).
    """

    def __init__(self, message: str, status: int = None, retry_after=None):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


def get_json(url: str, user_agent: str, timeout: float = 20.0):
    """GET ``url`` and parse JSON. Returns (status, headers_dict, parsed_json).

    Raises ArchiveError on HTTP errors, network failures, or invalid JSON.
    """
    try:
        status, headers, raw = _http.request(
            url,
            method="GET",
            headers={"User-Agent": user_agent, "Accept": "application/json"},
            timeout=timeout,
        )
    except _http.HttpError as e:
        # Preserve the original branch-specific message text and the status/retry_after
        # carry. retry_after is now the parsed numeric value (shared parser) rather than
        # the raw header string — see providers._request for the matching simplification.
        if e.kind == "http":
            raise ArchiveError(
                f"HTTP {e.status} for {url}", status=e.status, retry_after=e.retry_after
            ) from e
        if e.kind == "url":
            raise ArchiveError(f"network error for {url}: {e.reason}") from e
        raise ArchiveError(f"connection error for {url}: {e.__cause__}") from e

    try:
        return status, headers, json.loads(raw.decode("utf-8", errors="replace"))
    except json.JSONDecodeError as e:
        raise ArchiveError(f"invalid JSON from {url}: {e}") from e
