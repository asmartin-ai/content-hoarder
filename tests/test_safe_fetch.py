"""SSRF safe-fetch gate — test safe_fetch_url and default_fetch's URL gate."""

import pytest

from content_hoarder import media_archive
from content_hoarder._http import safe_fetch_url


# -------------------------------------------------------------------------- #
# safe_fetch_url
# -------------------------------------------------------------------------- #

@pytest.mark.parametrize(
    "url, expected_ok, expected_reason",
    [
        # Bad / non-HTTP schemes
        ("file:///etc/passwd", False, "bad_scheme"),
        ("gopher://x/abc", False, "bad_scheme"),
        # Empty / not a URL — urlparse returns empty scheme → "bad_scheme", which is fine
        ("", False, None),
        ("not a url", False, None),
        # Missing host
        ("http:///path", False, "no_host"),
        # Loopback IPs
        ("http://127.0.0.1/x", False, "blocked_host"),
        ("http://[::1]/x", False, "blocked_host"),
        ("http://localhost/x", False, "blocked_host"),
        ("http://localhost.localdomain/x", False, "blocked_host"),
        # Private IPs
        ("http://10.0.0.1/x", False, "blocked_host"),
        ("http://172.16.0.1/x", False, "blocked_host"),
        ("http://192.168.1.1/x", False, "blocked_host"),
        # Link-local / cloud-metadata
        ("http://169.254.169.254/latest/meta-data/", False, "blocked_host"),
        ("http://169.254.169.254/x", False, "blocked_host"),
        # SSRF bypass attempts via port / userinfo / IPv6-port — the gate must
        # NOT be fooled by netloc decoration (regression: an earlier impl used
        # parsed.netloc and let all of these through).
        ("http://127.0.0.1:80/x", False, "blocked_host"),
        ("http://127.0.0.1:1/x", False, "blocked_host"),
        ("http://[::1]:80/x", False, "blocked_host"),
        ("http://[::1]:1/x", False, "blocked_host"),
        ("http://user@127.0.0.1/x", False, "blocked_host"),
        ("http://user:pass@10.0.0.1/x", False, "blocked_host"),
        ("http://169.254.169.254:80/latest/meta-data/", False, "blocked_host"),
        ("http://attacker@169.254.169.254/x", False, "blocked_host"),
        # Public DNS names
        ("https://i.redd.it/abc.jpg", True, "ok"),
        ("https://example.com/path", True, "ok"),
        ("https://preview.redd.it/g1.jpg", True, "ok"),
        ("https://pbs.twimg.com/media/a.jpg?name=orig", True, "ok"),
    ],
)
def test_safe_fetch_url(url, expected_ok, expected_reason):
    ok, reason = safe_fetch_url(url)
    assert ok == expected_ok, f"url={url!r}: expected ok={expected_ok}, got ({ok}, {reason!r})"
    # None = accept any non-ok reason (for cases where both bad_scheme / bad_url are valid)
    if expected_reason is not None:
        assert reason == expected_reason, (
            f"url={url!r}: expected reason={expected_reason!r}, got {reason!r}"
        )


# -------------------------------------------------------------------------- #
# media_archive.default_fetch — SSRF gate (offline, runs BEFORE urlopen)
# -------------------------------------------------------------------------- #

def test_default_fetch_blocks_file_scheme():
    data, reason = media_archive.default_fetch("file:///etc/passwd")
    assert data is None
    assert reason.startswith("blocked_")


def test_default_fetch_blocks_cloud_metadata_ip():
    data, reason = media_archive.default_fetch("http://169.254.169.254/x")
    assert data is None
    assert reason.startswith("blocked_")


def test_default_fetch_does_not_block_normal_https():
    # Gate passes; the request will fail to connect in a sandbox, but the
    # reason must NOT be a blocked_ reason.
    data, reason = media_archive.default_fetch("https://i.redd.it/abc.jpg")
    # We only assert on the reason being clean — the network call may fail.
    assert not reason.startswith("blocked_"), f"unexpected blocked reason: {reason}"
