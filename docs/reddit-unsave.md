# Reddit unsave-on-Done

Marking a Reddit item **Done** in content-hoarder can also **unsave it from your Reddit *Saved* list**,
so processing the inbox here shrinks your real Reddit backlog. No OAuth app is needed — it uses the same
web endpoint your browser uses (`POST /api/unsave`), authenticated by your `reddit_session` cookie + a
modhash CSRF token read from `/api/me.json`.

## How it works

1. **Done enqueues, locally and instantly.** When `reddit_unsave_on_done` is enabled, marking a reddit
   post/comment Done inserts a row into the `reddit_unsave` queue table (in the same commit as the status
   change). Triage never waits on the network and never fails because Reddit is unreachable.
2. **A drain does the throttled network work**, on demand: a scheduled job (`reddit-unsave --drain`), the
   "Reddit sync" button on the Browse page, or "Sync now" in the triage menu. The drain refreshes the
   modhash once, then POSTs `/api/unsave` ~1/sec with 429 backoff. On success it marks the row `done` and
   sets `items.is_saved = 0`.
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
   ```
   python -m content_hoarder reddit-unsave --login --cookie "<reddit_session value>"
   ```
   …or paste it into the **Reddit sync** panel on the Browse page (sidebar → "Reddit sync").
3. **Enable** the behavior:
   ```
   python -m content_hoarder reddit-unsave --enable
   ```
4. *(Optional)* **Backfill** items you've already marked Done:
   ```
   python -m content_hoarder reddit-unsave --enqueue-existing
   ```

The cookie expires every few days–weeks. When a drain reports `auth_error` (CLI exits non-zero; the UI
shows a "session expired" banner), re-run `--login` / re-paste the cookie.

## Draining on a schedule (recommended)

Triage on your phone enqueues; let your PC drain when it's on. Windows Task Scheduler example (every 30 min):

```
schtasks /Create /TN "content-hoarder reddit unsave" /SC MINUTE /MO 30 /TR ^
  "K:\Projects\content-hoarder\.venv\Scripts\python.exe -m content_hoarder reddit-unsave --drain --limit 200"
```

`--drain` prints a JSON summary (`{selected, unsaved, failed, auth_error, remaining}`) and exits non-zero
on `auth_error` so a scheduled run can alert you.

## End-to-end verification (do this on a COPY of the DB first)

`--drain` mutates real Reddit state, so verify against a copy:

```
copy data\app.db data\app.test.db
set CONTENT_HOARDER_DB=data\app.test.db
python -m content_hoarder reddit-unsave --login --cookie "<value>"     # prints "Signed in as u/<you>"
python -m content_hoarder reddit-unsave --enable
# in the app, mark one known-saved reddit item Done, then:
python -m content_hoarder reddit-unsave --status                       # pending: 1
python -m content_hoarder reddit-unsave --drain --limit 1              # unsaved: 1
#   -> confirm it's gone from reddit.com/user/me/saved
python -m content_hoarder reddit-unsave --drain --limit 1              # no-op, pending: 0 (idempotent)
# undo that item in the app -> it reappears in Reddit Saved (best-effort resave)
```

A garbage/expired cookie should make `--drain` return `auth_error: true` and exit non-zero, while the local
Done/undo still work.

## Risks / notes

- **Cookie auth is undocumented and fragile** (expiry, Cloudflare/bot challenges, login redirects). Failures
  surface loudly; the queue persists so nothing is lost. `reddit_unsave._post_unsave` is the single network
  seam — swapping to an OAuth "script" app transport later is localized.
- Reddit's unofficial rate limit is unknown; `--limit`/`--throttle` + a resumable queue keep drains polite.
- All of `reddit_unsave.py` is offline-tested with injected `post`/`getf`/`sleep`
  (`tests/test_reddit_unsave.py`).
