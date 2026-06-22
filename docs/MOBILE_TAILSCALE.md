# Triaging on your phone (Tailscale)

Goal: open content-hoarder on your Pixel 6 (Chrome) over a **private** connection and install it
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
This works for browsing/triage, but **Chrome won't let you _install_ the PWA over plain HTTP.**

> **Why plain HTTP only gives you a bookmark shortcut, never a real install.**
> Installing a PWA requires a registered **service worker**, and service workers
> only run in a **secure context**: HTTPS, or the loopback names `localhost` /
> `127.0.0.1` / `::1`. A Tailscale `100.x.y.z` address is *not* loopback, so over
> plain `http://` the browser refuses to register the worker. With no service
> worker there's no installability — what Chrome offers over HTTP is a plain **"Add to
> Home screen"** shortcut that opens in a browser tab, not a real standalone **WebAPK**.
> The registration failure is logged to the browser console as *"Service worker
> registration failed (needs HTTPS or localhost)"*. The fix is to serve over HTTPS — see 2b.

## 2b. Recommended — HTTPS via `tailscale serve` (enables install + offline)
Tailscale can put a real TLS cert in front of your local app:
```bash
# Terminal 1 — run the app on localhost (default):
python -m content_hoarder serve

# Terminal 2 — expose it over HTTPS on your tailnet (persists across reboots):
tailscale serve --bg 8788
tailscale serve status        # shows the https://<pc>.<tailnet>.ts.net URL
```
On the phone, open **`https://<pc>.<tailnet>.ts.net`** → **Chrome menu (⋮) → Install app** to add it to
your home screen as a standalone, offline-capable **WebAPK**. (Chrome may also pop its own install
prompt automatically via `beforeinstallprompt` once the secure-context + manifest checks pass.)

To stop sharing later: `tailscale serve --https=443 off`.

## Security notes
- **Do NOT use `tailscale funnel`** — that publishes to the *public* internet. `tailscale serve`
  keeps it private to your devices. Never port-forward this app on your router.
- The app holds years of personal content; keep it tailnet-only (or trusted LAN) always.

## Troubleshooting install on Chrome for Android
- **Chrome only offers "Add to Home screen" (a tab shortcut), not "Install app".** You're on plain
  HTTP (2a). Switch to the HTTPS `*.ts.net` URL from `tailscale serve` (2b). See the secure-context
  note above.
- **Confirm you're actually on HTTPS.** The address bar must show `https://<pc>.<tailnet>.ts.net`
  with a padlock — *not* `http://100.x.y.z:8788`. Opening the Tailscale IP URL will never be
  installable, even while `tailscale serve` is running.
- **First run needs an HTTPS cert.** Enable **HTTPS Certificates** for your tailnet in the
  Tailscale admin console (DNS section) and keep **MagicDNS** on, or `tailscale serve` can't
  provision a cert.
- **No automatic install prompt.** Chrome fires `beforeinstallprompt` once the manifest + service
  worker + secure-context checks pass; if it never fires, one of those is failing (most often the
  secure context — see above). You can always install manually via **⋮ menu → Install app**.
- **Check the console for the cause.** If install is missing, connect the phone to desktop Chrome via
  `chrome://inspect` and look for *"Service worker registration failed (needs HTTPS or localhost)"* —
  that confirms a secure-context problem.

Sources: [Tailscale serve docs](https://tailscale.com/kb/1242/tailscale-serve) ·
[Serve examples](https://tailscale.com/kb/1313/serve-examples)
