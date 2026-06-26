import json
import shutil
import subprocess
from pathlib import Path

import pytest

STATIC = Path(__file__).resolve().parents[1] / "src" / "content_hoarder" / "static"


def _node_eval(expr: str):
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    script = (
        "import { canOpenInReader, extractYoutubeIds, renderTweetOutlinks, "
        "renderTweetQuote, toggleChecklistLine, youtubeIdForItem } from './browse/reader.js';"
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


def test_reader_source_support_helper():
    out = _node_eval(
        "['reddit','hackernews','keep','obsidian','youtube','twitter','firefox']"
        ".map((source) => [source, canOpenInReader({source})])"
    )
    assert dict(out) == {
        "reddit": True,
        "hackernews": True,
        "keep": True,
        "obsidian": True,
        "youtube": True,
        "twitter": True,
        "firefox": False,
    }


def test_youtube_id_extraction_rejects_non_video_ids():
    out = _node_eval(
        "({"
        "valid: youtubeIdForItem({source:'youtube', source_id:'ReaderVid01'}),"
        "fromUrl: youtubeIdForItem({source:'youtube', source_id:'bad', url:'https://youtu.be/ReaderVid01'}),"
        "playlist: extractYoutubeIds('https://www.youtube.com/playlist?list=PL1234567890'),"
        "live: extractYoutubeIds('https://www.youtube.com/live_stream?channel=x'),"
        "videoseries: extractYoutubeIds('https://www.youtube.com/watch?v=videoseries')"
        "})"
    )
    assert out == {
        "valid": "ReaderVid01",
        "fromUrl": "ReaderVid01",
        "playlist": [],
        "live": [],
        "videoseries": [],
    }


def test_checklist_toggle_preserves_line_shape():
    body = "[ ] keep style\n- [x] markdown task\nnot a task"
    out = _node_eval(
        "[toggleChecklistLine(" + json.dumps(body) + ", 0),"
        " toggleChecklistLine(" + json.dumps(body) + ", 1),"
        " toggleChecklistLine(" + json.dumps(body) + ", 2)]"
    )
    assert out[0].splitlines()[0] == "[x] keep style"
    assert out[1].splitlines()[1] == "- [ ] markdown task"
    assert out[2] == body


def test_tweet_quote_and_outlinks_escape_unsafe_content():
    out = _node_eval(
        "({quote: renderTweetQuote({author_handle:'evil', text:'quoted <script>x</script>', "
        "permalink:'javascript:alert(1)'}), "
        "links: renderTweetOutlinks(['javascript:alert(1)', 'https://example.com/a?x=1&y=2'])})"
    )
    assert "<script>" not in out["quote"]
    assert "&lt;script&gt;" in out["quote"]
    assert "javascript:" not in out["quote"]
    assert "javascript:" not in out["links"]
    assert 'href="https://example.com/a?x=1&amp;y=2"' in out["links"]
