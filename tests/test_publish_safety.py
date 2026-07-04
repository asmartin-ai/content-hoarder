"""Tests for scripts/publish_safety_check.py — the #73 publication safety gate."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "scripts" / "publish_safety_check.py"


def _load_script():
    spec = importlib.util.spec_from_file_location("publish_safety_check", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["publish_safety_check"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def ps():
    return _load_script()


def test_sensitive_path_patterns_match_real_leaks(ps):
    """Each gitignored-sensitive path must trip the DATA pattern."""
    bad = [
        ".env",
        "data/app.db",
        "data/app.db-wal",
        "data/media/abc.jpg",
        "exports/items.csv",
        "data/app.backup-2026-01-01.db",
        "nsfw_rules.json",
        "data/delete-audit.jsonl",
        "stuff.sqlite",
    ]
    for p in bad:
        assert any(pat.search(p) for pat in ps.SENSITIVE_PATH_PATTERNS), f"missed: {p}"


def test_sensitive_path_patterns_skip_public_safe(ps):
    """Public-safe paths must NOT trip the DATA pattern (no false positives)."""
    ok = [
        "src/content_hoarder/db.py",
        "src/content_hoarder/web.py",
        "tests/test_db.py",
        "docs/specs/10-media-backup.md",
        ".env.example",
        "nsfw_rules.example.json",
        "scripts/publish_safety_check.py",
        "README.md",
    ]
    for p in ok:
        assert not any(pat.search(p) for pat in ps.SENSITIVE_PATH_PATTERNS), f"false-positive: {p}"


def test_secret_patterns_match_real_secret_shapes(ps):
    """High-confidence secret shapes must match."""
    aws = "AWS key: AKIAABCDEFGHIJKLMNOP"
    assert ps.SECRET_PATTERNS[0].search(aws)
    pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIE..."
    assert any(pat.search(pem) for pat in ps.SECRET_PATTERNS)
    assignment = 'client_secret = "abcdefghijklmnopqrstuvwxyz1234567890"'
    assert any(pat.search(assignment) for pat in ps.SECRET_PATTERNS)


def test_placeholder_lines_not_flagged(ps):
    """Lines that are obviously placeholders/examples must not be SECRET hits."""
    placeholders = [
        'FLASK_SECRET_KEY=change-me-to-something-random',
        'KARAKEEP_API_KEY=your-key-here',
        'client_secret = "<your-secret>"',
        'api_key = "{{REDACTED}}"',
    ]
    for line in placeholders:
        # Mirror the script's own filter: if PLACEHOLDER_LINE_RE matches the line,
        # the script skips it. Verify the filter does its job.
        assert ps.PLACEHOLDER_LINE_RE.search(line), f"placeholder not recognized: {line}"


def test_history_scan_returns_clean_on_this_repo():
    """This repo's history must be clean (the standing #73 invariant).

    Regression guard: if a future commit introduces a secret blob, this test
    fails before it can ship to the public mirror. Skip if git is unavailable.
    """
    pytest.importorskip("subprocess")
    import subprocess
    try:
        proc = subprocess.run(
            ["git", "-C", str(REPO), "rev-parse", "--is-inside-work-tree"],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            pytest.skip("not in a git worktree")
    except FileNotFoundError:
        pytest.skip("git not on PATH")

    ps = _load_script()
    hits = ps.history_blob_findings(max_blobs=10)
    assert hits == [], f"history scan found potential secrets: {hits}"
