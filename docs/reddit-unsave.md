# Reddit unsave-on-Done

Marking a Reddit item **Done** in content-hoarder can also **unsave it from your Reddit *Saved* list**,
so processing the inbox here shrinks your real Reddit backlog. It runs over the sanctioned OAuth `save`
scope when configured (installed-app id, no client secret); otherwise it falls back to the same web
endpoint your browser uses (`POST /api/unsave`), authenticated by your `reddit_session` cookie + a
modhash CSRF token read from `/api/me.json`.

## How it works

1. **Done enqueues, locally and instantly.** When `reddit_unsave_on_done` is enabled, marking a reddit
   post/comment Done inserts a row into the `reddit_unsave` queue table (in the same commit as the status
   change). Triage never waits on the network and never fails because Reddit is unreachable.
2. **A drain does the throttled network work.** Three ways it runs:
   - **Async trickle (automatic).** While the app is running, a background drainer flushes a small
     capped batch (~25) shortly after triage activity *settles* (a ~30s idle debounce), so processing
     the inbox quietly shrinks your real Saved list. Opt-in via the enable toggle; bounded by the cap +
     jitter + the audit log — that's the consent, not a per-item prompt.
   - **Scheduled job (`reddit-unsave --trickle`).** The same bounded, non-interactive drain for an OS
     scheduler (phone-triage → PC-drain). Skips itself unless unsave-on-done is enabled.
   - **Bulk manual (`reddit-unsave --drain --live --yes`).** The big-blast "flush everything" path —
     **dry-run by default**, executes only with both flags (money-action gate). Plus the "Reddit sync"
     button / "Sync now" in the triage menu.

   All paths refresh the modhash once (or use the OAuth `save` scope when configured), then POST
   `/api/unsave` with jittered throttle + 429 backoff; on success they mark the row `done`, set
   `items.is_saved = 0`, and append to `data/unsave-audit.jsonl`.
3. **Idempotent.** Unsaving an item that isn't actually saved is a harmless Reddit no-op, so the queue
   never trusts the local `is_saved` flag — it just attempts the unsave.
4. **Undo:** undoing a Done *before* the drain runs removes the queued row (nothing is sent). Undoing
   *after* the item was drained best-effort re-saves it (`POST /api/save`); a dead cookie never blocks the
   local undo.

`is_saved` now means **"still in your Reddit Saved list"** — flipped to 0 only after a confirmed unsave.

## Setup

1. **Get your cookie.** In a browser logged into Reddit: DevTools → Application → Cookies →
   `https://www.reddit.com` → copy the **`reddit_session`** value.
2. **Store it** (validates against `/api/me.json` and captures your username):
   ```bash
   bun run src/cli.ts reddit-unsave --login --cookie "<reddit_session value>"
   ```
   …or paste it into the **Reddit sync** panel on the Browse page (sidebar → "Reddit sync").
3. **Enable** the behavior:
   ```bash
   bun run src/cli.ts reddit-unsave --enable
   ```
4. *(Optional)* **Backfill** items you've already marked Done:
   ```bash
   bun run src/cli.ts reddit-unsave --enqueue-existing
   ```

The cookie expires every few days–weeks. When a drain reports `auth_error` (CLI exits non-zero; the UI
shows a "session expired" banner), re-run `--login` / re-paste the cookie.

## Draining on a schedule (recommended)

Triage on your phone enqueues; let your PC drain when it's on. Use **`--trickle`** (the bounded,
non-interactive lane) for scheduled runs — **not** `--drain`, which is now dry-run unless you pass
`--live --yes` (the bulk money-action gate, wrong for an unattended job). Windows Task Scheduler
example (every 30 min):

```powershell
schtasks /Create /TN "content-hoarder reddit unsave" /SC MINUTE /MO 30 /TR "bun.exe run C:\path\to\content-hoarder\src\cli.ts reddit-unsave --trickle --limit 200" /F
```

`--trickle` prints a JSON summary (`{selected, unsaved, failed, auth_error, remaining, transport,
audit_log}`), skips itself (exit 0) when unsave-on-done is disabled, and exits non-zero on `auth_error`
so a scheduled run can alert you.

## End-to-end verification (do this on a COPY of the DB first)

`--drain` mutates real Reddit state, so verify against a copy:

```bash
cp data/app.db data/app.test.db
CONTENT_HOARDER_DB=data/app.test.db bun run src/cli.ts reddit-unsave --login --cookie "<value>"
CONTENT_HOARDER_DB=data/app.test.db bun run src/cli.ts reddit-unsave --enable
# In the app, mark one known-saved Reddit item Done, then inspect the queue:
CONTENT_HOARDER_DB=data/app.test.db bun run src/cli.ts reddit-unsave --status
CONTENT_HOARDER_DB=data/app.test.db bun run src/cli.ts reddit-unsave --drain --limit 1
# After explicitly confirming the account-side result, a second drain is idempotent:
CONTENT_HOARDER_DB=data/app.test.db bun run src/cli.ts reddit-unsave --drain --limit 1
```

A garbage/expired cookie should make `--drain` return `auth_error: true` and exit non-zero, while the local
Done/undo still work.

## Risks / notes

- **Cookie auth is undocumented and fragile** (expiry, Cloudflare/bot challenges, login redirects). Failures
  surface loudly; the queue persists so nothing is lost. `reddit_unsave._http_post` (the default for the
  injectable `post=` param) is the single network seam — swapping to an OAuth "script" app transport later is localized.
- Reddit's unofficial rate limit is unknown; `--limit`/`--throttle` + a resumable queue keep drains polite.
- Offline Bun tests should exercise the queued-unsave boundaries through an injected transport; never drain a real Reddit account in CI or smoke checks.
