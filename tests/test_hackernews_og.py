"""HN article og:image thumbnail enrich (Epic 15 P3).

The pure parser (`_og_image`) and the fetch wrapper (`_fetch_og_image`, mocked at
the shared `_http.request` seam) are tested in isolation; `enrich()` is then driven
with both network seams stubbed so no real HTTP happens.
"""

import json

from content_hoarder import _http
from content_hoarder.connectors import hackernews as hn
from content_hoarder.connectors.hackernews import HNConnector


# ---- pure parser ---------------------------------------------------------

def test_og_image_prefers_og_over_twitter():
    html = (
        '<meta name="twitter:image" content="https://x.test/tw.png">'
        '<meta property="og:image" content="https://x.test/og.png">'
    )
    assert hn._og_image(html, "https://x.test/article") == "https://x.test/og.png"


def test_og_image_attribute_order_and_single_quotes():
    # content-before-property, single quotes — both must still parse.
    html = "<meta content='https://x.test/a.jpg' property='og:image'>"
    assert hn._og_image(html, "https://x.test/") == "https://x.test/a.jpg"


def test_og_image_resolves_relative_and_unescapes_entities():
    html = '<meta property="og:image" content="/img/p.png?a=1&amp;b=2">'
    got = hn._og_image(html, "https://news.example.com/story/123")
    assert got == "https://news.example.com/img/p.png?a=1&b=2"


def test_og_image_twitter_fallback():
    html = '<meta name="twitter:image:src" content="https://x.test/t.png">'
    assert hn._og_image(html, "https://x.test/") == "https://x.test/t.png"


def test_og_image_none():
    assert hn._og_image("<meta name='description' content='hi'>", "https://x.test/") == ""


# ---- fetch wrapper (mock the transport) ----------------------------------

def _stub_request(monkeypatch, *, status=200, ctype="text/html; charset=utf-8", body=b"", exc=None):
    def fake(url, **kw):
        if exc is not None:
            raise exc
        return status, {"Content-Type": ctype}, body
    monkeypatch.setattr(_http, "request", fake)


def test_fetch_og_image_happy(monkeypatch):
    _stub_request(monkeypatch, body=b'<html><head><meta property="og:image" content="https://x.test/og.png"></head><body>x</body></html>')
    assert HNConnector()._fetch_og_image("https://x.test/a") == "https://x.test/og.png"


def test_fetch_og_image_skips_non_html(monkeypatch):
    _stub_request(monkeypatch, ctype="application/pdf", body=b"%PDF-1.4 ...")
    assert HNConnector()._fetch_og_image("https://x.test/a.pdf") == ""


def test_fetch_og_image_swallows_http_error(monkeypatch):
    _stub_request(monkeypatch, exc=_http.HttpError("boom", status=404, kind="http"))
    assert HNConnector()._fetch_og_image("https://x.test/gone") == ""


# ---- enrich integration (both network seams stubbed) ---------------------

def test_enrich_attaches_og_image(monkeypatch):
    hnc = HNConnector()
    monkeypatch.setattr(hnc, "_fetch", lambda sid: {
        "type": "story", "title": "T", "url": "https://x.test/article", "by": "pg",
        "time": 1700000000, "score": 42,
    })
    monkeypatch.setattr(hnc, "_fetch_og_image", lambda url: "https://x.test/og.png")
    out = hnc.enrich([{"source_id": "1", "url": "https://x.test/article", "metadata": {}}])
    md = json.loads(out[0]["metadata"])
    assert md["og_image"] == "https://x.test/og.png"
    assert md["score"] == 42


def test_enrich_skips_og_fetch_when_already_present(monkeypatch):
    hnc = HNConnector()
    monkeypatch.setattr(hnc, "_fetch", lambda sid: {"type": "story", "title": "T", "url": "https://x.test/article"})
    called = {"n": 0}
    def _spy(url):
        called["n"] += 1
        return "https://x.test/new.png"
    monkeypatch.setattr(hnc, "_fetch_og_image", _spy)
    out = hnc.enrich([{"source_id": "1", "url": "https://x.test/article",
                       "metadata": {"og_image": "https://x.test/old.png"}}])
    assert called["n"] == 0  # not refetched
    assert "og_image" not in json.loads(out[0]["metadata"])  # merge_upsert keeps the old one


def test_enrich_no_og_fetch_for_self_post(monkeypatch):
    hnc = HNConnector()
    thread = "https://news.ycombinator.com/item?id=5"
    monkeypatch.setattr(hnc, "_fetch", lambda sid: {"type": "story", "title": "Ask HN: x", "url": None})
    called = {"n": 0}
    monkeypatch.setattr(hnc, "_fetch_og_image", lambda url: called.__setitem__("n", called["n"] + 1) or "x")
    out = hnc.enrich([{"source_id": "5", "url": thread, "metadata": {}}])
    assert called["n"] == 0
    assert "og_image" not in json.loads(out[0]["metadata"])
