# Product

## Register

product

## Users

content-hoarder is for a local-first power user with an ADHD-shaped saved-content backlog: Reddit saves, YouTube videos, Hacker News stories, Firefox tabs, Obsidian/Keep notes, Twitter/X bookmarks, and recovered/archive-only media. They use it during short desktop or phone sessions to search, filter, triage, recover, read, and reduce a personal library without sending private data to a cloud service.

## Product Purpose

content-hoarder exists to process and reduce saved content, not merely aggregate it. Success means the user can quickly find a saved item, understand why it is in the backlog, decide Keep / Archive / Done / Snooze with low friction, recover enough missing context to make that decision, and leave with less cognitive debt than they arrived with. The main surfaces are media/search/results workflows, empty states that reduce guilt, and error handling that tells the user what happened without adding panic.

## Initial customer and job (hypothesis, checked 2026-11-01)

**First customer to test:** someone who saves from Reddit, YouTube, Hacker News or browser tabs most days, has hundreds or thousands of saves, and feels that pile as a debt. The trigger is opening the saved list to find or use something and hitting the wall.

**The job:** let most of it go safely, keep the few things that matter, and stop in five minutes. It is not "read everything" and not "organise everything".

**Why this one:** it is the loop that works today (`docs/DEMO.md`), and the founder's own decisions were mostly letting go, not keeping. That is one person's behaviour, not market evidence.

| Hypothesis | Person and trigger | Today's workaround | Smallest result | Most likely reason they won't adopt | What would falsify it |
|---|---|---|---|---|---|
| **1. Saved backlog → let it go (chosen)** | Heavy saver opens their saved list and can't find or face anything | Keep saving and never look; mass-unsave; move it into a read-later app | One 10-card round plus one reversible pile in under 5 minutes | Import friction: third-party guides say Reddit's export lists saves as an ID and a link only, so cards would be thin (Reddit's help page doesn't list the columns). Or the pile costs them nothing ("river, not bucket") | Observed testers can't finish a round unaided, don't come back when new saves arrive, or say the unread pile costs them nothing |
| 2. Restart after a lapse | Returns to a backlog or planning system after weeks away and freezes | Declare bankruptcy, start a new tool, or quit | First decision within a minute of returning | They abandon the tool itself, not just the backlog | After a real absence of 7+ days, they don't reopen it, or reopen it and don't decide |
| 3. Decision queue for Markdown/PKM users | Weekly review of an Obsidian inbox or web clippings | Plugins, read-later exports, manual review | Kept items land as notes they later open | They want it inside their notes tool; export already exists elsewhere | They never open the exported notes, or prefer an in-app plugin |

- Hypothesis 2 is a property of hypothesis 1's design (the "Nothing is owed — start small" return line, count-wins only, finite rounds). Testing it needs real elapsed time, so it follows the deadline.
- Hypothesis 3 is an integration. `export-obsidian --status keep` already writes kept items as notes, but keeping is rare.

| Hypothesis | Who pays | Offer to test (not a price anyone has accepted) | First users |
|---|---|---|---|
| 1 | The saver | Free supervised round on their own export now; after repeat use, test a one-time "backlog reset" against a small monthly plan | People the founder knows who save heavily, then opt-in posts in communities about saved-content backlogs, only with approval |
| 2 | The person returning | Same product; the test is whether they come back on their own, not a new offer | Testers from hypothesis 1, followed up after a natural gap |
| 3 | The PKM user | Kept-to-notes as part of hypothesis 1's offer | Obsidian users among the hypothesis 1 testers |

**Entry workflow vs company.** The entry workflow is the finite round plus reversible piles on content people already saved elsewhere. A larger company would be a trusted "what can I safely drop" layer across saved information and, later, commitments. That expansion is only worth testing after people repeatedly use the entry workflow.

