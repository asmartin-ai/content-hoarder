"""Offline tests for the read-only Reddit OAuth transport (reddit_oauth) + its wiring into
hydrate_one. No real network: the token endpoint (post=) and the bearer GET (_http opener) are
injected, and time is passed in via now= so token-expiry logic is deterministic."""

import urllib.error
import urllib.parse

import pytest

from content_hoarder import _http, db, models, reddit_oauth, reddit_unsave as ru
from content_hoarder.reddit_hydrate import hydrate_one


# ---------- authorize URL + redirect parsing ----------

def test_build_authorize_url_has_required_params():
    url = reddit_oauth.build_authorize_url(state="ST", client_id_="CID",
                                           redirect_uri_="redreader://rr_oauth_redir")
    assert url.startswith(reddit_oauth.AUTHORIZE_URL + "?")
    q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
    assert q == {"client_id": "CID", "response_type": "code", "state": "ST",
                 "redirect_uri": "redreader://rr_oauth_redir",
                 "duration": "permanent", "scope": "read"}


def test_build_authorize_url_requires_client_id(monkeypatch):
    monkeypatch.setattr(reddit_oauth, "client_id", lambda: "")
    with pytest.raises(reddit_oauth.RedditOAuthError):
        reddit_oauth.build_authorize_url(state="ST")


def test_parse_redirect_full_url():
    code = reddit_oauth.parse_redirect(
        "redreader://rr_oauth_redir?state=ST&code=THE_CODE", expected_state="ST")
    assert code == "THE_CODE"


def test_parse_redirect_query_only_and_raw_code():
    assert reddit_oauth.parse_redirect("state=ST&code=C2", expected_state="ST") == "C2"
    assert reddit_oauth.parse_redirect("RAWCODE", expected_state="ST") == "RAWCODE"


def test_parse_redirect_state_mismatch_raises():
    with pytest.raises(reddit_oauth.RedditOAuthError):
        reddit_oauth.parse_redirect("x://y?state=BAD&code=C", expected_state="ST")


def test_parse_redirect_error_param_raises():
    with pytest.raises(reddit_oauth.RedditOAuthError):
        reddit_oauth.parse_redirect("x://y?error=access_denied&state=ST", expected_state="ST")


def test_parse_redirect_rejects_urlish_without_code():
    # a mis-pasted URL with no code must fail early, not get sent verbatim as the "code"
    with pytest.raises(reddit_oauth.RedditOAuthError):
        reddit_oauth.parse_redirect("https://www.example.com/oops", expected_state="ST")


# ---------- token exchange / refresh (injected post) ----------

def _post_returning(resp):
    calls = []

    def post(url, fields, *, client_id):
        calls.append({"url": url, "fields": fields, "client_id": client_id})
        return resp

    return post, calls


def test_exchange_code_posts_authorization_grant():
    post, calls = _post_returning({"access_token": "AT", "refresh_token": "RT"})
    out = reddit_oauth.exchange_code("CODE", client_id_="CID",
                                     redirect_uri_="redreader://rr_oauth_redir", post=post)
    assert out["refresh_token"] == "RT"
    assert calls[0]["fields"] == {"grant_type": "authorization_code", "code": "CODE",
                                  "redirect_uri": "redreader://rr_oauth_redir"}
    assert calls[0]["client_id"] == "CID"


def test_refresh_posts_refresh_grant():
    post, calls = _post_returning({"access_token": "AT2"})
    out = reddit_oauth.refresh_access_token("RT", client_id_="CID", post=post)
    assert out["access_token"] == "AT2"
    assert calls[0]["fields"] == {"grant_type": "refresh_token", "refresh_token": "RT"}


# ---------- token storage + access_token lifecycle ----------

def test_not_configured_until_refresh_token_stored(conn):
    assert reddit_oauth.is_configured(conn) is False
    assert reddit_oauth.access_token(conn) is None
    reddit_oauth._store(conn, refresh_token="RT", access_token="AT")
    assert reddit_oauth.is_configured(conn) is True


def test_access_token_returns_cached_when_fresh(conn):
    reddit_oauth._store(conn, refresh_token="RT", access_token="AT", now=1000)

    def boom(*a, **k):
        raise AssertionError("must not refresh a still-fresh token")

    assert reddit_oauth.access_token(conn, post=boom, now=1000) == "AT"


def test_access_token_refreshes_when_expired(conn):
    reddit_oauth._store(conn, refresh_token="RT", access_token="old", now=1000)
    post, _calls = _post_returning({"access_token": "new"})
    later = 1000 + reddit_oauth._ACCESS_TTL          # past the skew window
    assert reddit_oauth.access_token(conn, post=post, now=later) == "new"
    assert reddit_oauth._row(conn)["access_token"] == "new"   # persisted for reuse


def test_access_token_none_on_permanent_refresh_failure(conn):
    reddit_oauth._store(conn, refresh_token="RT", access_token="old", now=1000)

    def revoked(*a, **k):
        raise reddit_oauth.RedditOAuthError("grant revoked")

    later = 1000 + reddit_oauth._ACCESS_TTL
    assert reddit_oauth.access_token(conn, post=revoked, now=later) is None


def test_access_token_reuses_cached_on_transient_failure(conn):
    reddit_oauth._store(conn, refresh_token="RT", access_token="old", now=1000)

    def flaky(*a, **k):
        raise ru.RedditNetworkError("boom")

    later = 1000 + reddit_oauth._ACCESS_TTL
    assert reddit_oauth.access_token(conn, post=flaky, now=later) == "old"


