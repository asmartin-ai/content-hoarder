"""Offline unit tests for the shared transport primitive (content_hoarder._http).

No real network: the urlopen seam (``_http._opener``) is monkeypatched to a fake
that returns canned responses or raises urllib errors. ``retry_after_seconds`` is
exercised purely.
"""

import urllib.error

import pytest

from content_hoarder import _http


# --------------------------------------------------------------------------
# retry_after_seconds — pure, no network
# --------------------------------------------------------------------------

def test_retry_after_numeric():
    assert _http.retry_after_seconds({"Retry-After": "7"}) == 7.0


def test_retry_after_case_insensitive():
    assert _http.retry_after_seconds({"retry-after": "12"}) == 12.0
    assert _http.retry_after_seconds({"RETRY-AFTER": "3"}) == 3.0


def test_retry_after_absent_or_empty():
    assert _http.retry_after_seconds({}) is None
    assert _http.retry_after_seconds(None) is None
    assert _http.retry_after_seconds({"X-Other": "9"}) is None
    assert _http.retry_after_seconds({"Retry-After": ""}) is None


def test_retry_after_http_date_is_none():
    # RFC 7231 HTTP-date form is non-numeric -> caller falls back to its own delay.
    assert _http.retry_after_seconds({"Retry-After": "Fri, 31 Dec 1999 23:59:59 GMT"}) is None


def test_retry_after_negative_is_none():
    assert _http.retry_after_seconds({"Retry-After": "-5"}) is None


def test_retry_after_zero_is_zero():
    assert _http.retry_after_seconds({"Retry-After": "0"}) == 0.0


# --------------------------------------------------------------------------
# Fake opener plumbing
# --------------------------------------------------------------------------

class _FakeResp:
    def __init__(self, *, status=200, headers=None, body=b""):
        self.status = status
        self.headers = headers or {}
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _http_error(code, *, headers=None, body=b""):
    return urllib.error.HTTPError(
        url="http://x", code=code, msg="err", hdrs=(headers or {}), fp=None
    )


def _install_opener(monkeypatch, fn):
    """Capture the urllib Request and drive responses via ``fn(req, attempt)``."""
    calls = []

    def fake_urlopen(req, timeout=None):
        calls.append((req, timeout))
        result = fn(req, len(calls) - 1)
        if isinstance(result, BaseException):
            raise result
        return result

    monkeypatch.setattr(_http, "_opener", lambda: fake_urlopen)
    return calls


# --------------------------------------------------------------------------
# request — success path
# --------------------------------------------------------------------------

def test_request_success_returns_triple(monkeypatch):
    _install_opener(monkeypatch, lambda req, n: _FakeResp(
        status=200, headers={"Content-Type": "application/json"}, body=b'{"ok":1}'))
    status, headers, raw = _http.request("http://x")
    assert status == 200
    assert headers == {"Content-Type": "application/json"}
    assert raw == b'{"ok":1}'


def test_request_status_defaults_to_200_when_missing(monkeypatch):
    class _NoStatus(_FakeResp):
        def __init__(self):
            super().__init__(body=b"hi")
            del self.status  # getattr fallback -> 200
    _install_opener(monkeypatch, lambda req, n: _NoStatus())
    status, _h, raw = _http.request("http://x")
    assert status == 200 and raw == b"hi"


def test_request_injects_user_agent_and_passes_method_data(monkeypatch):
    calls = _install_opener(monkeypatch, lambda req, n: _FakeResp(body=b""))
    _http.request("http://x", method="POST", data=b"payload",
                  headers={"Accept": "application/json"}, user_agent="UA/1")
    req = calls[0][0]
    assert req.get_method() == "POST"
    assert req.data == b"payload"
    assert req.get_header("User-agent") == "UA/1"          # urllib title-cases header keys
    assert req.get_header("Accept") == "application/json"


def test_request_explicit_user_agent_header_not_overridden(monkeypatch):
    calls = _install_opener(monkeypatch, lambda req, n: _FakeResp(body=b""))
    # setdefault: an explicit UA header wins over the user_agent kwarg.
    _http.request("http://x", headers={"User-Agent": "Explicit"}, user_agent="Kwarg")
    assert calls[0][0].get_header("User-agent") == "Explicit"


def test_request_passes_timeout(monkeypatch):
    calls = _install_opener(monkeypatch, lambda req, n: _FakeResp(body=b""))
    _http.request("http://x", timeout=3.5)
    assert calls[0][1] == 3.5


# --------------------------------------------------------------------------
# request — error mapping (no retries)
# --------------------------------------------------------------------------

def test_request_http_error_maps_to_httperror(monkeypatch):
    _install_opener(monkeypatch, lambda req, n: _http_error(
        404, headers={"Retry-After": "9"}))
    with pytest.raises(_http.HttpError) as ei:
        _http.request("http://x")
    err = ei.value
    assert err.status == 404
    assert err.kind == "http"
    assert err.retry_after == 9.0
    assert err.headers.get("Retry-After") == "9"


def test_request_urlerror_maps_to_httperror(monkeypatch):
    _install_opener(monkeypatch, lambda req, n: urllib.error.URLError("refused"))
    with pytest.raises(_http.HttpError) as ei:
        _http.request("http://x")
    err = ei.value
    assert err.status is None
    assert err.kind == "url"
    assert "refused" in str(err.reason)


