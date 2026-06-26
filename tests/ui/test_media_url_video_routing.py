"""UI regression: a direct video file in metadata.media_url must classify as video.

Finding #5 from the 2026-06-26 code review: mediaType() checked metadata.media_url
for v.redd.it and image extensions but NOT for direct video files (.mp4/.webm/.mov).
A permalink-type item (item.url = reddit permalink) with a resolved .mp4 in
metadata.media_url fell through to 'text' — the resolved video was invisible in the
browse/reader UI. playableVideoSrc() also returned "" because it gates on
mediaType().cls === 'video'.

The fix adds a VIDEO_EXT.test(m.media_url) check alongside the existing v.redd.it
check, so any direct video file in the archive signal routes to the inline player.
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.ui


def test_media_url_mp4_classified_as_video(pixel6_page):
    """A permalink item with .mp4 in metadata.media_url → video, not text."""
    result = pixel6_page.evaluate("""async () => {
        const mod = await import('/static/core/media.js');
        return mod.mediaType({
            kind: 'post',
            url: '/r/test/comments/synth/video_resolved/',
            metadata: {
                media_url: 'https://example.com/video.mp4',
                media_type: 'resolved_video',
                subreddit: 'test',
                permalink: '/r/test/comments/synth/video_resolved/'
            }
        });
    }""")
    assert result["cls"] == "video"


def test_media_url_mp4_playable(pixel6_page):
    """playableVideoSrc returns a non-empty URL for a resolved permalink item."""
    src = pixel6_page.evaluate("""async () => {
        const mod = await import('/static/core/media.js');
        return mod.playableVideoSrc({
            kind: 'post',
            url: '/r/test/comments/synth/video_resolved/',
            metadata: {
                media_url: 'https://example.com/video.mp4',
                media_type: 'resolved_video',
                subreddit: 'test'
            }
        });
    }""")
    assert src != "", "playableVideoSrc should return a non-empty URL for resolved .mp4"


def test_permalink_without_direct_video_stays_text(pixel6_page):
    """A permalink item whose media_url is NOT a direct video file stays 'text' —
    the fix only triggers on a resolved direct-video URL, not a non-video page URL."""
    result = pixel6_page.evaluate("""async () => {
        const mod = await import('/static/core/media.js');
        return mod.mediaType({
            kind: 'post',
            url: '/r/test/comments/synth/no_video/',
            metadata: {
                media_url: 'https://example.com/page.html',
                subreddit: 'test'
            }
        });
    }""")
    assert result["cls"] == "text"
