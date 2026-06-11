"""Epic 20 Stage C: the v3 browse page shell (templates/index.html + static/browse/)."""
from content_hoarder import db, models
from content_hoarder.web import create_app


def _client(tmp_db):
    c = db.connect(tmp_db)
    db.merge_upsert(c, models.new_item(source="reddit", source_id="t3_a", kind="post",
                    title="Hello", metadata={"subreddit": "hh"}))
    c.commit()
    c.close()
    return create_app(tmp_db).test_client()


def test_browse_page_serves_v3_shell(tmp_db):
    r = _client(tmp_db).get("/")
    assert r.status_code == 200
    html = r.get_data(as_text=True)
    # v3 entry points
    assert "/static/core/tokens.css" in html
    assert "/static/browse/browse.css" in html
    assert '<script type="module" src="/static/browse/main.js">' in html
    assert "/static/theme.js" in html
    # the locked-design anchors the JS expects to find
    for anchor in ('id="ambient"', 'id="windots"', 'id="batchstrip"', 'id="decayline"',
                   'id="oppop"', 'id="fchips"', 'id="stamp"', 'id="media-modal"'):
        assert anchor in html, anchor
    # legacy v2 assets must NOT load here (app.css stays triage-only)
    assert "/static/app.css" not in html
    assert "/static/app.js" not in html


def test_browse_js_served_with_js_mime(tmp_db):
    cl = _client(tmp_db)
    for path in ("/static/browse/main.js", "/static/browse/render.js",
                 "/static/core/swipe.js"):
        r = cl.get(path)
        assert r.status_code == 200, path
        assert "javascript" in r.headers["Content-Type"], path
