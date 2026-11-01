# Demo: bring in → understand → decide → undo → find it later

A recorded or supervised local demo of the core loop. YC says a local demo is fine: "We don't
care if you're still running it locally" ([YC library, "Include a demo"](https://www.ycombinator.com/library/J8-yc-application-tips-include-a-demo), checked 2026-11-01).

Status key: **✅ verified** = run on 2026-11-01 against the synthetic demo library (`scripts/demo.sh`,
headless Chromium at 412×915). **⚠ unverified** = not exercised. **✋ manual** = the founder does it by hand.

## Start

```bash
./scripts/demo.sh            # fresh temp library, 24 synthetic saves, http://127.0.0.1:8791/
```

It creates a new temp folder, runs from it (so no `.env` and no credentials load), and never
opens `data/app.db`. The data is `docs/demo/demo-saves.json`: invented posts in a Reddit
listing format, with links to `example.com` and no images.

## Walkthrough

| # | Step | What the viewer sees | Status |
|---|---|---|---|
| 1 | Run `./scripts/demo.sh` in a terminal | `imported=24 skipped=0 errors=0` | ✅ |
| 2 | Open Today (`/`) | A day title, five cards fanned under **Clear 10 · about 2 minutes**, 5/10/25 sizes, "0 cleared today" | ✅ |
| 3 | Pick **5**, tap **Clear 5** | One full-size card. A dot row on top tracks the round | ✅ |
| 4 | Read the card. Don't tap ↗ during the demo (see the safety checklist) | Title, community, body text | ✅ card · ✋ the reader on demo data shows "Network error loading the thread" |
| 5 | **Done**, **Archive**, **Keep**, **Not now** (keys `D` `A` `F` `N`, or swipes) | The card flies off, the next one is already there | ✅ |
| 6 | Undo (top-right ↶ or `U`) | The last card comes back; the database reverts (checked: the snoozed item returned to the inbox) | ✅ |
| 7 | Finish the round | "Cleared" stamp, receipt tiles, count, time, a line like "2 done · 1 archived · 1 kept · 1 for later" | ✅ |
| 8 | Back to Today | "Last round 1m ago — 5 cleared", ring shows today's wins | ✅ |
| 9 | Restart the server, open Library → **Keep** | The kept item is still there after the restart | ✅ |
| 10 | `bun run src/cli.ts export-obsidian --vault <dir> --status keep` (with `CONTENT_HOARDER_DB` set to the demo DB) | One Markdown note with title, URL, date and tag | ✅ ✋ (CLI) |
| 11 | Today → **Let a pile go** → undo from the toast | A whole community is archived, then restored | ⚠ not on demo data: no pile is offered for 24 mixed saves (checked: `#piles` hidden) |

## Say it plainly in the recording

- Import runs from the command line. There's no in-app import button yet. The server has
  `/import/prepare` and `/import/commit` endpoints, but no screen uses them.
- The demo data is synthetic. Real Reddit data exports contain only links, so real cards are thinner
  until a thread is fetched (a network step, which needs separate opt-in).
- It runs on the founder's machine. There is no hosted version and no account system.
- Not shown, because it's not built: AI suggestions in the round, one-next-action, multi-user.

## States checked

| State | Behaviour on 2026-11-01 | Status |
|---|---|---|
| Empty library: Today | "Nothing waiting here. That's a clear deck." The **Clear 10** button still shows | ✅ (after the fix below) |
| Empty library: Clear | Same message plus "Back to Today" | ✅ (after the fix below) |
| Every item decided or snoozed | Same path as the empty library: the deal returns no items | ✅ by regression test |
| Missing import file | `error: Nothing found at "<path>"`, exit 2 | ✅ |
| Unrecognised import file | `No connector recognizes "<file>"; pass --source explicitly`, exit 2 | ✅ |
| A decision's request fails | The card comes back with "That didn't stick — the card is back." | ⚠ code path read, not forced |
| Offline phone (PWA over Tailscale) | Shell is cached. Decisions need the server; failed ones come back as above | ⚠ not run |

Fixed during this pass: an empty inbox made the deal SQL invalid (`... AND ORDER BY`), so Today
showed a blank card and Clear said "Couldn't reach the server — is it running?" while the
server was running. Regression test: `tests/rooms.test.ts` "an empty inbox deals nothing
instead of failing".

## Safety checklist (before recording or sharing)

- [ ] Started with `scripts/demo.sh`. Never `bun run start` in the repo folder (that opens `data/app.db`).
- [ ] The terminal shows the temp folder path, not `data/`.
- [ ] The browser profile is clean: no personal tabs, bookmarks bar, notifications or autofill in frame.
- [ ] Don't press **Sync newest** in the Library, and don't open a card in the reader (↗, `Enter` or swipe up). Both make live requests: sync to Reddit, the reader to Reddit and then public archives for the thread. In the 2026-11-01 check the reader was opened once on an invented post and showed "Network error loading the thread". Sync was not tested.
- [ ] Nothing is hosted, tunnelled or port-forwarded. The server binds to `127.0.0.1`.
- [ ] The recording says the data is synthetic and import is a CLI step.
- [ ] Afterwards, delete the temp folder the script printed.

## If a hosted demo is ever needed

Not needed for YC (see the quote above). Only build one if testers can't run it locally. It would
need a separate instance with synthetic data only, no `.env` or tokens, a reset path, resource
limits, and access control in front. A tunnel or TLS gives none of these. Real user data would
also need consent, export and deletion, backup and restore, and per-user isolation, and none of
these exist.
