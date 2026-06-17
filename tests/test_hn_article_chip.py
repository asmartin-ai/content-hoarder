"""HN "Article ↗" chip + og:image thumbnail wiring (Epic 15).

The chip helpers live in core/render.js and the thumbnail branch in core/media.js;
both are pure (import only ./util.js [+ ./media.js], no DOM), so node exercises them
directly. Skips when node isn't on PATH (the suite stays pure-Python otherwise).
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

STATIC = Path(__file__).resolve().parents[1] / "src" / "content_hoarder" / "static"


def _node_eval(script):
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    r = subprocess.run(
        [node, "--input-type=module", "-e", script],
        capture_output=True, text=True, cwd=STATIC,
    )
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


# ---- article chip --------------------------------------------------------

def test_hn_article_url_external_vs_self():
    out = _node_eval(
        "import { hnArticleUrl } from './core/render.js';"
        "const ext = { source:'hackernews', url:'https://example.com/post' };"
        "const ask = { source:'hackernews', url:'https://news.ycombinator.com/item?id=42' };"
        "const rd  = { source:'reddit', url:'https://example.com/post' };"
        "console.log(JSON.stringify([hnArticleUrl(ext), hnArticleUrl(ask), hnArticleUrl(rd)]));"
    )
    assert json.loads(out) == ["https://example.com/post", "", ""]


def test_article_chip_renders_for_external_only():
    out = _node_eval(
        "import { articleChip } from './core/render.js';"
        "console.log(articleChip({ source:'hackernews', url:'https://example.com/p' }));"
    )
    assert 'href="https://example.com/p"' in out
    assert "Article" in out
    assert 'class="comp-link art-chip"' in out


def test_article_chip_empty_for_self_post():
    out = _node_eval(
        "import { articleChip } from './core/render.js';"
        "console.log(JSON.stringify(articleChip({ source:'hackernews', url:'https://news.ycombinator.com/item?id=9' })));"
    )
    assert json.loads(out) == ""


def test_metaline_appends_article_chip():
    out = _node_eval(
        "import { metaLine } from './core/render.js';"
        "console.log(metaLine({ source:'hackernews', author:'pg', url:'https://example.com/p', metadata:{ score: 12 } }));"
    )
    assert "12 pts" in out
    assert 'class="comp-link art-chip"' in out


# ---- og:image thumbnail branch ------------------------------------------

def test_thumb_uses_hn_og_image():
    out = _node_eval(
        "import { thumb } from './core/media.js';"
        "console.log(thumb({ source:'hackernews', url:'https://example.com/p', metadata:{ og_image:'https://example.com/og.png' } }, 'list'));"
    )
    assert out == "https://example.com/og.png"


def test_thumb_og_image_is_hn_only():
    # parity guard: og_image must not leak into non-HN thumbnails.
    out = _node_eval(
        "import { thumb } from './core/media.js';"
        "console.log(JSON.stringify(thumb({ source:'reddit', url:'https://example.com/p', metadata:{ og_image:'https://example.com/og.png' } }, 'list')));"
    )
    assert json.loads(out) == ""