def test_request_timeout_maps_to_conn(monkeypatch):
    _install_opener(monkeypatch, lambda req, n: TimeoutError("timed out"))
    with pytest.raises(_http.HttpError) as ei:
        _http.request("http://x")
    err = ei.value
    assert err.status is None
    assert err.kind == "conn"
    assert isinstance(err.__cause__, TimeoutError)


def test_request_no_retries_does_not_retry_429(monkeypatch):
    calls = _install_opener(monkeypatch, lambda req, n: _http_error(429))
    with pytest.raises(_http.HttpError):
        _http.request("http://x")  # retries=0 default
    assert len(calls) == 1


# --------------------------------------------------------------------------
# request — retry behavior
# --------------------------------------------------------------------------

def test_request_retries_429_then_succeeds(monkeypatch):
    def fn(req, n):
        if n == 0:
            return _http_error(429, headers={"Retry-After": "5"})
        return _FakeResp(status=200, body=b"done")
    calls = _install_opener(monkeypatch, fn)
    slept = []
    status, _h, raw = _http.request("http://x", retries=2, sleep=slept.append)
    assert status == 200 and raw == b"done"
    assert len(calls) == 2
    assert slept == [5.0]  # honored Retry-After, not the backoff default


def test_request_retries_5xx_uses_backoff_when_no_retry_after(monkeypatch):
    def fn(req, n):
        if n < 2:
            return _http_error(503)
        return _FakeResp(status=200, body=b"ok")
    calls = _install_opener(monkeypatch, fn)
    slept = []
    status, _h, _raw = _http.request("http://x", retries=3, backoff=2.0, sleep=slept.append)
    assert status == 200 and len(calls) == 3
    assert slept == [2.0, 4.0]  # exponential doubling


def test_request_retries_exhausted_raises_last(monkeypatch):
    calls = _install_opener(monkeypatch, lambda req, n: _http_error(429, headers={"Retry-After": "1"}))
    slept = []
    with pytest.raises(_http.HttpError) as ei:
        _http.request("http://x", retries=2, sleep=slept.append)
    assert ei.value.status == 429
    assert len(calls) == 3        # initial + 2 retries
    assert slept == [1.0, 1.0]    # slept before each retry, not after the final failure


def test_request_4xx_other_than_429_not_retried(monkeypatch):
    calls = _install_opener(monkeypatch, lambda req, n: _http_error(404))
    with pytest.raises(_http.HttpError) as ei:
        _http.request("http://x", retries=5, sleep=lambda s: None)
    assert ei.value.status == 404
    assert len(calls) == 1        # 404 is terminal, no retry


# --------------------------------------------------------------------------
# jitter helpers (de-risking §A/§B) — pure, no network
# --------------------------------------------------------------------------

def test_full_jitter_delay_scales_and_caps():
    # full jitter = rng() * min(cap, base * 2**attempt)
    assert _http.full_jitter_delay(1.0, 0, rng=lambda: 0.5) == 0.5
    assert _http.full_jitter_delay(1.0, 1, rng=lambda: 0.5) == 1.0
    assert _http.full_jitter_delay(1.0, 3, rng=lambda: 1.0) == 8.0
    assert _http.full_jitter_delay(1.0, 10, cap=60.0, rng=lambda: 1.0) == 60.0  # capped
    assert _http.full_jitter_delay(1.0, 0, rng=lambda: 0.0) == 0.0


def test_jittered_throttle_band():
    # base*(0.75 + rng()) -> [0.75*base, 1.75*base)
    assert _http.jittered_throttle(2.0, rng=lambda: 0.0) == 1.5
    assert _http.jittered_throttle(2.0, rng=lambda: 0.5) == 2.5
    assert _http.jittered_throttle(1.0, rng=lambda: 0.0) == 0.75
    import random
    random.seed(1)
    for _ in range(50):                       # default rng stays in the documented band
        assert 1.5 <= _http.jittered_throttle(2.0) < 3.5


def test_request_jitter_backoff_when_no_retry_after(monkeypatch):
    calls = _install_opener(monkeypatch, lambda req, n: _http_error(429))  # 429, no Retry-After
    slept = []
    with pytest.raises(_http.HttpError) as ei:
        _http.request("http://x", retries=3, backoff=1.0, jitter=True,
                      sleep=slept.append, rng=lambda: 0.5)
    assert ei.value.status == 429
    assert len(calls) == 4                    # initial + 3 retries
    assert slept == [0.5, 1.0, 2.0]           # full jitter: 0.5*1, 0.5*2, 0.5*4


def test_request_jitter_still_honors_retry_after(monkeypatch):
    def fn(req, n):
        if n == 0:
            return _http_error(429, headers={"Retry-After": "5"})
        return _FakeResp(status=200, body=b"ok")
    _install_opener(monkeypatch, fn)
    slept = []
    status, _h, _raw = _http.request("http://x", retries=2, jitter=True,
                                     sleep=slept.append, rng=lambda: 0.5)
    assert status == 200
    assert slept == [5.0]                      # Retry-After is authoritative, beats jitter


def test_request_non_jitter_backoff_unchanged(monkeypatch):
    # Regression guard: jitter defaults off -> exponential doubling, byte-identical to before.
    def fn(req, n):
        if n < 2:
            return _http_error(503)
        return _FakeResp(status=200, body=b"ok")
    _install_opener(monkeypatch, fn)
    slept = []
    _http.request("http://x", retries=3, backoff=2.0, sleep=slept.append)
    assert slept == [2.0, 4.0]
