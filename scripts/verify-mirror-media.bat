@echo off
REM ============================================================
REM  scripts/verify-mirror-media.bat
REM
REM  Re-hash every blob under K:\MediaMirror\content-hoarder\media\
REM  and compare each file's sha256 to its filename (the
REM  source is content-addressed, so the filename IS the hash).
REM
REM  This .bat is a thin Windows shim. The actual verification
REM  lives in scripts\verify_mirror_media.py so it can be unit
REM  tested (the .bat is too cmd-internals-heavy to test in CI).
REM
REM  Cost on an 18 GB blob store on local SSD: ~2-3 minutes.
REM  Run this after every mirror to confirm byte-perfect copy.
REM
REM  Exit codes:
REM    0  = all blobs verified
REM    1  = one or more mismatches (see "MISMATCH" lines)
REM
REM  Usage:
REM    scripts\verify-mirror-media.bat
REM
REM  Spec: docs/specs/10-media-backup.md
REM ============================================================

setlocal
set "SCRIPT_DIR=%~dp0"
set "DEST=K:\MediaMirror\content-hoarder\media"

REM Allow DEST override via env so the same script can verify a
REM staging mirror without editing the .bat.
if not "%VERIFY_MIRROR_DEST%"=="" set "DEST=%VERIFY_MIRROR_DEST%"

if not exist "%DEST%" (
    echo ERROR: dest does not exist: %DEST%
    echo Run scripts\mirror-media.bat first.
    exit /b 1
)

echo.
echo === Verifying sha256 of every blob under %DEST% ===
echo.

python -u "%SCRIPT_DIR%verify_mirror_media.py" "%DEST%"
endlocal
