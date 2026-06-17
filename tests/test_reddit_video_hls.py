"""v.redd.it audio via HLS (Epic 13 P2).

The pure helpers — hlsManifestUrl() (manifest derivation) and the mediaType()
metadata branch that routes reddit-hosted video to the HLS path — live in
core/media.js and import only ./util.js, so node exercises them directly. Skips
when node isn't on PATH.
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


def test_hls_manifest_url_from_bare_and_fallback():
    out = _node_eval(
        "import { hlsManifestUrl } from './core/media.js';"
        "console.log(JSON.stringify(["
        "  hlsManifestUrl('https://v.redd.it/abc123'),"
        "  hlsManifestUrl('https://v.redd.it/abc123/DASH_720.mp4?source=fallback'),"
        "  hlsManifestUrl('https://example.com/clip.mp4'),"
        "  hlsManifestUrl('')]));"
    )
    assert json.loads(out) == [
        "https://v.redd.it/abc123/HLSPlaylist.m3u8",
        "https://v.redd.it/abc123/HLSPlaylist.m3u8",
        "",
        "",
    ]


def test_mediatype_routes_reddit_video_by_metadata():
    # item.url is the permalink (would classify "text"); metadata.media_url is the
    # v.redd.it evidence and must win → "video" so the row routes to openVideo.
    out = _node_eval(
        "import { mediaType } from './core/media.js';"
        "console.log(mediaType({ url: 'https://www.reddit.com/r/x/comments/abc/t/',"
        "  metadata: { media_type: 'reddit_video', media_url: 'https://v.redd.it/abc123' } }).cls);"
    )
    assert out == "video"


def test_mediatype_image_unchanged_without_media_url():
    # parity guard: the url-heuristic image path must not regress.
    out = _node_eval(
        "import { mediaType } from './core/media.js';"
        "console.log(mediaType({ url: 'https://i.redd.it/x.png', metadata: {} }).cls);"
    )
    assert out == "image"
