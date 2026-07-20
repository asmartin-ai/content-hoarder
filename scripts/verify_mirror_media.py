"""verify_mirror_media.py — re-hash every blob under a media-mirror DEST
and compare each file's sha256 to its filename (content-addressed; the
filename IS the hash). Companion to scripts/mirror-media.bat and the
verify-mirror-media.bat shim that calls it.

Exit codes:
  0 = all blobs verified
  1 = one or more mismatches
  2 = DEST missing (mirrored-media dir not initialised yet)

The algorithm:
  for every file f under DEST:
    expected = filename (without extension)
    actual   = sha256(f.contents)
    if actual != expected: MISMATCH line, count++

A single Python implementation means the .bat shim, the spec, and the
test suite all use the same logic. The .bat becomes a 1-liner.
"""

from __future__ import annotations

import hashlib
import os
import sys
from pathlib import Path


def verify_mirror(dest: str | os.PathLike[str]) -> tuple[int, int, list[str]]:
    """Walk ``dest``; for each file, compare sha256(contents) to the
    filename (sans extension). Returns ``(checked, mismatched, mismatch_lines)``.

    Files whose filename isn't a 64-hex sha256 (e.g. a stray ``.DS_Store`` or
    an in-flight ``.tmp`` write) are reported as ``non_blob`` but do NOT count
    as a MISMATCH — the verify pass should be tolerant of housekeeping
    artifacts. The first 20 non-blob paths are echoed to stderr so the
    operator can investigate; more than 20 is summarised.
    """
    d = Path(dest)
    if not d.exists():
        print(f"ERROR: dest does not exist: {d}", file=sys.stderr)
        print("Run scripts/mirror-media.bat first.", file=sys.stderr)
        return 0, 0, []

    checked = 0
    mismatched = 0
    mismatch_lines: list[str] = []
    non_blob: list[str] = []

    for p in d.rglob("*"):
        if not p.is_file():
            continue
        stem = p.stem
        if not (len(stem) == 64 and all(c in "0123456789abcdef" for c in stem)):
            non_blob.append(str(p))
            continue
        checked += 1
        h = hashlib.sha256(p.read_bytes()).hexdigest()
        if h != stem:
            mismatched += 1
            mismatch_lines.append(f"MISMATCH {p}  expected={stem}  got={h}")

    if mismatched:
        for line in mismatch_lines:
            print(line)
    if non_blob:
        shown = non_blob[:20]
        for path in shown:
            print(f"non-blob (skipped): {path}", file=sys.stderr)
        if len(non_blob) > 20:
            print(
                f"... and {len(non_blob) - 20} more non-blob files",
                file=sys.stderr,
            )

    print(
        f"\n=== Result ===\n  files checked: {checked}\n  mismatches:    {mismatched}"
    )
    if mismatched:
        print(f"\nFAILED: {mismatched} blob(s) failed integrity check.")
    elif checked:
        print("\nOK: all blobs verified.")

    return checked, mismatched, mismatch_lines


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    dest = argv[0] if argv else r"K:\MediaMirror\content-hoarder\media"
    if not Path(dest).exists():
        print(f"ERROR: dest does not exist: {dest}", file=sys.stderr)
        print("Run scripts/mirror-media.bat first.", file=sys.stderr)
        return 1
    checked = verify_mirror(dest)
    return 1 if checked[1] else 0


if __name__ == "__main__":
    raise SystemExit(main())
