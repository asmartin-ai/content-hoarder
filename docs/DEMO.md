# Demo: bring in → understand → decide → undo → find it later

A recorded or supervised local demo of the core loop. YC says a local demo is fine: "We don't
care if you're still running it locally" ([YC library, "Include a demo"](https://www.ycombinator.com/library/J8-yc-application-tips-include-a-demo), checked 2026-11-01).

Status key: **✅ verified** = run on 2026-11-01 against the earlier synthetic demo library
(`scripts/demo.sh`, headless Chromium at 412×915); the source counts and local media were re-checked
on 2026-11-02 against the current 77-save library. **⚠ unverified** = not exercised with the
current data or UI. **✋ manual** = the founder does it by hand.

## Start

```bash
./scripts/demo.sh                      # fresh temp library, 77 synthetic saves, http://127.0.0.1:8791/
./scripts/demo.sh ~/tester-links.txt   # same, then also imports a tester's own file
```

It creates a new temp folder, runs from it (so no `.env` and no credentials load), sets
`CONTENT_HOARDER_OFFLINE=1` (the server makes no request to anything but itself and its loopback
media server), and never opens `data/app.db`.

Five fixture inputs, one per source, all invented:

| Fixture | Source | Items | Cards |
|---|---|---|---|
| [`demo/demo-saves.json`](demo/demo-saves.json) | Reddit JSON listing | 52 (45 text, 5 image, 2 video) | 7 with local images; 2 play a 3–4 s clip |
| [`demo/youtube-watch-later.json`](demo/youtube-watch-later.json) | YouTube `yt-dlp --flat-playlist` JSON | 8 videos | local thumbnails, duration and view count |
| [`demo/hackernews-favorites.html`](demo/hackernews-favorites.html) | Hacker News favorites HTML | 6 stories | text cards (no preview fetch offline) |
| [`demo/bookmarks.html`](demo/bookmarks.html) | Browser bookmarks (Netscape HTML) | 6 links | text cards |
| [`demo/keep/`](demo/keep/) | Google Keep Takeout JSON | 5 notes and checklists | text cards |

The Reddit fixture keeps the original 45 saves, including clusters in r/memes and r/buildapc that
can produce learned piles.

**Media.** `scripts/demo.sh` also starts a loopback server on `http://127.0.0.1:8790/` for
`docs/demo/media`. The fixtures point their thumbnails and clips there, so nothing is fetched from
the internet in offline mode. The files are generated abstract art: seeded colour gradients and
shapes, plus two short ffmpeg clips and their posters. They are committed, so the demo runs without
regenerating. `bun run scripts/demo-media.ts` rebuilds them (same seeds; the stills are byte-stable
and the clips are stable for a given ffmpeg build). Total media is about 100 KiB.

**A tester's own links.** Any file the importers accept works. The demo fixtures always load; the
path you pass is imported on top of them. The quickest tester file is a `.txt`: the first line is
`Export Tabs URLs`, then one entry per paragraph — a title line and a URL line, or just the URL.
Put a blank line between entries; without it, two URLs read as a title and a URL. Offline mode
still applies, so cards show the title and link, not a fetched preview.

The offline demo has no AI suggestions. To show an AI hint, use the hosted demo or a non-offline
local run with the `LLM_*` settings in [`src/config.ts`](../src/config.ts), and enable AI for that
library. See [AI suggestions](ai-suggestions.md). Never use the real library for a demo.

## Walkthrough

| # | Step | What the viewer sees | Status |
|---|---|---|---|
| 1 | Run `./scripts/demo.sh` in a terminal | Imports 77 fictional saves from five sources and starts the loopback media server | ✅ counts checked 2026-11-02 |
| 2 | Open Today (`/`) | A day title, five cards fanned under **Clear 10 · about 2 minutes**, 5/10/25 sizes, "0 cleared today" | ✅ |
| 3 | Pick **5**, tap **Clear 5** | One full-size card, a dot row and a first-visit **? What the buttons mean** link | ⚠ guide change not exercised in the earlier run |
| 3a | With AI enabled, notice the suggested action and choose a decision | A gentle highlight marks the Keep or Archive button that AI would pick; history suggestions use the same highlight. No reason text appears on the card | ⚠ not exercised in the offline demo |
| 3b | Deal until a card with a picture appears (Reddit image or YouTube); tap a video card's play control | The image and poster load from `127.0.0.1:8790`; the video card plays a 3–4 s generated clip in place | ✅ requests served 2026-11-02; playback not eyeballed in Chromium this pass |
| 4 | Read the card; tap ↗ to open it in the reader | Title, community, body text. The reader says "Offline mode: this thread wasn't fetched." | ✅ |
| 5 | **Done**, **Archive**, **Keep**, **Not now** (keys `D` `A` `F` `N`, or swipes) | The card flies off, the next one is already there | ✅ |
| 6 | Undo (top-right ↶ or `U`) | The last card comes back; the database reverts (checked: the snoozed item returned to the inbox) | ✅ |
| 7 | Finish the round | "Cleared" stamp, receipt tiles, count, time, a line like "2 done · 1 archived · 1 kept · 1 for later" | ✅ |
| 8 | Back to Today | "Last round 1m ago — N cleared" (Not now isn't counted), ring shows today's wins | ✅ |
| 9 | Restart the server, open Library → **Keep** | The kept item is still there after the restart | ✅ |
| 10 | `bun run src/cli.ts export-obsidian --vault <dir> --status keep` (with `CONTENT_HOARDER_DB` set to the demo DB) | One Markdown note with title, URL, date and tag | ✅ ✋ (CLI) |
| 11 | Today → **Let a pile go** → undo from the toast | A suggested community pile is archived, then restored | ⚠ learned piles may appear after decisions; current dataset not exercised in the earlier run |
| 12 | Open **Home** (`/home`) after a round | Start here; this week's flow with let go and kept from the round; a resurfaced save with a reason; sample Parked / Agent receipts / Patterns / Attention guard panels, each marked Sample; today lit in the rhythm strip | ✅ desktop 1440 and phone 412 |

## Say it plainly in the recording

- The local recording uses synthetic data and imports from the command line. Add also supports
  in-app imports.
- Every picture and clip in the demo is generated abstract art served from `127.0.0.1:8790`, not a
  real post. Reddit image/video posts and YouTube videos show those local images; Hacker News,
  bookmarks and Keep cards are text-only, because their real exports carry no preview image and the
  preview fetch needs the network.
- Real Reddit data exports contain only links, so real cards are thinner until a thread is fetched
  (a network step, which needs separate opt-in).
- The hosted pilot gives each friend an account and a separate library; its operations guide is
  private and not part of the public mirror.
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
- [ ] Nothing is hosted, tunnelled or port-forwarded. The app binds to `127.0.0.1:8791` and the
      media server to `127.0.0.1:8790`; both die when the script exits.
- [ ] The recording says the data is synthetic and the pictures are generated.
- [ ] Afterwards, delete the temp folder the script printed.

## Hosted pilot

The invite-only hosted pilot is separate from this offline recording. Its access, data isolation,
consent and wipe procedure are in the private pilot guide.
