"""#74 — comment reader empty thread: dual-key cache + honest empty copy."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from content_hoarder import db, models, reddit_hydrate, reddit_thread

STATIC = Path(__file__).resolve().parents[1] / "src" / "content_hoarder" / "static"


@pytest.fixture
def conn(tmp_path, monkeypatch):
    path = tmp_path / "t.db"
    monkeypatch.setenv("CONTENT_HOARDER_DB", str(path))
    c = db.connect(str(path))
    db.init_db(c)
    yield c
    c.close()


def _seed_comment(conn, *, cid="abc123", sid="sub456"):
    item = models.new_item(
        source="reddit",
        source_id=f"t1_{cid}",
        kind="comment",
        title="parent title",
        body="I am the saved comment body",
        metadata={
            "permalink": f"/r/test/comments/{sid}/slug/{cid}/",
            "subreddit": "test",
        },
    )
    db.merge_upsert(conn, item)
    conn.commit()
    return item["fullname"], f"reddit:t3_{sid}"


def _thread_blob(title="Hello post"):
    return [
        {
            "kind": "Listing",
            "data": {
                "children": [
                    {
                        "kind": "t3",
                        "data": {
                            "title": title,
                            "author": "op",
                            "selftext": "post body",
                            "subreddit": "test",
                            "permalink": "/r/test/comments/sub456/slug/",
                            "score": 10,
                            "url": "https://www.reddit.com/r/test/comments/sub456/slug/",
                            "created_utc": 1,
                        },
                    }
                ]
            },
        },
        {
            "kind": "Listing",
            "data": {
                "children": [
                    {
                        "kind": "t1",
                        "data": {
                            "author": "alice",
                            "body": "top reply",
                            "score": 3,
                            "permalink": "/r/test/comments/sub456/slug/c1/",
                            "created_utc": 2,
                            "replies": "",
                        },
                    }
                ]
            },
        },
    ]


def test_submission_fullname_from_permalink():
    assert (
        reddit_hydrate.submission_fullname(
            "/r/test/comments/sub456/slug/cid/"
        )
        == "reddit:t3_sub456"
    )
    assert reddit_hydrate.submission_fullname("") is None


def test_get_thread_falls_back_to_submission_cache(conn):
    cfn, pfn = _seed_comment(conn)
    blob = json.dumps(_thread_blob())
    # Only the post key is cached (historical post-open hydrate).
    db.set_reddit_thread(conn, pfn, blob, commit=True)
    assert db.get_reddit_thread(conn, cfn) is None

    res = reddit_thread.get_thread(conn, cfn)
    assert res is not None
    assert res.get("cached") is True
    assert res.get("cache_via") == "submission"
    assert res["post"]["title"] == "Hello post"
    assert len(res["comments"]) == 1
    # Mirrored onto comment key for next open
    assert db.get_reddit_thread(conn, cfn) is not None


def test_hydrate_one_dual_writes_comment_and_post(conn):
    from content_hoarder.reddit_unsave import set_auth

    cfn, pfn = _seed_comment(conn, cid="zz1", sid="post99")
    set_auth(conn, session_cookie="c", modhash="m")

    def fake_getf(url, *, session_cookie, user_agent):
        return _thread_blob("dual write post")

    res = reddit_hydrate.hydrate_one(conn, cfn, getf=fake_getf)
    assert res["status"] == "hydrated"
    assert db.get_reddit_thread(conn, cfn)
    assert db.get_reddit_thread(conn, pfn)


def test_hydrate_if_missing_uses_submission_cache(conn):
    cfn, pfn = _seed_comment(conn, cid="yy1", sid="post77")
    db.set_reddit_thread(conn, pfn, json.dumps(_thread_blob("via sub")), commit=True)
    calls = {"n": 0}

    def boom(*a, **k):
        calls["n"] += 1
        raise AssertionError("should not network")

    res = reddit_hydrate.hydrate_if_missing(conn, cfn, getf=boom)
    assert res["status"] == "cached"
    assert res.get("via") == "submission"
    assert calls["n"] == 0
    assert db.get_reddit_thread(conn, cfn)


def _node_eval(expr: str):
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    script = (
        "import { threadEmptyMessage } from './browse/reader.js';"
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


def test_thread_empty_message_honest():
    assert "No comments" in _node_eval(
        "threadEmptyMessage({cached:true, comments:[]})"
    )
    miss = _node_eval("threadEmptyMessage({cached:false, comments:[]})")
    assert "not loaded" in miss.lower()
    assert "No comments on this post" not in miss
    auth = _node_eval(
        "threadEmptyMessage({cached:false, hydrate_status:'auth_missing'})"
    )
    assert "Sign in" in auth
    assert "No comments on this post" not in auth

def test_render_comments_skips_seed_when_comments_present():
    """#74 P2 regression: the seed pane ('Your saved comment') is a loading-state
    placeholder. When the full thread renders with comments, the saved comment is
    already the first (or only) entry in the tree, so re-rendering the seed would
    duplicate the body. The fix: skip the seed in the comments.length > 0 branch."""
    src = (STATIC / "browse" / "reader.js").read_text(encoding="utf-8")
    # Locate renderComments
    rc = src.split("function renderComments(res)", 1)[1].split("function ", 1)[0]
    # The comments.length branch must NOT call seedSavedCommentHtml().
    import re
    # Split the function body into the two branches (if / else).
    m = re.search(
        r"if \(comments\.length\)\s*\{(.*?)\}\s*(.*?)(?=function\s|\Z)",
        rc,
        re.DOTALL,
    )
    assert m, "could not locate comments.length branch in renderComments"
    if_branch = m.group(1)
    trailing = m.group(2)
    assert "seedSavedCommentHtml" not in if_branch, (
        "renderComments()'s comments.length > 0 branch must not render the seed "
        "pane — the saved comment is already in the rendered tree."
    )
    # The else/zero branch is allowed (and required) to keep the seed.
    assert "seedSavedCommentHtml" in trailing, (
        "renderComments()'s zero-comments branch should still show the seed "
        "so the reader isn't blank while loading / on a no-comments thread."
    )

def test_thread_empty_message_not_found_is_honest():
    """#74 P3 #4: `not_found` is a permanent hydration failure (the item no
    longer exists on Reddit). It must NOT fall through to 'Thread not loaded
    yet.' which sounds recoverable."""
    msg = _node_eval(
        "threadEmptyMessage({cached:false, hydrate_status:'not_found'})"
    )
    assert "removed" in msg.lower() or "not" in msg.lower()
    assert "not loaded yet" not in msg
    assert "No comments on this post" not in msg


def test_collapse_handlers_pass_res_to_render_comments():
    """#74 P3 #5: PR changed `renderComments()` to `renderComments(res)` but two
    callers (collapse toggle, tap-anything) were left as bare calls. Latent bug:
    any future code that uses `res` in the comments.length > 0 branch would see
    `undefined`. The fix: explicit `renderComments({})` at the call sites."""
    src = (STATIC / "browse" / "reader.js").read_text(encoding="utf-8")
    import re
    # Find the two event-handler sections that toggle `collapsed` and call renderComments.
    bare_calls = re.findall(r"renderComments\(\s*\)", src)
    assert not bare_calls, (
        f"renderComments() must be called with a `res` argument (got {len(bare_calls)} bare calls)"
    )
