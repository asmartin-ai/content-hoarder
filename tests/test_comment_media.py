"""reddit_thread._resolve_media + media_metadata pass-through (inline comment/selftext images)."""
import json

from content_hoarder import reddit_thread


def _comment(name, body, mm=None):
    d = {"author": "u", "body": body, "score": 1,
         "permalink": "/r/x/comments/a/_/" + name + "/", "created_utc": 1, "name": "t1_" + name}
    if mm is not None:
        d["media_metadata"] = mm
    return {"kind": "t1", "data": d}


def _blob(post_data, comments):
    return [
        {"kind": "Listing", "data": {"children": [{"kind": "t3", "data": post_data}]}},
        {"kind": "Listing", "data": {"children": comments}},
    ]


IMG_MM = {"abc123": {"status": "valid", "e": "Image", "m": "image/png",
                     "s": {"u": "https://preview.redd.it/abc123.png?width=640&amp;s=xyz",
                           "x": 640, "y": 480}}}
GIF_MM = {"giphy|RAND": {"status": "valid", "e": "AnimatedImage", "m": "image/gif",
                         "s": {"gif": "https://i.giphy.com/media/RAND/giphy.gif",
                               "mp4": "https://i.giphy.com/media/RAND/giphy.mp4", "x": 200, "y": 200}}}


def test_resolve_image_unescapes_url_and_keys_by_id():
    out = reddit_thread._resolve_media(IMG_MM)
    assert out["abc123"]["u"] == "https://preview.redd.it/abc123.png?width=640&s=xyz"  # &amp; -> &
    assert out["abc123"] == {"u": out["abc123"]["u"], "kind": "image", "w": 640, "h": 480}


def test_resolve_animated_prefers_gif():
    out = reddit_thread._resolve_media(GIF_MM)
    assert out["giphy|RAND"]["kind"] == "gif"
    assert out["giphy|RAND"]["u"].endswith("giphy.gif")


def test_resolve_skips_invalid_status_and_non_http():
    mm = {"a": {"status": "failed", "e": "Image", "s": {"u": "https://i.redd.it/a.png"}},
          "b": {"status": "valid", "e": "Image", "s": {"u": "ftp://bad/b.png"}},
          "c": {"status": "valid", "e": "Image", "s": {}}}
    assert reddit_thread._resolve_media(mm) == {}


def test_resolve_handles_garbage():
    assert reddit_thread._resolve_media(None) == {}
    assert reddit_thread._resolve_media({"x": "not-a-dict"}) == {}


def test_parse_thread_passes_comment_and_post_media_and_stays_lean():
    blob = _blob(
        {"title": "t", "author": "op", "selftext": "see ![img](abc123)", "subreddit": "s",
         "permalink": "/r/s/comments/a/t/", "score": 1, "url": "", "created_utc": 1,
         "media_metadata": IMG_MM},
        [_comment("c1", "look ![gif](giphy|RAND)", GIF_MM), _comment("c2", "no media here")],
    )
    parsed = reddit_thread.parse_thread(
        json.dumps(blob), {"fullname": "reddit:t3_a", "kind": "post"})
    assert parsed["post"]["media"]["abc123"]["kind"] == "image"
    c1, c2 = parsed["comments"][0], parsed["comments"][1]
    assert c1["media"]["giphy|RAND"]["kind"] == "gif"
    assert "media" not in c2          # omitted when the comment has no media (keeps the payload lean)