**Strongest counter-argument.** This may be a good personal tool, not a company:
- the evidence is one user, who also stopped using it for months;
- clearing a backlog can be a one-off job, with no recurring reason to pay;
- the connectors depend on platform exports and APIs that the product doesn't control;
- read-later apps already sell this: Readwise Reader describes "Superhuman's fun, game-like triage … built the same for reading", and Recall targets threads "gone in a sea of saved posts you never reopen" (vendor pages, fetched 2026-11-01). What's left to test is the job (letting go of saves that stay in their own apps), not the triage interaction.

**What would change the choice:** testers show a recent, costly restart failure (→ 2); testers already live in notes tools and only value the export (→ 3); nobody shows a recent cost from the pile (→ keep it a personal tool).

## The loop in the user's words

| Control | Means | Undo |
|---|---|---|
| **Done** (swipe left, `D`) | I used it, or I'm finished with it | Top-bar undo, or the Done tab in the Library |
| **Archive** (swipe right, `A`) | Not for me now. Out of sight, still searchable | Top-bar undo, or the Archived tab |
| **Keep** (`F`) | Worth keeping. It goes to Keep (and can be exported as a note) | Top-bar undo, or the Keep tab |
| **Not now** (`N`) | Ask me again in 7 days. Not counted as cleared | Top-bar undo |
| **Skip** (swipe down, `S`) | No decision. It stays where it was | Nothing to undo |
| **Let a pile go** (Today) | Archive a whole group at once. Nothing is deleted | The toast's undo, any time |

**Never without explicit approval:** unsave or change anything on Reddit (unsave-on-done is off by default); run network sync (autosync is off by default); permanently delete (`delete` and `purge-done` need both `--apply` and `--yes`, and take a backup); push items to Karakeep or PKMS (`promote` needs configuring first).

**What leaves the device.** The library is one local SQLite file. Cards load thumbnails and media from the sites they came from. Opening a Reddit item in the reader fetches its comment thread from Reddit (then public archives) unless it is already cached; this is on purpose (the owner, 2026-11-01). Opt-in commands (recovery, enrichment, hydration, promote) send individual item links or IDs to the services they name. `CONTENT_HOARDER_OFFLINE=1` turns all of it off for demos and tests. So "local-first" is accurate; "nothing leaves the device" is not.

## Brand Personality

Focused, forgiving, and instrumented. The voice should feel like a calm cockpit or log book for personal backlog work: clear status, tactile controls, no moralizing, and small signs of progress. It can be slightly nerdy and local-toolish, but never smug, gamified to the point of pressure, or glossy SaaS.

## Anti-references

- Generic SaaS dashboards with decorative metrics, hero gradients, and marketing-page polish.
- Hoarding-machine UI that celebrates accumulating more instead of clearing or deciding.
- Guilt-driven productivity copy: streak shame, overdue language, red-alert backlog panic, or empty states that scold.
- Overstimulating neon terminal aesthetics, glassmorphism, ornamental animations, and decorative card grids.
- Ambiguous destructive actions, especially around deletes, Reddit unsave, recovery, archival, or purge flows.

## Design Principles

1. **Triage first.** Every screen should help the user decide, defer intentionally, recover missing context, or get back to the next item.
2. **Local trust is visible.** Use copy and interaction states that make data locality, offline behavior, backups, and irreversible operations understandable.
3. **Cognitive load stays low.** Favor dense but legible hierarchy, predictable controls, discoverable operators, and short explanations over novelty.
4. **Progress is gentle.** Celebrate cleared rounds and rested piles without implying debt, failure, or obligation; count wins, never the remaining pile.
5. **Media and metadata serve decisions.** Thumbnails, source badges, tags, durations, archive status, and recovery affordances should answer “is this worth processing?” quickly.

## Accessibility & Inclusion

Target WCAG AA contrast for all text and controls, including muted metadata and placeholder text. The product is built for desktop and Chrome on Android/PWA use, so every swipe or keyboard path needs an equivalent tap/click control. Motion should be short, stateful, and covered by reduced-motion rules. Error and empty states should be readable, specific, and non-blaming; destructive actions need explicit confirmation and clear rollback/backup language when applicable.
