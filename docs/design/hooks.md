# Snappy and hooked: Duolingo-style rounds (proposal, 2026-11-01)

Status: proposal. Nothing here is built yet. The owner picks which mechanics ship; every mechanic gets its
own on/off switch and is measured (life-os decision 0035). Rounds stay finite and Today stays one
surface (0025).

Sources:
- Duolingo research: internal research notes citing Duolingo's own posts and letters.
- Readwise Reader and Recall pages, fetched 2026-11-01 and linked below.

## What we already have (the Duolingo "lesson" loop)

| Duolingo | content-hoarder today |
|---|---|
| A lesson is short and finishable | A round of 5 / 10 / 25 cards |
| Progress bar inside the lesson | Beads in the top bar |
| Lesson-complete screen | CLEARED stamp, receipt tiles, counted-up stats |
| Daily goal | Today's ring (`ch_goal`) |
| Combo feedback | "on a roll · N" |
| Instant next exercise | The next card is already rendered underneath; input never waits |

## Fix first: speed and bugs

The owner stopped using the app in July because the PWA felt slow and buggy. No mechanic below makes
up for that. Before any of them ship:

1. Run the phone device pass (tracked in private session notes).
2. Hit the targets below and keep them.

| Target | Value |
|---|---|
| Tap to the next card | under 1 frame |
| Cold open to the first card | under 1 s |
| Lost decisions | 0 |

## Mechanics, in build order

| # | Mechanic | Duolingo source pattern | Our version | Switch / measure |
|---|---|---|---|---|
| 1 | **Sound + haptic per decision** | Answer feedback | A short distinct tick for Done, Archive and Keep; a soft chord on CLEARED. Haptics already exist; add sound behind a setting | `sound_enabled`; skip rate = rounds played muted |
| 2 | **XP with let-go weighting** | XP weighted by what you want done (research §4: path work 1.0, side practice 0.5) | Done/Archive = 2 XP, Keep = 1, Not now = 0, a pile let go = 5. Combo ×2 after 5 fast decisions. Shown on CLEARED and in the ring | `xp_enabled`; check that undo rate doesn't rise (quality metric, research principle 12) |
| 3 | **Streak with freezes** | Minimum daily action = one lesson; freezes (research principles 1–3, 13) | One round of 5 keeps the day. Earn a freeze every 3 rounds, hold up to 2. A broken streak shows a fresh start, never "you lost N days" | `streak_enabled` (the owner already chose streak + freezes in 0035) |
| 4 | **Daily quests (3 tiny ones)** | Quests, easiest first, ending on a path item (principle 5) | "Clear 5", "Let one pile go", "Keep one thing worth keeping". Rotated daily | `quests_enabled`; how many are completed vs dismissed |
| 5 | **Gem after a round** | Variable reward (chest) | Sometimes the CLEARED screen shows one old Keep: "Still glad you kept this?" with Keep / Let go | `gem_enabled`, at most 1 per day; Let-go rate on gems |
| 6 | **Speed round** | Timed practice (Match Madness, principle 14) | 25 cards, optional timer, Skip is free | `speed_round_enabled`; regret = undos and re-opens of archived items within 7 days |
| 7 | **Friend streak** | Passive shared streak, +22% lesson completion (principle 10) | The owner and a friend tester see each other's "played today" dot. Later, and only with consent | Needs accounts; not before a hosted pilot |

**Rejected:**
- Hearts/lives (they punish mistakes; our forgiveness is undo).
- Leagues and leaderboards (one user).
- Phone push (0035 allows the Today view and Discord DMs only).
- Any count of what's left (PRODUCT.md principle 4).

## Measuring (0035 requires it)

Every mechanic needs:
- an `events` table in `app.db` that records each show, use and dismiss;
- a weekly check that switches a mechanic off when its dismiss rate stays above 70% for two weeks.

None of this exists yet; it is mechanic #0. Also track the regret signals per week: undo rate, and
items re-opened from Archived or Done within 7 days. A mechanic that raises swipes but also raises
regret gets switched off.

## Steal list from Readwise Reader and Recall

| Idea | Source (fetched 2026-11-01) | Our version |
|---|---|---|
| Shortlist: a small "read first" set inside the triage flow | [Reader library configuration](https://docs.readwise.io/reader/guides/workflows/library-configuration): "Triage Workflow: Inbox → Later → Archive"; Shortlist kept "to curate a selection of documents they want to make sure they read first" | Keep becomes "Today's 3". At most 3 items, and finishing them counts as wins |
| Daily Review of what you kept | [Reader](https://readwise.io/read): "The Daily Review resurfaces the right highlight at the right time" | The gem (#5) plus the learning module (`life-os/docs/modules.md`) |
| Quizzes / spaced repetition | [Recall pricing](https://www.getrecall.ai/pricing): "Quiz and spaced repetition to reinforce long-term memory" | Learning module, opt-in per kept item, reusing the round UI |
| Summarise a long Reddit thread before deciding | [Recall Reddit](https://docs.recall.it/use-cases/content-type/social/reddit): "Reddit's best answers are often buried 50 comments deep" | A one-line "what this thread concluded" on the card, from a local or chosen model. The card still works without it |
| Agent access to the library | [Readwise CLI](https://docs.readwise.io/tools/cli) | An MCP tool over the round: "propose decisions for these 25", accepted per card |

**Don't copy:**
- RSS/newsletter feeds (endless inflow).
- An endless "Later" list.
- Chat as the main screen.
- A knowledge-graph view.
- Highlighting as the core activity.

Each of these turns the app into another read-later or second-brain tool.
