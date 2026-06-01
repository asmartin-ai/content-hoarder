# Triaging on your phone (Tailscale)

Goal: open content-hoarder on your Pixel 6 (Firefox) over a **private** connection and install it
as a PWA. We use Tailscale (a zero-config WireGuard mesh VPN) so the app is reachable **only by your
own devices** — never the public internet.

## 1. Install Tailscale on both devices (same account)
- **Windows PC:** download from <https://tailscale.com/download/windows>, install, sign in.
- **Pixel 6:** install **Tailscale** from the Play Store, sign in with the **same** account.

Both devices are now on your private "tailnet". Find your PC's name/IP:
```bash
tailscale status        # shows your PC as e.g. 100.x.y.z  my-pc.tailXXXX.ts.net
```

## 2a. Quick way — plain HTTP (browse only, no install)
Bind the app to all interfaces and open it by Tailscale IP from the phone:
```bash
python -m content_hoarder serve --host 0.0.0.0
```
On the phone (Tailscale toggled on): browse to `http://<PC-tailscale-ip>:8788`.
This works for browsing/triage, but **Firefox won't let you _install_ the PWA over plain HTTP.**

## 2b. Recommended — HTTPS via `tailscale serve` (enables install + offline)
Tailscale can put a real TLS cert in front of your local app:
```bash
# Terminal 1 — run the app on localhost (default):
python -m content_hoarder serve

# Terminal 2 — expose it over HTTPS on your tailnet (persists across reboots):
tailscale serve --bg 8788
tailscale serve status        # shows the https://<pc>.<tailnet>.ts.net URL
```
On the phone, open **`https://<pc>.<tailnet>.ts.net`** → **Firefox menu → Install** to add it to your
home screen (standalone, offline-capable).

To stop sharing later: `tailscale serve --https=443 off`.

## Security notes
- **Do NOT use `tailscale funnel`** — that publishes to the *public* internet. `tailscale serve`
  keeps it private to your devices. Never port-forward this app on your router.
- The app holds years of personal content; keep it tailnet-only (or trusted LAN) always.

Sources: [Tailscale serve docs](https://tailscale.com/kb/1242/tailscale-serve) ·
[Serve examples](https://tailscale.com/kb/1313/serve-examples)
