@echo off
REM Spot-check content-addressed media mirror integrity.
REM Filename stem (before extension) must equal SHA-256 of file contents.
REM Default: sample up to 50 blobs on dest. Pass a number to change sample size.
REM
REM Usage:
REM   scripts\verify-media-mirror.bat
REM   scripts\verify-media-mirror.bat 200
setlocal EnableExtensions
set "DEST=F:\Backups\content-hoarder\media"
set "SAMPLE=%~1"
if "%SAMPLE%"=="" set "SAMPLE=50"

if not exist "%DEST%\" (
  echo error: dest missing: %DEST%
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$dest='F:\Backups\content-hoarder\media'; $n=[int]%SAMPLE%;" ^
  "$files=Get-ChildItem -LiteralPath $dest -File | Get-Random -Count ([Math]::Min($n,(Get-ChildItem -LiteralPath $dest -File | Measure-Object).Count));" ^
  "$bad=0; $ok=0; foreach($f in $files){" ^
  "  $stem=[IO.Path]::GetFileNameWithoutExtension($f.Name);" ^
  "  if($stem.Length -lt 64){ Write-Host ('SKIP odd name '+$f.Name); continue };" ^
  "  $expect=$stem.Substring(0,64).ToLower();" ^
  "  $hash=(Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLower();" ^
  "  if($hash -ne $expect){ Write-Host ('MISMATCH '+$f.Name); $bad++ } else { $ok++ }" ^
  "}; Write-Host (\"checked=$($ok+$bad) ok=$ok bad=$bad\"); if($bad -gt 0){ exit 2 } else { exit 0 }"

exit /b %ERRORLEVEL%
