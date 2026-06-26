"""WP2 Task 29 — Unused app.css selectors audit.

app.css (~2100 lines) is consumed by /triage and /reddit (legacy v2 pages).
Cross-reference every CSS selector against HTML templates and JS files.
"""

import re
from pathlib import Path

CSS_FILE = Path("src/content_hoarder/static/app.css")
TEMPLATES = list(Path("src/content_hoarder/templates").glob("*.html"))
JS_FILES = [
    Path("src/content_hoarder/static/app.js"),
    Path("src/content_hoarder/static/triage.js"),
    Path("src/content_hoarder/static/reddit.js"),
    Path("src/content_hoarder/static/sw.js"),
    Path("src/content_hoarder/static/core/util.js"),
    Path("src/content_hoarder/static/core/api.js"),
    Path("src/content_hoarder/static/core/render.js"),
    Path("src/content_hoarder/static/core/media.js"),
    Path("src/content_hoarder/static/core/swipe.js"),
    Path("src/content_hoarder/static/core/icons.js"),
    Path("src/content_hoarder/static/core/tags.js"),
    Path("src/content_hoarder/static/browse/main.js"),
    Path("src/content_hoarder/static/browse/render.js"),
    Path("src/content_hoarder/static/browse/reader.js"),
    Path("src/content_hoarder/static/browse/palette.js"),
    Path("src/content_hoarder/static/browse/prefetch.js"),
]

TEMPLATES_DIR = Path("src/content_hoarder/templates")


def extract_selectors(css_text: str) -> list[dict[str, str | int]]:
    """Extract CSS selectors with their line numbers."""
    selectors = []
    # Remove comments
    text = re.sub(r"/\*.*?\*/", "", css_text, flags=re.DOTALL)
    # Split into rule blocks
    blocks = re.finditer(r"([^@}]*?)\{([^}]*)\}", text, re.DOTALL)
    for block in blocks:
        raw = block.group(1).strip()
        if not raw:
            continue
        # Split by comma for multi-selector rules
        parts = [p.strip() for p in raw.split(",") if p.strip()]
        for sel in parts:
            # Skip pseudo-elements and keyframe names
            if sel.startswith("@") or sel.startswith("--"):
                continue
            # Get the primary selector (before any pseudo-class)
            primary = re.split(r":[:\s]", sel)[0].strip()
            if primary and primary.startswith(
                (
                    ".",
                    "#",
                    "[",
                    "a",
                    "b",
                    "d",
                    "f",
                    "h",
                    "i",
                    "l",
                    "m",
                    "n",
                    "p",
                    "s",
                    "t",
                    "u",
                    "w",
                )
            ):
                selectors.append({"selector": sel, "primary": primary})
    return selectors


def selector_in_files(selector: str, all_content: str) -> bool:
    """Check if a CSS selector pattern appears in any template/JS file."""
    # For class selectors, check for className references or class="..."
    if selector.startswith("."):
        cls = selector[1:]
        # Check for class="<name>", className, classList, `name`, .name,
        # template literals with the name, and JS element creation
        patterns = [
            f'class="{cls}"',
            f"class='{cls}'",
            f".{cls}",
            f'"{cls}"',
            f"'{cls}'",
            f"`{cls}`",
            f"addClass('{cls}'",
            f'addClass("{cls}"',
            f'toggleClass("{cls}"',
            f"toggleClass('{cls}'",
            f"removeClass('{cls}'",
            f'removeClass("{cls}"',
            f".classList.add('{cls}'",
            f'.classList.add("{cls}"',
            f".classList.remove('{cls}'",
            f'.classList.remove("{cls}"',
            f".classList.toggle('{cls}'",
            f'.classList.toggle("{cls}"',
            f"contains('{cls}'",
            f'contains("{cls}"',
            f'querySelector(".{cls}"',
            f"querySelector('.{cls}'",
            f'querySelectorAll(".{cls}"',
            f"querySelectorAll('.{cls}'",
            f".matches('.{cls}'",
            f".matches('.{cls} ",
            f"cls = '{cls}'",
            f'cls = "{cls}"',
        ]
        for p in patterns:
            if p in all_content:
                return True
        # Also check for any reference to the class name as a literal string
        if f".{cls}" in all_content:
            return True
    # For ID selectors, check for id="..."
    elif selector.startswith("#"):
        id_val = selector[1:]
        patterns = [
            f'id="{id_val}"',
            f"id='{id_val}'",
            f"getElementById('{id_val}'",
            f'getElementById("{id_val}"',
        ]
        for p in patterns:
            if p in all_content:
                return True
    # For element selectors (input, button, etc) — assume used
    # For attribute selectors — check the full pattern
    else:
        if selector in all_content:
            return True

    return False


css = CSS_FILE.read_text(encoding="utf-8")
selectors = extract_selectors(css)

# Concatenate all template/JS content for efficient search
all_content = ""
for f in list(TEMPLATES) + JS_FILES:
    if f.exists():
        all_content += f.read_text(encoding="utf-8", errors="replace")

# Also search all JS and HTML in the project
for f in Path("src/content_hoarder/static").rglob("*.js"):
    if f.exists():
        all_content += f.read_text(encoding="utf-8", errors="replace")
for f in Path("src/content_hoarder/static").rglob("*.html"):
    if f.exists():
        all_content += f.read_text(encoding="utf-8", errors="replace")

print(f"Total selectors in app.css: {len(selectors)}")
print()

# Known-referenced selectors (used by browse v3 which has its own CSS but may reference app.css)
# These are from core/ modules that app.css is NOT the primary stylesheet for
V3_CORE_REFS = {
    "toast",
    "toast-content",
    "snackbar",
    "bulk-bar",
    "opsbar",
}

unused = []
used = []
for s in selectors:
    sel = s["selector"]
    primary = s["primary"]
    # Skip obvious false positives
    if primary.startswith(":") or primary.startswith("::"):
        continue
    if selector_in_files(primary, all_content) or primary in V3_CORE_REFS:
        used.append(s)
    else:
        unused.append(s)

print(f"Used selectors: {len(used)}")
print(f"Potentially unused selectors: {len(unused)}")
print()

if unused:
    print("=== Potentially unused selectors ===")
    for s in unused:
        print(f"  {s['selector']}")
    print()
    print(
        f"NOTE: Some may be used dynamically (JS className construction,"
        f" template literals, or v3 core references)."
        f" Review before deletion."
    )
else:
    print("All selectors appear to be referenced.")
