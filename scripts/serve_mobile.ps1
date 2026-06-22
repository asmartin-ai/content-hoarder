# serve_mobile.ps1 — run content-hoarder on 127.0.0.1 so `tailscale serve` fronts it with
# HTTPS on the tailnet (.ts.net). This is the CORRECT path: PWA service workers need a secure
# context (HTTPS), and `tailscale serve` is already configured to proxy the .ts.net URL to
# 127.0.0.1:8788. Do NOT bind the raw tailnet IP — that's plain http + bypasses the proxy.
$repo = Split-Path -Parent $PSScriptRoot   # scripts\ -> repo root
Set-Location $repo
$port = 8788

# the HTTPS URL `tailscale serve` exposes (so we can print it for the phone)
$url = $null
try { $url = (& tailscale serve status 2>$null | Select-String 'https://\S+').Matches.Value | Select-Object -First 1 } catch {}
if (-not $url) { $url = "https://<your-pc>.<tailnet>.ts.net  (run: tailscale serve --bg $port)" }

Write-Host ""
Write-Host "  content-hoarder serving on 127.0.0.1:$port  (tailscale serve fronts it with HTTPS)" -ForegroundColor Cyan
Write-Host "  On your phone, open:" -ForegroundColor Cyan
Write-Host "    $url" -ForegroundColor Green
Write-Host "  Ctrl+C here to stop." -ForegroundColor DarkGray
Write-Host ""

& "$repo\.venv\Scripts\python.exe" -u -m content_hoarder.cli serve --host 127.0.0.1 --port $port
