"""reader.js pure thread helpers: isDeletedComment + deadThreadCollapseSet (auto-collapse dead threads).

node-backed (imports browse/reader.js, which imports cleanly with no DOM at module top-level);
skips when node is unavailable.
"""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

STATIC = Path(__file__).resolve().parents[1] / "src" / "content_hoarder" / "static"


def _call(fn, comments):
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    script = (
        f"import {{ {fn} }} from './browse/reader.js';"
        f"const r = {fn}({json.dumps(comments)});"
        "console.log(JSON.stringify(r && r.size !== undefined ? [...r] : r));"
    )
    r = subprocess.run([node, "--input-type=module", "-e", script],
                       capture_output=True, text=True, cwd=STATIC)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout.strip())


def _eval(script):
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    r = subprocess.run([node, "--input-type=module", "-e", script],
                       capture_output=True, text=True, cwd=STATIC)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


def _call_item(fn, item):
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    script = (
        f"import {{ {fn} }} from './browse/reader.js';"
        f"console.log(JSON.stringify({fn}({json.dumps(item)})));"
    )
    r = subprocess.run([node, "--input-type=module", "-e", script],
                       capture_output=True, text=True, cwd=STATIC)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout.strip())


def c(author, body, depth):
    return {"author": author, "body": body, "depth": depth}


def test_is_deleted_comment_variants():
    assert _call("isDeletedComment", c("x", "[deleted]", 0)) is True
    assert _call("isDeletedComment", c("x", "[removed]", 0)) is True
    assert _call("isDeletedComment", c("[deleted]", "anything", 0)) is True
    assert _call("isDeletedComment", c("real", "a normal reply", 0)) is False


def test_note_body_edit_gate_is_limited_to_note_sources():
    assert _call_item("canEditNoteBody", {"source": "keep"}) is True
    assert _call_item("canEditNoteBody", {"source": "obsidian"}) is True
    assert _call_item("canEditNoteBody", {"source": "reddit"}) is False
    assert _call_item("canEditNoteBody", {"source": "youtube"}) is False


def _extract_youtube_ids(text):
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    script = (
        "import { extractYoutubeIds } from './browse/reader.js';"
        f"console.log(JSON.stringify(extractYoutubeIds({json.dumps(text)})));"
    )
    r = subprocess.run([node, "--input-type=module", "-e", script],
                       capture_output=True, text=True, cwd=STATIC)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout.strip())


def test_extract_youtube_ids_host_forms_and_markdown():
    text = "\n".join([
        "bare https://youtu.be/dQw4w9WgXcQ",
        "watch [video](https://www.youtube.com/watch?v=aaaaaaaaaaa&t=30)",
        "embed ![](https://www.youtube.com/embed/bbbbbbbbbbb)",
        "short https://youtube.com/shorts/ccccccccccc?feature=share",
    ])
    assert _extract_youtube_ids(text) == [
        "dQw4w9WgXcQ",
        "aaaaaaaaaaa",
        "bbbbbbbbbbb",
        "ccccccccccc",
    ]


def test_extract_youtube_ids_dedupes_and_preserves_order():
    text = (
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ "
        "https://youtu.be/aaaaaaaaaaa "
        "https://youtube.com/embed/dQw4w9WgXcQ"
    )
    assert _extract_youtube_ids(text) == ["dQw4w9WgXcQ", "aaaaaaaaaaa"]


def test_extract_youtube_ids_multiple_zero_and_rejects():
    assert _extract_youtube_ids("no links here") == []
    assert _extract_youtube_ids("https://example.com/watch?v=dQw4w9WgXcQ") == []
    assert _extract_youtube_ids("https://www.youtube.com/embed/videoseries?list=PLx") == []
    assert _extract_youtube_ids("https://youtube.com/watch?v=shortid") == []


def test_dead_subtree_collapses_the_root():
    # deleted parent + deleted child -> the whole dead thread collapses at the root (index 0)
    comments = [c("[deleted]", "[deleted]", 0), c("[deleted]", "[removed]", 1)]
    assert set(_call("deadThreadCollapseSet", comments)) == {0}


def test_deleted_parent_with_live_reply_stays_expanded():
    comments = [c("x", "[deleted]", 0), c("alive", "a real reply", 1)]
    assert _call("deadThreadCollapseSet", comments) == []   # live descendant → not collapsed


def test_deleted_leaf_is_not_collapsed():
    assert _call("deadThreadCollapseSet", [c("[deleted]", "[deleted]", 0)]) == []  # no replies to hide


def test_live_parent_not_collapsed_but_nested_dead_thread_is():
    comments = [
        c("op", "hello", 0),               # live root
        c("[deleted]", "[removed]", 1),     # dead, child below is dead -> collapses (index 1)
        c("[deleted]", "[deleted]", 2),     # dead leaf -> not its own collapse
    ]
    assert set(_call("deadThreadCollapseSet", comments)) == {1}


def test_hn_nested_comments_normalize_to_flat_reddit_shape():
    comments = [{
        "author": "pg", "text": "<p>root</p>", "points": 5, "depth": 1,
        "children": [{"author": "dang", "text": "child", "points": 2, "depth": 2}],
    }]
    out = _eval(
        "import { normalizeThreadComments } from './browse/reader.js';"
        f"console.log(JSON.stringify(normalizeThreadComments({json.dumps(comments)}, 'hackernews')));"
    )
    flat = json.loads(out)
    assert [(c["author"], c["body"], c["score"], c["depth"]) for c in flat] == [
        ("pg", "<p>root</p>", 5, 0),
        ("dang", "child", 2, 1),
    ]


def test_hn_html_to_markdown_preserves_links_and_strips_scripts():
    out = _eval(
        "import { hnHtmlToMarkdown, renderHnHtml } from './browse/reader.js';"
        "const src = '<p>Hello &amp; <a href=\"item?id=42\">thread</a></p><script>x()</script>';"
        "console.log(JSON.stringify([hnHtmlToMarkdown(src), renderHnHtml(src)]));"
    )
    md, html = json.loads(out)
    assert md == "Hello & [thread](https://news.ycombinator.com/item?id=42)"
    assert 'href="https://news.ycombinator.com/item?id=42"' in html
    assert "script" not in html.lower()
