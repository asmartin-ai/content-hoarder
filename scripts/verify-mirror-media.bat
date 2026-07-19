@echo off
REM ============================================================
REM  scripts/verify-mirror-media.bat
REM
REM  Re-hash every blob under K:\MediaMirror\content-hoarder\media\
REM  and compare each file's sha256 to its filename (the
REM  source is content-addressed, so the filename IS the hash).
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

set "DEST=K:\MediaMirror\content-hoarder\media"

if not exist "%DEST%" (
    echo ERROR: dest does not exist: %DEST%
    echo Run scripts\mirror-media.bat first.
    exit /b 1
)

echo.
echo === Verifying sha256 of every blob under %DEST% ===
echo.

set MISMATCH=0
set COUNT=0

REM Iterate every file. We use a `for /R` + PowerShell Get-FileHash
REM (PowerShell is on every Windows install since Win7; Get-FileHash
REM is the right tool here).
for /R "%DEST%" %%f in (*) do (
    set /a COUNT+=1
    REM Strip the .ext: filename is "<sha256>.<ext>" → expect sha256 of
    REM file contents to equal the part before the first dot.
    for /f "delims=" %%n in ("%%~nf") do (
        for /f "usebackq" %%h in (`powershell -NoProfile -Command "(Get-FileHash -Algorithm SHA256 '%%f').Hash.ToLower()"`) do (
            if /i not "%%h"=="%%n" (
                echo MISMATCH %%f  expected=%%n  got=%%h
                set /a MISMATCH+=1
            )
        )
    )
)

echo.
echo === Result ===
echo   files checked: %COUNT%
echo   mismatches:    %MISMATCH%

if %MISMATCH% gtr 0 (
    echo.
    echo FAILED: %MISMATCH% blob^(s^) failed integrity check.
    exit /b 1
)

echo OK: all blobs verified.
endlocal
