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


def test_reddit_text_post_thumbnail_does_not_render_media_affordance():
    out = _node_eval(
        "import { logRow, pinCard } from './browse/render.js';"
        "const it = { source:'reddit', fullname:'reddit:t3_ask', kind:'post',"
        "  title:'AskReddit text post', body:'Thread text preview body.', status:'inbox',"
        "  url:'https://www.reddit.com/r/AskReddit/comments/abc/title/',"
        "  metadata:{ subreddit:'AskReddit',"
        "    permalink:'/r/AskReddit/comments/abc/title/',"
        "    thumbnail:'https://b.thumbs.redditmedia.com/selfpost.jpg' } };"
        "const html = logRow(it, { view:'', nsfwRevealed:new Set() }) + pinCard(it, { view:'' });"
        "console.log(JSON.stringify({"
        "  media: html.includes('data-media'),"
        "  emptySlot: html.includes('monitor empty'),"
        "  snippet: html.includes('Thread text preview body.')"
        "}));"
    )
    assert json.loads(out) == {
        "media": False,
        "emptySlot": True,
        "snippet": True,
    }


def test_reddit_image_thumbnail_still_renders_media_affordance():
    out = _node_eval(
        "import { logRow, pinCard } from './browse/render.js';"
        "const it = { source:'reddit', fullname:'reddit:t3_img', kind:'post',"
        "  title:'Image post', body:'', status:'inbox',"
        "  url:'https://www.reddit.com/r/pics/comments/abc/title/',"
        "  metadata:{ subreddit:'pics', permalink:'/r/pics/comments/abc/title/',"
        "    media_url:'https://i.redd.it/img.jpg', media_type:'reddit_media',"
        "    thumbnail:'https://b.thumbs.redditmedia.com/img.jpg' } };"
        "const html = logRow(it, { view:'', nsfwRevealed:new Set() }) + pinCard(it, { view:'' });"
        "console.log(JSON.stringify({"
        "  cls: html.includes('data-media'),"
        "  monitor: html.includes('class=\"monitor'),"
        "  screen: html.includes('class=\"screen')"
        "}));"
    )
    assert json.loads(out) == {
        "cls": True,
        "monitor": True,
        "screen": True,
    }


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


def test_unarchived_vreddit_video_uses_remote_hls_manifest():
    # Reddit fallback MP4s are often video-only; unarchived v.redd.it should use HLS for audio.
    out = _node_eval(
        "import { playableVideoSrc } from './core/media.js';"
        "const it = { url: 'https://www.reddit.com/r/x/comments/a/t/', metadata: {"
        "  media_type: 'reddit_video',"
        "  media_url: 'https://v.redd.it/abc123/DASH_720.mp4?source=fallback'"
        "} };"
        "console.log(playableVideoSrc(it));"
    )
    assert out == "https://v.redd.it/abc123/HLSPlaylist.m3u8"


def test_archived_vreddit_video_prefers_local_muxed_mp4_when_enabled():
    out = _node_eval(
        "import { setArchivePref, playableVideoSrc } from './core/media.js';"
        "const u = 'https://v.redd.it/abc123/DASH_720.mp4?source=fallback';"
        "const it = { url: 'https://www.reddit.com/r/x/comments/a/t/', metadata: {"
        "  media_type: 'reddit_video', media_url: u,"
        "  archived_media: { [u]: 'sha.mp4', 'https://v.redd.it/abc123': 'sha.mp4' },"
        "  archived_media_details: { 'https://v.redd.it/abc123': { kind: 'reddit_video' } }"
        "} };"
        "setArchivePref(true);"
        "console.log(playableVideoSrc(it));"
    )
    assert out == "/media/sha.mp4"


def test_archived_vreddit_canonical_only_still_resolves_local_when_enabled():
    out = _node_eval(
        "import { setArchivePref, playableVideoSrc } from './core/media.js';"
        "const u = 'https://v.redd.it/abc123/DASH_720.mp4?source=fallback';"
        "const it = { url: 'https://www.reddit.com/r/x/comments/a/t/', metadata: {"
        "  media_type: 'reddit_video', media_url: u,"
        "  archived_media: { 'https://v.redd.it/abc123': 'sha.mp4' }"
        "} };"
        "setArchivePref(true);"
        "console.log(playableVideoSrc(it));"
    )
    assert out == "/media/sha.mp4"


