"""verify-mirror-media.bat — synthetic corruption regression.

The .bat is a thin shim over scripts/verify_mirror_media.py; this test
exercises the Python helper directly (the .bat itself is cmd-internals
heavy and not unit-testable in CI). The contract:

  - sha256(file.contents) MUST equal file.stem (the source is
    content-addressed, so the filename IS the hash).
  - On mismatch -> 1 checked, 1 mismatched, exit code 1.
  - On all-good -> N checked, 0 mismatched, exit code 0.
  - Non-blob housekeeping files (no 64-hex stem) are skipped, not flagged
    as mismatches.
  - Missing dest -> exit code 1 + stderr.
"""

from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from verify_mirror_media import verify_mirror  # noqa: E402


def _write_blob(dest: Path, name: str, data: bytes) -> Path:
    """Write ``data`` to ``dest/name``. ``name`` is typically the sha256
    of ``data``, but a test may pass a STALE name to simulate corruption —
    the function doesn't enforce correctness, so the test can model
    content-addressing break."""
    p = dest / name
    p.write_bytes(data)
    return p


def test_verify_mirror_reports_mismatch_when_one_byte_flipped(tmp_path):
    """The headline regression: a 1-byte corruption must produce
    MISMATCH and a non-zero exit. Without this test, the verify path
    was only ever exercised against known-good mirrors."""
    # A clean blob, named after its own hash.
    good_data = b"hello world - pretend this is a recovered reddit image blob"
    good_name = hashlib.sha256(good_data).hexdigest()
    good = _write_blob(tmp_path, good_name, good_data)

    # A different payload whose on-disk name we keep STABLE, then mutate
    # the bytes so the name no longer matches the contents.
    raw_bad = b"another video clip bytes that should hash differently"
    bad_name = hashlib.sha256(raw_bad).hexdigest()
    mutated = bytearray(raw_bad)
    mutated[7] ^= 0x01
    bad = _write_blob(tmp_path, bad_name, bytes(mutated))

    assert good.exists() and bad.exists()
    assert good.stem != bad.stem  # distinct files, no overwrite
    # The corruption invariant: name says one thing, contents say another.
    assert bad.stem == bad_name != hashlib.sha256(bytes(mutated)).hexdigest()

    checked, mismatched, lines = verify_mirror(tmp_path)

    assert checked == 2, f"both files should be checked, got {checked}"
    assert mismatched == 1, f"exactly one MISMATCH expected, got {mismatched}"
    assert len(lines) == 1
    line = lines[0]
    assert line.startswith("MISMATCH")
    assert str(bad) in line
    assert hashlib.sha256(bytes(mutated)).hexdigest() in line
    # The good file is the one NOT in the MISMATCH line.
    assert str(good) not in line


def test_verify_mirror_exits_nonzero_on_mismatch_via_subprocess(tmp_path):
    """The .bat surfaces a non-zero exit; the helper's ``main`` must too.
    Drive it as a subprocess so the CLI entrypoint is the contract."""
    raw = b"x" * 4096
    name = hashlib.sha256(raw).hexdigest()
    _write_blob(tmp_path, name, raw)
    # Corrupt the same way.
    mutated = bytearray(raw)
    mutated[0] ^= 0xFF
    (tmp_path / name).write_bytes(bytes(mutated))

    r = subprocess.run(
        [sys.executable, str(SCRIPTS / "verify_mirror_media.py"), str(tmp_path)],
        capture_output=True,
        text=True,
    )
    assert r.returncode == 1, (
        f"expected exit 1 on mismatch, got {r.returncode}\n"
        f"stdout: {r.stdout}\nstderr: {r.stderr}"
    )
    assert "MISMATCH" in r.stdout
    assert "FAILED:" in r.stdout


def test_verify_mirror_passes_on_all_good_blobs_in_process(tmp_path):
    """Sanity: a clean mirror -> 0 mismatches, exit 0 (in-process call)."""
    for payload in (b"alpha", b"bravo", b"charlie" * 100):
        h = hashlib.sha256(payload).hexdigest()
        (tmp_path / h).write_bytes(payload)

    checked, mismatched, lines = verify_mirror(tmp_path)
    assert checked == 3
    assert mismatched == 0
    assert lines == []


def test_verify_mirror_passes_via_subprocess_on_all_good_blobs(tmp_path):
    for payload in (b"alpha", b"bravo", b"charlie" * 100):
        (tmp_path / hashlib.sha256(payload).hexdigest()).write_bytes(payload)

    r = subprocess.run(
        [sys.executable, str(SCRIPTS / "verify_mirror_media.py"), str(tmp_path)],
        capture_output=True,
        text=True,
    )
    assert r.returncode == 0, r.stdout + r.stderr
    assert "OK: all blobs verified." in r.stdout
    assert "files checked: 3" in r.stdout


def test_verify_mirror_skips_non_blob_housekeeping_files(tmp_path):
    """``.DS_Store``, ``Thumbs.db``, in-flight ``.tmp`` writes — none of
    these have a 64-hex stem and none should count as a MISMATCH."""
    good = b"a clean blob"
    (tmp_path / hashlib.sha256(good).hexdigest()).write_bytes(good)
    (tmp_path / "Thumbs.db").write_bytes(b"not a blob")
    (tmp_path / "subdir").mkdir()
    (tmp_path / "subdir" / "garbage.txt").write_text("junk")

    checked, mismatched, lines = verify_mirror(tmp_path)
    assert checked == 1
    assert mismatched == 0
    assert lines == []


def test_verify_mirror_missing_dest_returns_nonzero_via_subprocess(tmp_path):
    """A non-existent dest should produce exit 1, mirroring the .bat's
    'ERROR: dest does not exist' branch (with stderr)."""
    missing = tmp_path / "no-such-dir"
    r = subprocess.run(
        [sys.executable, str(SCRIPTS / "verify_mirror_media.py"), str(missing)],
        capture_output=True,
        text=True,
    )
    assert r.returncode == 1
    assert "ERROR" in r.stderr or "dest does not exist" in r.stderr
