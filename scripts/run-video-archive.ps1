# scripts/run-video-archive.ps1
#
# Spec 11 full video-archive pass: launches the unbounded
# `archive-media --videos --throttle 2.0 --apply` as a background process
# with:
#   - Unbuffered Python (`python -u`, PYTHONUNBUFFERED=1)
#   - stdout + stderr redirected to timestamped log files under logs/
#   - A 30s heartbeat line appended to a .heartbeat file (CPU + mem of the
#     python process) so liveness is visible from a tail/diff
#   - An ntfy ping every 5 minutes to kenja-bench-r7k2q9 (UTF-8 explicit)
#     so a remote watcher sees liveness without flooding
#   - A DONE ntfy ping on completion (success OR failure) with the exit
#     code + log paths
#
# Usage (from the repo root):
#   powershell -ExecutionPolicy Bypass -File scripts\run-video-archive.ps1
#
# Resumable: the underlying archive-media command skips items already in
# `metadata.archived_media`, so killing and re-running picks up where it
# left off. Per-item commit makes any crash safe.

$ErrorActionPreference = 'Stop'

$RepoRoot  = 'K:\Projects\content-hoarder'
$LogDir    = Join-Path $RepoRoot 'logs'
$Topic     = 'kenja-bench-r7k2q9'

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

$Stamp            = Get-Date -Format 'yyyyMMdd-HHmmss'
$StdoutLog        = Join-Path $LogDir "video-archive-$Stamp.log.stdout"
$StderrLog        = Join-Path $LogDir "video-archive-$Stamp.log.stderr"
$Heartbeat        = Join-Path $LogDir "video-archive-$Stamp.heartbeat"
$PidFile          = Join-Path $LogDir "video-archive-$Stamp.pid"

function Send-Ntfy {
    param([string]$Message)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Message)
    try {
        Invoke-RestMethod -Uri "https://ntfy.sh/$Topic" -Method Post -Body $bytes -ContentType 'text/plain; charset=utf-8' | Out-Null
    } catch {
        # Never let a notify failure break the run.
        Add-Content -LiteralPath $StderrLog -Value "[$(Get-Date -Format o)] ntfy send failed: $_" -Encoding utf8
    }
}

$startBody = "[video-archive] START at $(Get-Date -Format o); stdout=$StdoutLog stderr=$StderrLog heartbeat=$Heartbeat"
Send-Ntfy $startBody

# Launch python detached. -WindowStyle Hidden so no console pops up. The
# actual work continues in the background and writes to the log files.
$proc = Start-Process -FilePath 'python' `
    -ArgumentList @('-u', '-m', 'content_hoarder', 'archive-media',
                    '--videos', '--throttle', '2.0', '--apply') `
    -WorkingDirectory $RepoRoot `
    -RedirectStandardOutput $StdoutLog `
    -RedirectStandardError  $StderrLog `
    -WindowStyle Hidden -PassThru

Set-Content -LiteralPath $PidFile -Value $proc.Id -Encoding utf8

Add-Content -LiteralPath $Heartbeat -Value "$(Get-Date -Format o)  launched pid=$($proc.Id)" -Encoding utf8

Write-Host "Launched python archive-media in the background."
Write-Host "  PID:        $($proc.Id)"
Write-Host "  stdout:     $StdoutLog"
Write-Host "  stderr:     $StderrLog"
Write-Host "  heartbeat:  $Heartbeat"
Write-Host "  pid file:   $PidFile"
Write-Host ""
Write-Host "Monitor with:"
Write-Host "  Get-Content '$Heartbeat' -Wait"
Write-Host "  Get-Content '$StdoutLog' -Wait"
Write-Host ""
Write-Host "Or subscribe to ntfy topic '$Topic' for heartbeats + completion pings."

# Heartbeat loop. Polls the python process every 30s. Stops when it exits.
# Pings ntfy every 5 minutes (10 ticks) so a remote watcher can confirm
# liveness without flooding the topic.
$lastNtfy = Get-Date
while (-not $proc.HasExited) {
    Start-Sleep -Seconds 30
    if ($proc.HasExited) { break }
    try {
        $proc.Refresh()
        $cpu = [math]::Round($proc.CPU, 1)
        $mem = [math]::Round($proc.WorkingSet64 / 1MB, 0)
    } catch {
        $cpu = '?'; $mem = '?'
    }
    Add-Content -LiteralPath $Heartbeat `
        -Value "$(Get-Date -Format o)  pid=$($proc.Id)  cpu=${cpu}s  mem=${mem}MB  running" `
        -Encoding utf8
    if (((Get-Date) - $lastNtfy).TotalMinutes -ge 5) {
        Send-Ntfy "[video-archive] heartbeat at $(Get-Date -Format o): pid=$($proc.Id) cpu=${cpu}s mem=${mem}MB still running"
        $lastNtfy = Get-Date
    }
}

$proc.WaitForExit()
# PowerShell returns `$null` from ExitCode when the process was started
# without -Wait; coerce so ntfy shows a real number.
$rc = if ($null -ne $proc.ExitCode) { [int]$proc.ExitCode } else { -1 }

Add-Content -LiteralPath $Heartbeat -Value "$(Get-Date -Format o)  pid=$($proc.Id)  exit=$rc" -Encoding utf8

$doneBody = "[video-archive] DONE at $(Get-Date -Format o) exit=$rc stdout=$StdoutLog stderr=$StderrLog"
Send-Ntfy $doneBody

if ($rc -eq 0) {
    Write-Host "DONE exit=$rc" -ForegroundColor Green
} else {
    Write-Host "DONE exit=$rc (FAILED)" -ForegroundColor Red
}
Write-Host "Last 20 lines of stdout:"
Get-Content $StdoutLog -Tail 20
