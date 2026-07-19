"""Generate iOS `apple-touch-startup-image` splash screens.

Strategy: solid-color PNG matching `manifest.webmanifest`'s `background_color`
(`#0f1115`). Apple does NOT require the icon/logo in the launch image — the
manifest's `background_color` IS the launch surface, and the icon is rendered
on top by iOS itself. A solid-color image at the device's actual pixel
resolution lets iOS pick the closest match, scaling the rest.

Devices covered (2026-07-19 — covers every shipping iPhone + iPad):
- iPhone 16 Pro Max / 15 Pro Max / 14 Pro Max : 1290x2796 portrait
- iPhone 16 / 15 / 14 Pro                     : 1179x2556 portrait
- iPhone 16 Plus / 15 Plus / 14 Plus          : 1290x2796 portrait (shared)
- iPhone 13 / 13 Pro / 12 / 12 Pro            : 1170x2532 portrait
- iPhone 13 mini / 12 mini                    : 1080x2340 portrait
- iPhone SE (3rd) / 8 / 7 / 6s                :  750x1334 portrait
- iPhone 5 / SE (1st) / iPod (legacy)         :  640x1136 portrait
- iPad Pro 12.9" (3rd-6th gen)                : 2048x2732 portrait
- iPad Pro 11" (1st-4th gen)                  : 1668x2388 portrait
- iPad Air 10.9" / 10.5" / 9.7"               : 1536x2048 portrait
- iPad mini (5th-6th gen)                     : 1488x2266 portrait

Generated images are RGB PNG, optimized. Each is ~5-15 KB (solid color
compresses extremely well). The 10 images total ≈ 100 KB — well under the SW
SHELL precache budget.

Apple's selection rules (https://developer.apple.com/library/archive/documentation/
AppleApplications/Reference/SafariHTMLRef/Articles/MetaTags.html): iOS picks the
launch image whose size most closely matches the device's screen pixel
dimensions. Listing all sizes gives iOS the closest fit for every device.

Source of truth for color: `manifest.webmanifest::background_color` and
`::theme_color` (both `#0f1115`). If those change, re-run this generator.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parents[1]
STATIC = REPO / "src" / "content_hoarder" / "static"
MANIFEST = STATIC / "manifest.webmanifest"

# (filename, width, height) — physical pixels. Sort by descending area so
# the largest (iPhone Pro Max) comes first in the SHELL.
SIZES: list[tuple[str, int, int]] = [
    ("apple-touch-startup-image-1290x2796.png", 1290, 2796),  # iPhone 16/15/14 Pro Max, 16/15 Plus
    ("apple-touch-startup-image-1179x2556.png", 1179, 2556),  # iPhone 16/15/14 Pro
    ("apple-touch-startup-image-1170x2532.png", 1170, 2532),  # iPhone 14/13/13 Pro/12/12 Pro
    ("apple-touch-startup-image-1080x2340.png", 1080, 2340),  # iPhone 13/12 mini
    ("apple-touch-startup-image-750x1334.png",    750, 1334),  # iPhone SE3 / 8 / 7 / 6s
    ("apple-touch-startup-image-640x1136.png",    640, 1136),  # iPhone 5 / SE1 / iPod touch 5+
    ("apple-touch-startup-image-2048x2732.png", 2048, 2732),  # iPad Pro 12.9 (3rd-6th)
    ("apple-touch-startup-image-1668x2388.png", 1668, 2388),  # iPad Pro 11 (1st-4th)
    ("apple-touch-startup-image-1668x2224.png", 1668, 2224),  # iPad Pro 10.5
    ("apple-touch-startup-image-1536x2048.png", 1536, 2048),  # iPad Air 10.9/10.5/9.7
    ("apple-touch-startup-image-1488x2266.png", 1488, 2266),  # iPad mini 5/6
]
def _bg_color() -> tuple[int, int, int]:
    """Read `background_color` from manifest.webmanifest and parse as RGB.

    Strips a leading '#'. Raises if the value isn't a valid 6-digit hex.
    """
    text: str = MANIFEST.read_text(encoding="utf-8")
    data: dict[str, object] = json.loads(text)
    raw_obj = data["background_color"]
    if not isinstance(raw_obj, str):
        raise TypeError(f"background_color must be a string, got {type(raw_obj).__name__}")
    raw: str = raw_obj.lstrip("#")
    if len(raw) != 6:
        raise ValueError(f"background_color must be 6-digit hex, got {raw_obj!r}")
    return (int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16))


def main() -> int:
    bg = _bg_color()
    print(f"background_color from manifest: #{bg[0]:02x}{bg[1]:02x}{bg[2]:02x}")
    total_bytes = 0
    for name, w, h in SIZES:
        out = STATIC / name
        img = Image.new("RGB", (w, h), color=bg)
        img.save(out, "PNG", optimize=True)
        size = out.stat().st_size
        total_bytes += size
        print(f"  {name}: {w}x{h} -> {size:,} bytes")
    print(f"\nTotal: {len(SIZES)} images, {total_bytes:,} bytes ({total_bytes / 1024:.1f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
