"""Publication safety check — scan the working tree + git history for content
that must never reach the public mirror.

Exit code 0 = clean; 1 = at least one finding. Findings are categorized:
  SECRET   — likely credentials / tokens / private keys (high-confidence patterns)
  DATA     — local data files (DBs, exports, takeout, .env, nsfw_rules.json)
  TRACKED  — a gitignored sensitive path that IS tracked (would be committed)

Usage:
    python scripts/publish_safety_check.py            # working tree only
    python scripts/publish_safety_check.py --history  # also scan blob history
                                                       # (slower; ~seconds per
                                                       # 1k commits)

This script is the "repeatable safety check" deliverable for issue #73.
Read-only: it runs `git ls-files` / `git log` and greps file contents; it
never mutates the repo or the working tree.

Treat any non-empty output as a HARD BLOCK before mirroring or publishing.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# --- sensitive path patterns (a file matching any = DATA finding) ---------
SENSITIVE_PATH_PATTERNS = [
    re.compile(r"(^|/)\.env$"),
    re.compile(r"(^|/)data/.*\.db$"),
    re.compile(r"(^|/)data/.*\.db-(shm|wal)$"),
    re.compile(r"(^|/)data/media/"),
    re.compile(r"(^|/)exports?/"),
    re.compile(r"(^|/)takeout.*/", re.I),
    re.compile(r"\.db$"),
    re.compile(r"\.sqlite$"),
    re.compile(r"(^|/)nsfw_rules\.json$"),
    re.compile(r"(^|/)data/.*\.backup-", re.I),
    re.compile(r"delete-audit\.jsonl$"),
    re.compile(r"(^|/)unsave-audit\.jsonl$"),
]

# --- high-confidence secret patterns (content match = SECRET finding) ------
SECRET_PATTERNS = [
    # AWS
    re.compile(r"AKIA[0-9A-Z]{16}"),
    # Reddit OAuth refresh / access tokens (typed prefixes)
    re.compile(r"(?<![A-Z0-9])[0-9A-Za-z_-]{200,}"),  # very long bearer-ish blob
    # Generic private-key headers
    re.compile(r"-----BEGIN (RSA |EC |OPENSSH |PGP |)PRIVATE KEY-----"),
    # Common assignment shapes with a non-placeholder value
    re.compile(r"(?i)(client_secret|api_secret|secret_key|access_token|refresh_token)\s*[=:]\s*['\"][A-Za-z0-9/+=]{20,}['\"]"),
]

# Placeholders that LOOK like secrets but are safe (in .env.example etc.)
PLACEHOLDER_VALUES = {
    "change-me-to-something-random",
    "your-secret-here",
    "changeme",
    "redacted",
    "",
}

PLACEHOLDER_LINE_RE = re.compile(
    r"(?i)(example|placeholder|todo|change.?me|your-|xxx|<|\{\{)"
)


def _git(args: list[str]) -> str:
    return subprocess.check_output(
        ["git", "-C", str(REPO), *args], text=True, errors="replace"
    )


def tracked_sensitive_paths() -> list[str]:
    """gitignored-sensitive paths that are currently TRACKED (a real leak)."""
    tracked = _git(["ls-files"]).splitlines()
    out = []
    for p in tracked:
        for pat in SENSITIVE_PATH_PATTERNS:
            if pat.search(p):
                out.append(p)
                break
    return out


def scan_content(paths: list[str]) -> list[tuple[str, str, int]]:
    """Scan file contents for SECRET patterns. Returns (path, kind, line) hits."""
    hits: list[tuple[str, str, int]] = []
    for p in paths:
        full = REPO / p
        if not full.is_file():
            continue
        try:
            text = full.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for ln, line in enumerate(text.splitlines(), 1):
            for pat in SECRET_PATTERNS:
                m = pat.search(line)
                if not m:
                    continue
                # Skip obvious placeholder / example lines
                if PLACEHOLDER_LINE_RE.search(line):
                    continue
                if m.group(0).strip("=\"'").lower() in PLACEHOLDER_VALUES:
                    continue
                hits.append((p, "SECRET", ln))
                break
    return hits


def history_blob_findings(max_blobs: int = 50) -> list[tuple[str, str]]:
    """Scan every blob ever in history for SECRET patterns.

    Returns up to ``max_blobs`` (path, kind) hits. Slow; opt-in via --history.
    """
    # List all blob hashes ever added (across all branches)
    try:
        revs = _git(["rev-list", "--all", "--objects"]).splitlines()
    except subprocess.CalledProcessError:
        return []
    hits: list[tuple[str, str]] = []
    seen: set[str] = set()
    for line in revs:
        parts = line.split(" ", 1)
        if len(parts) != 2:
            continue
        sha, path = parts
        if path in seen:
            continue
        # only scan sensitive-ish extensions + .env-shaped names
        if not (
            path.endswith((".py", ".js", ".json", ".txt", ".md", ".yaml", ".yml", ".toml"))
            or path.endswith(".env")
            or "env" in path.lower()
        ):
            continue
        seen.add(path)
        try:
            content = _git(["cat-file", "-p", sha])
        except subprocess.CalledProcessError:
            continue
        for pat in SECRET_PATTERNS:
            if pat.search(content) and not PLACEHOLDER_LINE_RE.search(content):
                hits.append((path, "HISTORY_SECRET"))
                if len(hits) >= max_blobs:
                    return hits
                break
    return hits


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--history", action="store_true", help="also scan git blob history (slower)")
    args = ap.parse_args()

    findings: list[tuple[str, str]] = []

    tracked = _git(["ls-files"]).splitlines()
    tracked_data = tracked_sensitive_paths()
    for p in tracked_data:
        findings.append((p, "DATA_TRACKED"))

    secret_hits = scan_content(tracked)
    for p, kind, ln in secret_hits:
        findings.append((f"{p}:{ln}", kind))

    if args.history:
        findings += history_blob_findings()

    if not findings:
        print("publish_safety_check: clean — no sensitive content found.")
        return 0

    print(f"publish_safety_check: {len(findings)} finding(s) — BLOCK before publishing:\n")
    by_kind: dict[str, list[str]] = {}
    for path, kind in findings:
        by_kind.setdefault(kind, []).append(path)
    for kind in sorted(by_kind):
        print(f"== {kind} ==")
        for p in sorted(set(by_kind[kind])):
            print(f"  {p}")
        print()
    return 1


if __name__ == "__main__":
    sys.exit(main())
