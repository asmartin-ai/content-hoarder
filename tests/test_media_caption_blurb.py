"""#32 caption + #31 blurbs + #39 text-post classification (pure helpers)."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

STATIC = Path(__file__).resolve().parents[1] / "src" / "content_hoarder" / "static"


def _node(expr: str):
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    script = (
        "import { mediaType, itemCaptionText, itemCaptionHtml, itemPreviewBlurb, "
        "playableVideoSrc } from './core/media.js';"
        f"const out = {expr};"
        "console.log(JSON.stringify(out));"
    )
    r = subprocess.run(
        [node, "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        cwd=STATIC,
    )
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def test_askreddit_self_post_is_text_not_video():
    """#39: permalink-shaped media_url must not create a play affordance."""
    item = {
        "source": "reddit",
        "kind": "post",
        "url": "https://www.reddit.com/r/AskReddit/comments/abc/title/",
        "body": "",
        "metadata": {
            "media_type": "reddit_media",
            "media_url": "https://www.reddit.com/r/AskReddit/comments/abc/title/",
            "permalink": "/r/AskReddit/comments/abc/title/",
        },
    }
    mt = _node("mediaType(" + json.dumps(item) + ")")
    assert mt["cls"] == "text"
    assert _node("playableVideoSrc(" + json.dumps(item) + ")") == ""


def test_caption_html_collapses_long_selftext():
    item = {
        "source": "reddit",
        "kind": "post",
        "body": "word " * 80,
        "metadata": {"media_type": "image", "media_url": "https://i.redd.it/x.jpg"},
    }
    html = _node("itemCaptionHtml(" + json.dumps(item) + ")")
    assert "media-caption" in html
    assert "Show more" in html
    assert "data-full=" in html


def test_caption_empty_without_body():
    item = {
        "source": "reddit",
        "kind": "post",
        "body": "",
        "metadata": {"media_type": "image", "media_url": "https://i.redd.it/x.jpg"},
    }
    assert _node("itemCaptionHtml(" + json.dumps(item) + ")") == ""


def test_preview_blurb_comment_and_text():
    c = {
        "source": "reddit",
        "kind": "comment",
        "body": "saved reply text here that is useful",
        "metadata": {},
    }
    assert "saved reply" in _node("itemPreviewBlurb(" + json.dumps(c) + ")")
    text = {
        "source": "reddit",
        "kind": "post",
        "url": "https://www.reddit.com/r/AskReddit/comments/x/y/",
        "body": "",
        "metadata": {"permalink": "/r/AskReddit/comments/x/y/"},
    }
    blurb = _node("itemPreviewBlurb(" + json.dumps(text) + ")")
    assert "Text post" in blurb


def test_image_with_selftext_blurb():
    item = {
        "source": "reddit",
        "kind": "post",
        "body": "Here is the caption under the meme for search and list preview.",
        "url": "https://i.redd.it/x.jpg",
        "metadata": {"media_type": "image", "media_url": "https://i.redd.it/x.jpg"},
    }
    assert "caption under the meme" in _node(
        "itemPreviewBlurb(" + json.dumps(item) + ")"
    )
    assert "caption under the meme" in _node(
        "itemCaptionText(" + json.dumps(item) + ")"
    )