def test_store_preserves_refresh_and_username(conn):
    reddit_oauth._store(conn, refresh_token="RT", access_token="A1", username="me", now=1)
    reddit_oauth._store(conn, access_token="A2", now=2)          # refresh-only update
    row = reddit_oauth._row(conn)
    assert (row["access_token"], row["refresh_token"], row["username"]) == ("A2", "RT", "me")


# ---------- login (exchange + username + store) ----------

def test_login_stores_tokens_and_username(conn):
    post, _ = _post_returning({"access_token": "AT", "refresh_token": "RT"})
    res = reddit_oauth.login(conn, "x://y?state=ST&code=C", expected_state="ST",
                             post=post, getf=lambda *a, **k: {"name": "alice"}, now=5)
    assert res == "alice"
    assert reddit_oauth.is_configured(conn)
    assert reddit_oauth._row(conn)["username"] == "alice"


def test_login_missing_refresh_token_raises(conn):
    post, _ = _post_returning({"access_token": "AT"})            # no refresh_token
    with pytest.raises(reddit_oauth.RedditOAuthError):
        reddit_oauth.login(conn, "RAWCODE", expected_state="ST", post=post,
                           getf=lambda *a, **k: {})


# ---------- oauth_get (bearer GET) error mapping ----------

class _Resp:
    def __init__(self, status=200, headers=None, body=b""):
        self.status, self.headers, self._b = status, headers or {}, body

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _herror(code, headers=None):
    return urllib.error.HTTPError(url="http://x", code=code, msg="e",
                                  hdrs=(headers or {}), fp=None)


def _install_opener(monkeypatch, fn):
    calls = []

    def urlopen(req, timeout=None):
        calls.append(req)
        r = fn(req, len(calls) - 1)
        if isinstance(r, BaseException):
            raise r
        return r

    monkeypatch.setattr(_http, "_opener", lambda: urlopen)
    return calls


def test_oauth_get_success_parses_json(monkeypatch):
    _install_opener(monkeypatch, lambda req, n: _Resp(status=200, body=b'{"a": 1}'))
    assert reddit_oauth.oauth_get("http://x", bearer="AT", user_agent="ua") == {"a": 1}


def test_oauth_get_sends_bearer_header(monkeypatch):
    calls = _install_opener(monkeypatch, lambda req, n: _Resp(body=b"{}"))
    reddit_oauth.oauth_get("http://x", bearer="AT", user_agent="ua")
    assert calls[0].get_header("Authorization") == "bearer AT"


def test_oauth_get_401_returns_empty(monkeypatch):
    calls = _install_opener(monkeypatch, lambda req, n: _herror(401))
    out = reddit_oauth.oauth_get("http://x", bearer="AT", user_agent="ua", sleep=lambda s: None)
    assert out == {} and len(calls) == 1        # auth failure is terminal, no retry


def test_oauth_get_404_raises_not_found(monkeypatch):
    _install_opener(monkeypatch, lambda req, n: _herror(404))
    with pytest.raises(ru.RedditNotFoundError):
        reddit_oauth.oauth_get("http://x", bearer="AT", user_agent="ua", sleep=lambda s: None)


def test_oauth_get_429_exhausts_to_network_error(monkeypatch):
    calls = _install_opener(monkeypatch, lambda req, n: _herror(429))
    slept = []
    with pytest.raises(ru.RedditNetworkError):
        reddit_oauth.oauth_get("http://x", bearer="AT", user_agent="ua", sleep=slept.append)
    assert len(calls) == 5 and len(slept) == 4


# ---------- transport selection in hydrate_one ----------

_BLOB = [{"data": {"children": [{"data": {"id": "o"}}]}},
         {"data": {"children": [{"data": {"id": "c1"}}]}}]


def _seed(conn, sid="t3_o", permalink="/r/test/comments/o/x/"):
    db.merge_upsert(conn, models.new_item(
        source="reddit", source_id=sid, kind="post", metadata={"permalink": permalink}))


def test_hydrate_one_prefers_oauth_when_configured(conn, monkeypatch):
    _seed(conn)
    ru.set_auth(conn, session_cookie="ck", modhash="m")                  # cookie present (fallback)
    reddit_oauth._store(conn, refresh_token="RT", access_token="AT", username="me")  # fresh token
    captured = {}

    def fake_oauth_get(url, *, bearer, user_agent):
        captured.update(url=url, bearer=bearer, ua=user_agent)
        return _BLOB

    monkeypatch.setattr(reddit_oauth, "oauth_get", fake_oauth_get)
    res = hydrate_one(conn, "reddit:t3_o")
    assert res["status"] == "hydrated"
    assert captured["url"] == "https://oauth.reddit.com/r/test/comments/o/x/.json?raw_json=1"
    assert captured["bearer"] == "AT"
    assert captured["ua"].startswith("windows:content-hoarder:")          # compliant OAuth UA


def test_injected_getf_forces_cookie_path_even_if_oauth_configured(conn):
    _seed(conn)
    ru.set_auth(conn, session_cookie="ck", modhash="m")
    reddit_oauth._store(conn, refresh_token="RT", access_token="AT")
    captured = {}

    def fake_getf(url, *, session_cookie, user_agent):
        captured["url"] = url
        return _BLOB

    res = hydrate_one(conn, "reddit:t3_o", getf=fake_getf)
    assert res["status"] == "hydrated"
    assert captured["url"].startswith("https://www.reddit.com/")          # cookie host, not oauth
