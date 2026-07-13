@echo off
REM Mirror content-hoarder data/media/ to F:\Backups (Spec 10).
REM Append-only source; /MIR keeps dest in sync. Safe to re-run.
REM
REM Usage (from anywhere):
REM   scripts\mirror-media.bat
REM   scripts\mirror-media.bat /L     (list-only dry run)
setlocal
set "SRC=K:\Projects\content-hoarder\data\media"
set "DEST=F:\Backups\content-hoarder\media"
set "LOGDIR=F:\Backups\content-hoarder"
set "LOG=%LOGDIR%\media-mirror.log"

if not exist "%SRC%\" (
  echo error: source missing: %SRC%
  exit /b 1
)
if not exist "%LOGDIR%\" mkdir "%LOGDIR%"
if not exist "%DEST%\" mkdir "%DEST%"

echo === media mirror ===
echo src:  %SRC%
echo dest: %DEST%
echo log:  %LOG%
echo.

REM /MIR mirror  /R:2 retries  /W:5 wait  /MT:16 threads
REM /NP no progress  /NDL /NFL quieter  /TEE also print to console
REM Extra args (e.g. /L) pass through for dry-run.
robocopy "%SRC%" "%DEST%" /MIR /R:2 /W:5 /MT:16 /NP /NDL /NFL /TEE /LOG+:"%LOG%" %*

REM robocopy exit codes 0-7 are success-ish; >=8 is failure
set "RC=%ERRORLEVEL%"
if %RC% GEQ 8 (
  echo FAILED robocopy exit %RC%
  exit /b %RC%
)
echo OK robocopy exit %RC% ^(0-7 = success^)
exit /b 0
