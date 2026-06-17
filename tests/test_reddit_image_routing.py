"""Reddit image post → in-app reader (comment thread), not the raw image (Epic 15).

The browse click router (browse/main.js) opens the in-app Reddit reader for a
reddit item whose media classifies as an image (mediaType().cls === "image"),
instead of the bare image lightbox. The reader renders the image inline plus the
comment thread. Video/gallery keep their dedicated viewers.

The routing condition is DOM-event wiring (not unit-testable without a DOM), but
its data trigger — mediaType() classification — is a pure function in
core/media.js. Pin it here so the trigger can't silently drift. node-backed;
skips when node is unavailable.
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


def test_reddit_image_links_classify_as_image():
    # These are the URL shapes that route a reddit thumbnail tap to the reader.
    out = _node_eval(
        "import { mediaType } from './core/media.js';"
        "const urls = ['https://i.redd.it/abc.jpg','https://i.imgur.com/x.png',"
        "'https://example.com/p.jpeg','https://i.redd.it/no-ext'];"
        "console.log(JSON.stringify(urls.map((u) => mediaType({ url: u }).cls)));"
    )
    assert json.loads(out) == ["image", "image", "image", "image"]


def test_reddit_video_and_gallery_are_not_image():
    # The router must NOT divert these to the reader — they keep their own viewers.
    out = _node_eval(
        "import { mediaType } from './core/media.js';"
        "console.log(JSON.stringify(["
        "mediaType({ url: 'https://v.redd.it/xyz' }).cls,"
        "mediaType({ url: 'https://www.reddit.com/gallery/xyz' }).cls]));"
    )
    assert json.loads(out) == ["video", "gallery"]


def test_reddit_text_post_is_not_image():
    out = _node_eval(
        "import { mediaType } from './core/media.js';"
        "console.log(mediaType({ url: 'https://www.reddit.com/r/sub/comments/abc/title/' }).cls);"
    )
    assert out == "text"


def test_image_detected_by_media_url_when_url_is_permalink():
    # Harvested from feat/reddit-media-v13: the ~25.8k catch-all posts whose item.url is
    # the permalink but whose image lives in metadata.media_url must classify as image
    # (so they route to the reader) and imageUrl() must return the media_url for the lightbox.
    out = _node_eval(
        "import { mediaType, imageUrl } from './core/media.js';"
        "const it = { url: 'https://www.reddit.com/r/pics/comments/abc/t/',"
        "  metadata: { media_url: 'https://i.redd.it/xyz.jpg', media_type: 'reddit_media' } };"
        "console.log(JSON.stringify([mediaType(it).cls, imageUrl(it)]));"
    )
    assert json.loads(out) == ["image", "https://i.redd.it/xyz.jpg"]


def test_media_url_video_still_wins_over_image_branch():
    # parity guard: a v.redd.it media_url is video, not image (video branch is first).
    out = _node_eval(
        "import { mediaType } from './core/media.js';"
        "console.log(mediaType({ url: 'https://www.reddit.com/r/x/comments/a/t/',"
        "  metadata: { media_url: 'https://v.redd.it/xyz' } }).cls);"
    )
    assert out == "video"
