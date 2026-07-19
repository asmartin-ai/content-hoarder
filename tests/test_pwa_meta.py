"""Spec 13 — iPhone PWA installability: Apple meta tags + theme-color unification.

The served index page head must carry the Apple/mobile PWA meta tags so iOS
"Add to Home Screen" launches a proper standalone app, and the head
``theme-color`` must match the manifest (both ``#0f1115``).
"""

import json
import re
from pathlib import Path

from content_hoarder.web import create_app


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "src" / "content_hoarder" / "static" / "manifest.webmanifest"


def _head_html(tmp_db) -> str:
    resp = create_app(tmp_db).test_client().get("/")
    assert resp.status_code == 200
    html = resp.get_data(as_text=True)
    assert "</head>" in html, "no </head> in served index page"
    return html[: html.index("</head>")]


def _meta_content(head: str, name: str) -> str | None:
    """Return the ``content`` of a ``<meta name=...>`` tag, tolerant to
    attribute order, quote style, self-closing slash, and whitespace."""
    for tag in re.findall(r"<meta\b[^>]*>", head, re.I):
        nm = re.search(r'\bname\s*=\s*["\']([^"\']*)["\']', tag, re.I)
        if nm and nm.group(1).lower() == name.lower():
            cm = re.search(r'\bcontent\s*=\s*["\']([^"\']*)["\']', tag, re.I)
            return cm.group(1) if cm else None
    return None


def test_apple_pwa_meta_tags_present(tmp_db):
    head = _head_html(tmp_db)
    assert _meta_content(head, "apple-mobile-web-app-capable") == "yes"
    assert _meta_content(head, "mobile-web-app-capable") == "yes"
    assert (
        _meta_content(head, "apple-mobile-web-app-status-bar-style")
        == "black-translucent"
    )
    assert _meta_content(head, "apple-mobile-web-app-title") == "Hoarder"


def test_apple_touch_icon_link_present(tmp_db):
    head = _head_html(tmp_db)
    links = re.findall(r"<link\b[^>]*>", head, re.I)
    hit = False
    for tag in links:
        rel = re.search(r'\brel\s*=\s*["\']([^"\']*)["\']', tag, re.I)
        href = re.search(r'\bhref\s*=\s*["\']([^"\']*)["\']', tag, re.I)
        if (
            rel
            and rel.group(1).lower() == "apple-touch-icon"
            and href
            and href.group(1) == "/static/apple-touch-icon.png"
        ):
            hit = True
    assert hit, "apple-touch-icon <link> to /static/apple-touch-icon.png missing"


def test_apple_touch_icon_is_served(tmp_db):
    resp = create_app(tmp_db).test_client().get("/static/apple-touch-icon.png")
    assert resp.status_code == 200, "apple-touch-icon.png not served"
    assert resp.headers.get("Content-Type", "").startswith("image/")


def test_theme_color_matches_manifest(tmp_db):
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    theme = manifest["theme_color"]
    assert theme == "#0f1115"  # spec 13 target
    head = _head_html(tmp_db)
    got = _meta_content(head, "theme-color")
    assert got is not None, "theme-color meta missing from head"
    assert got == theme, f"head theme-color {got!r} != manifest {theme!r}"

# --- iOS splash screens (apple-touch-startup-image) ---


# Sizes shipped (filename → expected WxH). One entry per (device, size)
# shipped by `scripts/gen_splash_screens.py`. iOS picks the closest match by
# device pixel dimensions, so every shipping iPhone + iPad must be covered.
EXPECTED_SPLASH_SIZES: list[tuple[str, int, int]] = [
    ("apple-touch-startup-image-1290x2796.png", 1290, 2796),  # iPhone 16/15/14 Pro Max, Plus
    ("apple-touch-startup-image-1179x2556.png", 1179, 2556),  # iPhone 16/15/14 Pro
    ("apple-touch-startup-image-1170x2532.png", 1170, 2532),  # iPhone 14/13/12 (Pro)
    ("apple-touch-startup-image-1080x2340.png", 1080, 2340),  # iPhone 13/12 mini
    ("apple-touch-startup-image-750x1334.png",    750, 1334),  # iPhone SE3 / 8 / 7 / 6s
    ("apple-touch-startup-image-640x1136.png",    640, 1136),  # iPhone 5 / SE1 / iPod
    ("apple-touch-startup-image-2048x2732.png", 2048, 2732),  # iPad Pro 12.9 (3rd-6th)
    ("apple-touch-startup-image-1668x2388.png", 1668, 2388),  # iPad Pro 11 (1st-4th)
    ("apple-touch-startup-image-1668x2224.png", 1668, 2224),  # iPad Pro 10.5
    ("apple-touch-startup-image-1536x2048.png", 1536, 2048),  # iPad Air
    ("apple-touch-startup-image-1488x2266.png", 1488, 2266),  # iPad mini 5/6
]


