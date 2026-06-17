"""HN author → HN user-profile link (Epic 15).

The author byline links to news.ycombinator.com/user?id=<author>, mirroring the
Reddit /user/ link. The logic lives in the pure helpers of core/render.js, which
import only ./util.js + ./media.js (no DOM), so node can exercise them directly.
Skips when node isn't available (the suite stays pure-Python otherwise).
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


def test_hn_user_url_builds_and_encodes():
    out = _node_eval(
        "import { hnUserUrl } from './core/render.js';"
        "console.log(JSON.stringify([hnUserUrl('pg'), hnUserUrl(''), hnUserUrl('  '), hnUserUrl('a b')]));"
    )
    assert json.loads(out) == [
        "https://news.ycombinator.com/user?id=pg",
        "",
        "",
        "https://news.ycombinator.com/user?id=a%20b",
    ]


def test_metaline_links_hackernews_author():
    out = _node_eval(
        "import { metaLine } from './core/render.js';"
        "console.log(metaLine({ source: 'hackernews', author: 'pg', metadata: {} }));"
    )
    assert 'href="https://news.ycombinator.com/user?id=pg"' in out
    assert ">pg</a>" in out


def test_metaline_reddit_author_unchanged():
    # parity guard: the existing Reddit link must not regress.
    out = _node_eval(
        "import { metaLine } from './core/render.js';"
        "console.log(metaLine({ source: 'reddit', author: 'spez', metadata: {} }));"
    )
    assert 'href="https://www.reddit.com/user/spez"' in out


def test_metaline_other_source_author_is_plain_text():
    out = _node_eval(
        "import { metaLine } from './core/render.js';"
        "console.log(metaLine({ source: 'obsidian', author: 'me', metadata: {} }));"
    )
    assert "<a " not in out
    assert "by me" in out
