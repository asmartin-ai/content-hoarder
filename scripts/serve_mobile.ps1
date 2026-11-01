$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$port = 8788

$url = $null
try { $url = (& tailscale serve status 2>$null | Select-String 'https://\S+').Matches.Value | Select-Object -First 1 } catch {}
if (-not $url) { $url = "https://<your-pc>.<tailnet>.ts.net  (run: tailscale serve --bg $port)" }

Write-Host ""
Write-Host "  content-hoarder serving on 127.0.0.1:$port  (tailscale serve fronts it with HTTPS)" -ForegroundColor Cyan
Write-Host "  On your phone, open:" -ForegroundColor Cyan
Write-Host "    $url" -ForegroundColor Green
Write-Host "  Ctrl+C here to stop." -ForegroundColor DarkGray
Write-Host ""

& bun run src/cli.ts serve --host 127.0.0.1 --port $port
