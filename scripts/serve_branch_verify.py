"""Serve ANY git ref's content_hoarder against the LIVE database — for browser
preview-verification, without disturbing the main checkout's branch.

Why this exists: the repo is `pip install -e .` (a plain `.pth` pointing at the
MAIN checkout's `src`), and branches like `staging/...` usually aren't checked out
anywhere. This launcher checks the target ref out into an EPHEMERAL git worktree,
forces that worktree's `src` onto `sys.path[0]` (overriding the editable `.pth`),
points `CONTENT_HOARDER_DB` at the live DB, and runs `content_hoarder serve`. The
ephemeral worktree is auto-removed on clean exit; `git worktree prune` on startup
plus per-ref replacement self-heal orphans left by a hard kill (Windows skips
atexit on TerminateProcess).

Usage:
    python scripts/serve_branch_verify.py [REF] [--port PORT]
    python scripts/serve_branch_verify.py --clean      # remove all ephemeral worktrees, exit

    REF    git ref/branch to serve. Default: $CH_VERIFY_REF or the staging branch.
    --port HTTP port.              Default: $CH_VERIFY_PORT or 8791.
    DB     $CONTENT_HOARDER_DB, else <main-repo>/data/app.db (the live hoard).

If REF is a branch already checked out in a worktree, that worktree is reused (no
ephemeral copy, never auto-removed). Otherwise the ref is checked out `--detach` so
a branch checked out elsewhere (main, the current feature branch) doesn't trip
"already checked out".

Reusable via launch.json — one named preset per branch you want one-click preview of:
    {"name": "staging-verify", "runtimeExecutable": "<venv python>",
     "runtimeArgs": ["<repo>/scripts/serve_branch_verify.py", "staging/session-2026-06-14"],
     "port": 8791}
"""
import atexit
import os
import runpy
import shutil
import signal
import subprocess
import sys
from pathlib import Path

MAIN_REPO = Path(__file__).resolve().parent.parent
DEFAULT_REF = os.environ.get("CH_VERIFY_REF", "staging/session-2026-06-14")
EPHEMERAL_PARENT = MAIN_REPO / ".verify-worktrees"

_created_worktree = None  # set only when WE created an ephemeral worktree (our cleanup target)


def _git(*args, check=True, capture=False):
    return subprocess.run(["git", "-C", str(MAIN_REPO), *args],
                          check=check, text=True, capture_output=capture)


def _parse_args(argv):
    ref, port, clean = None, os.environ.get("CH_VERIFY_PORT", "8791"), False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--clean":
            clean = True
        elif a == "--port":
            port = argv[i + 1]; i += 1
        elif a.startswith("--port="):
            port = a.split("=", 1)[1]
        elif ref is None and not a.startswith("-"):
            ref = a
        i += 1
    return (ref or DEFAULT_REF), str(int(port)), clean


def _worktrees():
    """Parsed `git worktree list --porcelain` -> list of {worktree, HEAD, branch, ...}."""
    out = _git("worktree", "list", "--porcelain", capture=True).stdout
    blocks, cur = [], {}
    for line in out.splitlines():
        if not line.strip():
            if cur:
                blocks.append(cur); cur = {}
            continue
        key, _, val = line.partition(" ")
        cur[key] = val
    if cur:
        blocks.append(cur)
    return blocks


def _existing_worktree_src(ref):
    """src/ path of a worktree that already has branch `ref` checked out, else None."""
    target = "refs/heads/" + ref
    for b in _worktrees():
        if b.get("branch") == target:
            return Path(b["worktree"]) / "src"
    return None


def _clean_all_ephemeral():
    """Manual reset: remove every ephemeral worktree we may have created."""
    if EPHEMERAL_PARENT.exists():
        for child in sorted(EPHEMERAL_PARENT.iterdir()):
            if child.is_dir():
                _git("worktree", "remove", "--force", str(child), check=False)
                shutil.rmtree(child, ignore_errors=True)
    _git("worktree", "prune", check=False)


def _make_ephemeral_worktree(ref):
    global _created_worktree
    if _git("rev-parse", "--verify", "--quiet", ref + "^{commit}",
            check=False, capture=True).returncode != 0:
        raise SystemExit(f"unknown git ref: {ref!r} (nothing to serve)")
    EPHEMERAL_PARENT.mkdir(exist_ok=True)
    path = EPHEMERAL_PARENT / ref.replace("/", "_").replace("\\", "_")
    if path.exists():  # orphan from a prior same-ref run — replace it
        _git("worktree", "remove", "--force", str(path), check=False)
        shutil.rmtree(path, ignore_errors=True)
    # --detach: check out the COMMIT (detached HEAD), so a branch already checked
    # out elsewhere doesn't trip git's one-worktree-per-branch rule.
    _git("worktree", "add", "--detach", str(path), ref)
    _created_worktree = path
    return path / "src"


def _cleanup():
    global _created_worktree
    if _created_worktree is not None:
        target, _created_worktree = _created_worktree, None
        _git("worktree", "remove", "--force", str(target), check=False)
        shutil.rmtree(target, ignore_errors=True)
        _git("worktree", "prune", check=False)


def main(argv):
    ref, port, clean = _parse_args(argv)
    if clean:
        _clean_all_ephemeral()
        print("[branch-verify] removed all ephemeral worktrees.", flush=True)
        return

    _git("worktree", "prune", check=False)  # drop admin entries for already-deleted dirs

    src = _existing_worktree_src(ref)
    reused = src is not None
    if not reused:
        src = _make_ephemeral_worktree(ref)
        atexit.register(_cleanup)
        for sig in (signal.SIGINT, getattr(signal, "SIGTERM", None), getattr(signal, "SIGBREAK", None)):
            if sig is not None:
                try:
                    signal.signal(sig, lambda *_: sys.exit(0))
                except (ValueError, OSError):
                    pass

    src = str(src)
    db = os.environ.get("CONTENT_HOARDER_DB") or str(MAIN_REPO / "data" / "app.db")
    sys.path.insert(0, src)
    os.environ["CONTENT_HOARDER_DB"] = db

    import content_hoarder
    loaded = content_hoarder.__file__
    if not loaded.lower().startswith(src.lower()):
        raise SystemExit(
            f"sys.path override failed: content_hoarder loaded from {loaded}, expected under {src}. "
            "(The editable install may use an import hook rather than a plain .pth.)")

    print(f"[branch-verify] ref:   {ref} ({'reused' if reused else 'ephemeral'} worktree)", flush=True)
    print(f"[branch-verify] code:  {loaded}", flush=True)
    print(f"[branch-verify] DB:    {db}", flush=True)
    print(f"[branch-verify] serve: http://localhost:{port}", flush=True)

    sys.argv = ["content_hoarder", "serve", "--port", port]
    runpy.run_module("content_hoarder", run_name="__main__", alter_sys=True)


if __name__ == "__main__":
    main(sys.argv[1:])