def test_gallery_metadata_classifies_as_gallery_before_image():
    out = _node_eval(
        "import { mediaType } from './core/media.js';"
        "const byArray = { url: 'https://www.reddit.com/r/pics/comments/abc/t/',"
        "  metadata: { gallery: ['https://i.redd.it/g1.jpg'], media_url: 'https://i.redd.it/g1.jpg' } };"
        "const byType = { url: 'https://www.reddit.com/r/pics/comments/def/t/',"
        "  metadata: { media_type: 'gallery', media_url: 'https://i.redd.it/g2.jpg' } };"
        "console.log(JSON.stringify([mediaType(byArray).cls, mediaType(byType).cls]));"
    )
    assert json.loads(out) == ["gallery", "gallery"]


def test_thumb_uses_gallery_preview_for_list_density():
    out = _node_eval(
        "import { thumb } from './core/media.js';"
        "console.log(thumb({ source:'reddit', metadata:{"
        "  gallery_preview:['https://preview.redd.it/p0.jpg?s=1'],"
        "  gallery:['https://i.redd.it/f0.jpg']"
        "} }, 'list'));"
    )
    assert out == "https://preview.redd.it/p0.jpg?s=1"


def test_thumb_falls_back_to_gallery_when_thumbnail_is_invalid_or_sentinel():
    out = _node_eval(
        "import { thumb } from './core/media.js';"
        "const bad = { source:'reddit', metadata:{ thumbnail:'javascript:alert(1)',"
        "  gallery:['https://i.redd.it/f0.jpg'] } };"
        "const sentinel = { source:'reddit', metadata:{ thumbnail:'self',"
        "  gallery_preview:['https://preview.redd.it/p0.jpg?s=1'],"
        "  gallery:['https://i.redd.it/f0.jpg'] } };"
        "console.log(JSON.stringify([thumb(bad, 'list'), thumb(sentinel, 'list')]));"
    )
    assert json.loads(out) == [
        "https://i.redd.it/f0.jpg",
        "https://preview.redd.it/p0.jpg?s=1",
    ]


def test_gallery_thumb_prefers_local_archive_when_enabled():
    out = _node_eval(
        "import { setArchivePref, thumb } from './core/media.js';"
        "const p = 'https://preview.redd.it/p0.jpg?s=1';"
        "setArchivePref(true);"
        "console.log(thumb({ source:'reddit', metadata:{"
        "  thumbnail:'default', gallery_preview:[p], archived_media:{ [p]:'blob.jpg' }"
        "} }, 'list'));"
    )
    assert out == "/media/blob.jpg"


def test_twitter_media_urls_classify_and_resolve_images():
    out = _node_eval(
        "import { mediaType, imageUrl, imageUrls } from './core/media.js';"
        "const it = { source: 'twitter', url: 'https://x.com/me/status/1', metadata: {"
        "  media_urls: ['https://pbs.twimg.com/media/a.jpg?name=orig']"
        "} };"
        "console.log(JSON.stringify([mediaType(it).cls, imageUrl(it), imageUrls(it)]));"
    )
    assert json.loads(out) == [
        "image",
        "https://pbs.twimg.com/media/a.jpg?name=orig",
        ["https://pbs.twimg.com/media/a.jpg?name=orig"],
    ]


def test_twitter_media_urls_prefer_local_archive_when_enabled():
    out = _node_eval(
        "import { setArchivePref, imageUrl } from './core/media.js';"
        "const u = 'https://pbs.twimg.com/media/a.jpg?name=orig';"
        "setArchivePref(true);"
        "console.log(imageUrl({ source: 'twitter', url: 'https://x.com/me/status/1',"
        "  metadata: { media_urls: [u], archived_media: { [u]: 'abc.jpg' } } }));"
    )
    assert out == "/media/abc.jpg"


def test_twitter_video_urls_classify_and_prefer_local_archive_when_enabled():
    out = _node_eval(
        "import { setArchivePref, mediaType, playableVideoSrc, videoUrls } from './core/media.js';"
        "const u = 'https://video.twimg.com/ext_tw_video/1/pu/vid/720x720/v.mp4';"
        "const it = { source: 'twitter', url: 'https://x.com/me/status/1', metadata: {"
        "  media_urls: [u], archived_media: { [u]: 'def.mp4' }"
        "} };"
        "setArchivePref(true);"
        "console.log(JSON.stringify([mediaType(it).cls, videoUrls(it), playableVideoSrc(it)]));"
    )
    assert json.loads(out) == ["video", ["/media/def.mp4"], "/media/def.mp4"]
