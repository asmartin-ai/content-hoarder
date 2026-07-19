@echo off
REM ============================================================
REM  scripts/mirror-media.bat
REM
REM  Mirror K:\Projects\content-hoarder\data\media\ (the
REM  content-addressed blob store for rescued Reddit media) to
REM  K:\MediaMirror\.
REM
REM  Source: append-only content-addressed blobs (each filename
REM          is its sha256). Free integrity check: re-hash any
REM          dest file and compare to its filename.
REM  Target: K:\MediaMirror\content-hoarder\media\ (nested so
REM          this script can grow into a multi-project mirror
REM          host if more K: drive projects adopt the same
REM          pattern — K:\MediaMirror\<project>\<subdir>).
REM
REM  Why robocopy:
REM    * built into Windows — zero install
REM    * /MIR (mirror) on an append-only source effectively
REM      behaves as /E (add-only) — the purge clause only fires
REM      on a real source-side deletion
REM    * /MT:16 saturates SSD; SHA-stable files hash fast
REM    * append-only means a re-run is cheap (everything up to
REM      date; robocopy skips in ~1s)
REM
REM  Usage:
REM    scripts\mirror-media.bat              REM full mirror
REM    scripts\mirror-media.bat /L           REM list-only (no copy)
REM
REM  Companion: scripts\verify-mirror-media.bat re-hashes every
REM  dest file and compares to its filename. Free integrity
REM  check — run it after every mirror.
REM
REM  Spec: docs/specs/10-media-backup.md
REM ============================================================

setlocal

set "SRC=K:\Projects\content-hoarder\data\media"
set "DEST=K:\MediaMirror\content-hoarder\media"
set "LOG=K:\MediaMirror\content-hoarder\media-mirror.log"

if not exist "%SRC%" (
    echo ERROR: source does not exist: %SRC%
    echo Run "python -m content_hoarder archive-media --apply" first to seed.
    exit /b 1
)

REM Ensure dest tree exists (robocopy /MIR creates it, but only on first
REM successful file copy — explicit mkdir makes the intent visible).
if not exist "%DEST%" mkdir "%DEST%"

echo.
echo === Mirroring ===
echo   src:  %SRC%
echo   dest: %DEST%
echo   log:  %LOG%
echo.

REM /MIR   mirror mode (add new, update changed, purge missing)
REM /R:2   retry twice on transient I/O errors
REM /W:5   wait 5s between retries
REM /MT:16 16 threads (SSD-bound; CPU-cheap since SHA-stable)
REM /NP    no per-file progress (cleaner log)
REM /BYTES print sizes in bytes (so the log is grep-friendly)
REM /L     list-only (no copy) — only when caller passes /L
robocopy "%SRC%" "%DEST%" /MIR /R:2 /W:5 /MT:16 /NP /BYTES /LOG+:"%LOG%" %*

REM robocopy returns non-zero codes for "files copied/skipped" outcomes —
REM the documented exit codes are 0-7 with 0 = no change, 1 = files copied
REM successfully, 2 = extras deleted, 3 = both. Anything >= 8 is a real
REM error. Surface only the real errors.
if errorlevel 8 (
    echo.
    echo ERROR: robocopy returned a real error (^>= 8). Check the log.
    exit /b 1
)

echo.
echo === Done ===
echo   See: %LOG%
endlocal
