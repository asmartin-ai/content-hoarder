"""One-shot generator: port static/icons.js to static/core/icons.js (ES module).

Extracts the icon data object verbatim from the classic script so the huge SVG
strings are never re-typed (transcription-corruption guard). Safe to re-run.
"""
import re
import pathlib

STATIC = pathlib.Path(__file__).resolve().parents[1] / "src" / "content_hoarder" / "static"
src = (STATIC / "icons.js").read_text(encoding="utf-8")

m = re.search(r"var D = (\{.*?\});\n", src, re.S)
firefox = re.search(r"D\.firefox = \{.*?\n  \};", src, re.S)
assert m and firefox, "extraction failed — icons.js layout changed?"

body = (
    '/* core/icons.js — ES-module port of static/icons.js (v3 pages).\n'
    '   chIcon(name, opts?) returns an inline-SVG HTML string that recolors via\n'
    '   currentColor. name: "keep" | "archive" | "done" (alias "trash") | "firefox".\n'
    '   Icons: Save (Alvida), archive (Kudicon), Trash (Julynn B.) — Noun Project,\n'
    '   CC BY 3.0, see static/CREDITS.md. fillIcons() hydrates [data-ico] holders.\n'
    '   GENERATED from static/icons.js by scripts/_gen_core_icons.py — edit there. */\n\n'
    "const D = " + m.group(1) + ";\n"
    "D.done = D.trash; // same wastebasket glyph\n"
    + firefox.group(0).replace("D.firefox", "D.firefox", 1) + "\n\n"
    "export function chIcon(name, opts) {\n"
    "  const d = D[name];\n"
    '  if (!d) return "";\n'
    "  opts = opts || {};\n"
    '  const sz = opts.size || "1em";\n'
    "  const cls = opts.className ? ' class=\"' + opts.className + '\"' : \"\";\n"
    "  return '<svg viewBox=\"' + d.vb + '\" width=\"' + sz + '\" height=\"' + sz + '\"' +\n"
    "    ' fill=\"currentColor\" preserveAspectRatio=\"xMidYMid meet\" aria-hidden=\"true\"' +\n"
    "    ' focusable=\"false\"' + cls +\n"
    "    ' style=\"display:inline-block;flex-shrink:0;vertical-align:-0.12em\">' +\n"
    "    d.inner + '</svg>';\n"
    "}\n\n"
    "/* Hydrate any static [data-ico] placeholder under root (default: document). */\n"
    "export function fillIcons(root) {\n"
    '  (root || document).querySelectorAll("[data-ico]").forEach((el) => {\n'
    '    if (!el.firstChild) el.innerHTML = chIcon(el.getAttribute("data-ico"));\n'
    "  });\n"
    "}\n"
)
dest = STATIC / "core" / "icons.js"
dest.write_text(body, encoding="utf-8")
print("written", dest, len(body), "chars")
