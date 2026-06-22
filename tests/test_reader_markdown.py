"""Reader markdown renderer (Epic 15 P2): core/markdown.js renderMarkdown().

Reddit post self-text + comment bodies are markdown; the inline reader used to print
them as plain escaped text. renderMarkdown() turns a safe subset (links, bold/italic,
> quotes, lists, `code`, bare URLs) into HTML. It MUST stay XSS-safe — raw text is
escaped first and only a known tag set is ever inserted. Pure + node-testable.

node-backed; skips when node is unavailable.
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

STATIC = Path(__file__).resolve().parents[1] / "src" / "content_hoarder" / "static"


def _render(md, media=None):
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    opts = json.dumps({"media": media}) if media else "null"
    script = (
        "import { renderMarkdown } from './core/markdown.js';"
        f"console.log(renderMarkdown({json.dumps(md)}, {opts}));"
    )
    r = subprocess.run(
        [node, "--input-type=module", "-e", script],
        capture_output=True, text=True, cwd=STATIC,
    )
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


def test_empty_and_blank_render_to_nothing():
    assert _render("") == ""
    assert _render("   \n\n  ") == ""


def test_pipe_table_renders():
    out = _render("| A | B |\n| --- | --- |\n| 1 | 2 |")
    assert "<table" in out and "<thead>" in out and "<tbody>" in out
    assert "<th>A</th>" in out and "<th>B</th>" in out
    assert "<td>1</td>" in out and "<td>2</td>" in out
    assert "|" not in out  # pipes consumed into the table, not printed literally


def test_table_cells_run_inline_transforms():
    out = _render("| Name | Link |\n|:---|---:|\n| **bob** | [x](https://e.com) |")
    assert "<strong>bob</strong>" in out
    assert '<a href="https://e.com"' in out


def test_bold_italic_inline_code():
    out = _render("a **bold** and *italic* and `code` here")
    assert "<strong>bold</strong>" in out
    assert "<em>italic</em>" in out
    assert "<code>code</code>" in out


def test_inline_code_protects_its_contents():
    # markdown syntax inside a code span must NOT be transformed
    out = _render("`**not bold**`")
    assert "<code>**not bold**</code>" in out
    assert "<strong>" not in out


def test_markdown_link_is_safe_and_targets_blank():
    out = _render("see [the docs](https://example.com/a?x=1&y=2)")
    assert 'href="https://example.com/a?x=1&amp;y=2"' in out
    assert 'rel="noopener nofollow"' in out and 'target="_blank"' in out
    assert ">the docs</a>" in out


def test_unsafe_link_href_is_dropped_keeps_text():
    out = _render("[click](javascript:alert(1))")
    assert "javascript" not in out          # no javascript: sink anywhere
    assert "<a " not in out                 # the unsafe href is dropped entirely
    assert "click" in out                   # but the visible text survives


def test_bare_url_linkified_trailing_paren_excluded():
    out = _render("(see https://x.com/a)")
    assert 'href="https://x.com/a"' in out
    assert "</a>)" in out                   # the ")" stays OUTSIDE the link


def test_blockquote_and_lists():
    assert "<blockquote>quoted</blockquote>" in _render("> quoted")
    ul = _render("- one\n- two")
    assert ul == "<ul><li>one</li><li>two</li></ul>"
    ol = _render("1. first\n2. second")
    assert ol == "<ol><li>first</li><li>second</li></ol>"


def test_fenced_code_block_skips_inline_transforms():
    out = _render("```\n**raw** and [x](y)\n```")
    assert "<pre><code>" in out and "**raw**" in out
    assert "<strong>" not in out and "<a " not in out


def test_paragraphs_split_on_blank_line_single_newline_is_br():
    out = _render("line one\nline two\n\nsecond para")
    assert out == "<p>line one<br>line two</p><p>second para</p>"


def test_xss_raw_html_is_escaped_not_executed():
    out = _render("<script>alert(1)</script> <img src=x onerror=y>")
    assert "<script>" not in out and "<img" not in out
    assert "&lt;script&gt;" in out


def test_snake_case_not_italicised():
    out = _render("a snake_case_word here")
    assert "<em>" not in out and "snake_case_word" in out


# --- embedded images (Epic 15): markdown ![](url), Reddit media-ids, bare URLs, host allowlist ---

def test_markdown_image_allowlisted_host_renders_img():
    out = _render("![cat](https://i.redd.it/cat.jpg)")
    assert '<img' in out and 'class="md-img"' in out
    assert 'src="https://i.redd.it/cat.jpg"' in out
    assert 'data-img="https://i.redd.it/cat.jpg"' in out
    assert 'referrerpolicy="no-referrer"' in out
    assert '<a' not in out                       # image, not the link fallback
    assert not out.lstrip('<p>').startswith('!') # the leading "!" wasn't left dangling


def test_markdown_image_non_allowlisted_host_falls_back_to_link():
    out = _render("![x](https://evil.example/x.jpg)")
    assert '<img' not in out                      # untrusted host -> no inline image
    assert '<a href="https://evil.example/x.jpg"' in out  # safe click-through instead


def test_markdown_image_unsafe_scheme_is_neither_img_nor_link():
    out = _render("![x](javascript:alert(1))")
    assert '<img' not in out and '<a' not in out and 'javascript' not in out


def test_reddit_media_id_resolves_to_img_and_escapes_url():
    media = {"abc123": {"u": "https://preview.redd.it/abc.png?width=640&s=xyz", "kind": "image"}}
    out = _render("look ![img](abc123)", media)
    assert '<img' in out
    assert 'src="https://preview.redd.it/abc.png?width=640&amp;s=xyz"' in out  # & escaped in attr


def test_giphy_media_id_renders_img():
    media = {"giphy|RAND": {"u": "https://i.giphy.com/media/RAND/giphy.gif", "kind": "gif"}}
    out = _render("![gif](giphy|RAND)", media)
    assert '<img' in out and 'giphy.gif' in out


def test_unknown_media_id_without_url_degrades_to_alt_text():
    out = _render("![img](notamediaid)")           # not a URL, not in the media map
    assert '<img' not in out and '<a' not in out
    assert 'img' in out                            # the alt text survives


def test_bare_allowlisted_image_url_renders_inline():
    out = _render("look https://i.redd.it/x.png here")
    assert '<img' in out and 'src="https://i.redd.it/x.png"' in out
    assert 'here' in out                           # surrounding text preserved


def test_bare_non_image_url_stays_a_link():
    out = _render("see https://example.com/page for more")
    assert '<img' not in out and '<a href="https://example.com/page"' in out


def test_image_alt_is_escaped_no_attribute_injection():
    out = _render('![" onerror=alert(1)](https://i.redd.it/x.jpg)')
    assert '<img' in out
    assert '"onerror' not in out and '" onerror' not in out   # the quote was escaped
    assert '&quot;' in out                                     # ...to its entity form