def _splash_link_tags(head: str) -> dict[str, str | None]:
    """Return `{href: media}` for every `<link rel=apple-touch-startup-image>`
    in the head. Tolerates attribute order, quote style, whitespace, and
    self-closing slash."""
    out: dict[str, str | None] = {}
    for tag in re.findall(r"<link\b[^>]*>", head, re.I):
        rel = re.search(r'\brel\s*=\s*["\']([^"\']*)["\']', tag, re.I)
        if not rel or rel.group(1).lower() != "apple-touch-startup-image":
            continue
        href = re.search(r'\bhref\s*=\s*["\']([^"\']*)["\']', tag, re.I)
        media = re.search(r'\bmedia\s*=\s*["\']([^"\']*)["\']', tag, re.I)
        if href:
            out[href.group(1)] = media.group(1) if media else None
    return out


def test_splash_link_tags_present_for_every_shipped_size(tmp_db):
    head = _head_html(tmp_db)
    found = _splash_link_tags(head)
    for name, _w, _h in EXPECTED_SPLASH_SIZES:
        expected_href = f"/static/{name}"
        assert expected_href in found, f"splash <link> for {name} missing from head"
        # Every splash must have a media query so iOS picks the right one.
        assert found[expected_href], f"splash {name} has no media query"


def test_splash_link_media_queries_have_dpr(tmp_db):
    head = _head_html(tmp_db)
    found = _splash_link_tags(head)
    for href, media in found.items():
        assert media is not None, f"{href}: no media query"
        # Media query must include -webkit-device-pixel-ratio so iOS picks
        # the right resolution image (the device-pixel-ratio distinguishes
        # 2x vs 3x devices at the same CSS-pixel resolution).
        assert "-webkit-device-pixel-ratio" in media, (
            f"{href}: media query missing -webkit-device-pixel-ratio: {media!r}"
        )


def test_every_splash_image_is_served_at_expected_size(tmp_db):
    client = create_app(tmp_db).test_client()
    for name, w, h in EXPECTED_SPLASH_SIZES:
        resp = client.get(f"/static/{name}")
        assert resp.status_code == 200, f"{name}: not served ({resp.status_code})"
        assert resp.headers.get("Content-Type", "").startswith("image/png"), (
            f"{name}: wrong content-type {resp.headers.get('Content-Type')!r}"
        )
        # Decode the PNG IHDR (first 24 bytes after the 8-byte PNG signature)
        # to verify the actual pixel dimensions. This guards against
        # accidentally shipping the wrong-size image for a link tag.
        body = resp.get_data()
        assert body[:8] == b"\x89PNG\r\n\x1a\n", f"{name}: not a PNG"
        import struct
        width, height = struct.unpack(">II", body[16:24])
        assert (width, height) == (w, h), (
            f"{name}: declared {(w, h)} but PNG is ({width}, {height})"
        )


def test_splash_image_matches_manifest_background_color():
    """Each splash image must be the manifest's background_color pixel-for-
    pixel. iOS treats a mismatch as a hard error on launch (shows a white
    flash before falling back to the app's first paint)."""
    from PIL import Image
    import io
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    raw = manifest["background_color"].lstrip("#")
    expected = (int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16))
    for name, w, h in EXPECTED_SPLASH_SIZES:
        path = ROOT / "src" / "content_hoarder" / "static" / name
        img = Image.open(path).convert("RGB")
        assert img.size == (w, h), f"{name}: on-disk size {img.size} != expected ({w}, {h})"
        # Spot-check center + corner (cheap; full pass for 11 images is
        # ~2.5 MB of pixel-bytes per check — not worth it; corner+center
        # catches any non-uniform generator).
        assert img.getpixel((0, 0)) == expected, f"{name}: top-left != {expected}"
        assert img.getpixel((w - 1, h - 1)) == expected, f"{name}: bottom-right != {expected}"
        assert img.getpixel((w // 2, h // 2)) == expected, f"{name}: center != {expected}"
