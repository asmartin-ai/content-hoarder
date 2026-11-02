# Demo: bring in → understand → decide → undo → find it later

A recorded or supervised local demo of the core loop. YC says a local demo is fine: "We don't
care if you're still running it locally" ([YC library, "Include a demo"](https://www.ycombinator.com/library/J8-yc-application-tips-include-a-demo), checked 2026-11-01).

Status key: **✅ verified** = run on 2026-11-01 against the synthetic demo library (`scripts/demo.sh`,
headless Chromium at 412×915). **⚠ unverified** = not exercised. **✋ manual** = the founder does it by hand.

## Start

```bash
./scripts/demo.sh                      # fresh temp library, 24 synthetic saves, http://127.0.0.1:8791/
./scripts/demo.sh ~/tester-links.txt   # same, but imports a tester's own file instead
```

It creates a new temp folder, runs from it (so no `.env` and no credentials load), sets
`CONTENT_HOARDER_OFFLINE=1` (the server makes no request to anything but itself), and never
opens `data/app.db`. The data is `docs/demo/demo-saves.json`: invented posts in a Reddit
listing format, with links to `example.com` and no images.

**A tester's own links.** Any file the importers accept works. The quickest is a `.txt` file. The
first line is `Export Tabs URLs`, then one entry per paragraph: a title line and a URL line, or
just the URL. Put a blank line between entries; without it, two URLs read as a title and a URL.
Checked 2026-11-01: a three-entry file imported as `imported=3 skipped=0 errors=0`. Offline mode
still applies, so cards show the title and link, not a fetched preview.

The offline demo has no AI suggestions. To show an AI hint, use the hosted demo or a non-offline
local run with the `LLM_*` settings in [`src/config.ts`](../src/config.ts), and enable AI for that
library. See [AI suggestions](ai-suggestions.md). Never use the real library for a demo.

## Walkthrough

| # | Step | What the viewer sees | Status |
|---|---|---|---|
| 1 | Run `./scripts/demo.sh` in a terminal | `imported=24 skipped=0 errors=0` | ✅ |
| 2 | Open Today (`/`) | A day title, five cards fanned under **Clear 10 · about 2 minutes**, 5/10/25 sizes, "0 cleared today" | ✅ |
| 3 | Pick **5**, tap **Clear 5** | One full-size card. A dot row on top tracks the round | ✅ |
| 3a | With AI enabled, read a suggested action on a Clear card and tap it | A quiet **Suggest: Keep** or **Suggest: Archive** line, a reason and an **AI** tag; history hints say **From your history** | ⚠ not exercised in the offline demo |
| 4 | Read the card; tap ↗ to open it in the reader | Title, community, body text. The reader says "Offline mode: this thread wasn't fetched." | ✅ |
| 5 | **Done**, **Archive**, **Keep**, **Not now** (keys `D` `A` `F` `N`, or swipes) | The card flies off, the next one is already there | ✅ |
| 6 | Undo (top-right ↶ or `U`) | The last card comes back; the database reverts (checked: the snoozed item returned to the inbox) | ✅ |
| 7 | Finish the round | "Cleared" stamp, receipt tiles, count, time, a line like "2 done · 1 archived · 1 kept · 1 for later" | ✅ |
| 8 | Back to Today | "Last round 1m ago — N cleared" (Not now isn't counted), ring shows today's wins | ✅ |
| 9 | Restart the server, open Library → **Keep** | The kept item is still there after the restart | ✅ |
| 10 | `bun run src/cli.ts export-obsidian --vault <dir> --status keep` (with `CONTENT_HOARDER_DB` set to the demo DB) | One Markdown note with title, URL, date and tag | ✅ ✋ (CLI) |
| 11 | Today → **Let a pile go** → undo from the toast | A whole community is archived, then restored | ⚠ not on demo data: no pile is offered for 24 mixed saves (checked: `#piles` hidden) |
| 12 | Open **Home** (`/home`) after a round | Start here; this week's flow with let go and kept from the round; a resurfaced save with a reason; sample Parked / Agent receipts / Patterns / Attention guard panels, each marked Sample; today lit in the rhythm strip | ✅ desktop 1440 and phone 412 |

## Say it plainly in the recording

- The local recording uses synthetic data and imports from the command line. Add also supports
  in-app imports.
- Real Reddit data exports contain only links, so real cards are thinner until a thread is fetched
  (a network step, which needs separate opt-in).
- The hosted friend pilot has accounts and separate libraries; see [the pilot guide](FRIEND-PILOT.md).
- One-next-action is not built. AI suggestions are not available in the offline demo.

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
- [ ] Don't press **Sync newest** in the Library. `scripts/demo.sh` sets `CONTENT_HOARDER_OFFLINE=1`, so the server refuses every non-local request (sync, reader threads, archives), but don't show a failing button. If you start the server any other way, set that variable yourself.
- [ ] Nothing is hosted, tunnelled or port-forwarded. The server binds to `127.0.0.1`.
- [ ] The recording says the data is synthetic and import is a CLI step.
- [ ] Afterwards, delete the temp folder the script printed.

## Hosted pilot

The invite-only hosted pilot is separate from this offline recording. Its access, data isolation,
consent and wipe procedure are in [the pilot guide](FRIEND-PILOT.md).
