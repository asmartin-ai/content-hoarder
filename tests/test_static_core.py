"""Frontend v3 foundation smoke tests: the static/core/ ES-module layer must be
served with a JS MIME type (Windows registry can map .js to text/plain, which
hard-fails <script type="module"> — create_app pins it via mimetypes)."""

from content_hoarder.web import create_app

CORE_JS = ["util.js", "api.js", "toast.js", "render.js", "media.js", "swipe.js", "icons.js"]


def _client(tmp_db):
    return create_app(tmp_db).test_client()


def test_core_js_served_with_js_mime(tmp_db):
    cl = _client(tmp_db)
    for name in CORE_JS:
        r = cl.get(f"/static/core/{name}")
        assert r.status_code == 200, name
        assert "javascript" in r.headers["Content-Type"], (name, r.headers["Content-Type"])


def test_core_tokens_css_served(tmp_db):
    r = _client(tmp_db).get("/static/core/tokens.css")
    assert r.status_code == 200
    assert b"--accent" in r.data and b'data-theme="light"' in r.data


def test_vendored_fonts_served(tmp_db):
    cl = _client(tmp_db)
    for f in ["Lexend-var.woff2", "JetBrainsMono-var.woff2"]:
        r = cl.get(f"/static/fonts/{f}")
        assert r.status_code == 200, f
        assert r.data[:4] == b"wOF2", f  # real woff2, not an HTML error page
