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


def c(author, body, depth):
    return {"author": author, "body": body, "depth": depth}


def test_is_deleted_comment_variants():
    assert _call("isDeletedComment", c("x", "[deleted]", 0)) is True
    assert _call("isDeletedComment", c("x", "[removed]", 0)) is True
    assert _call("isDeletedComment", c("[deleted]", "anything", 0)) is True
    assert _call("isDeletedComment", c("real", "a normal reply", 0)) is False


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
