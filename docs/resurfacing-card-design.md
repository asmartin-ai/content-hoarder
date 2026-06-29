# Resurfacing card — design one-pager ("Still interested in X?")

*Epic 20 Stage-C design input (PKMS research adoption, 2026-06-10). Status: **DESIGN
LOCKED 2026-06-11** (all four open questions decided by Kenja — see Decisions at the
bottom). **BUILT + SHIPPED 2026-06-11** (`resurface.py` + `/resurface*` routes + the v3 browse card in `main.js`). Research constraints baked in from
`K:\Projects\PKMS\vault\resources\research\32-theme-retrieval.md`.*

## What it is

One small, ambient card in the v3 browse view that asks a curious question about a
**cluster** of old saves — never a count, never a queue:

> **Still interested in ADHD strategies?**
> *[thumb] 30 saves in r/ADHD_Programmers · last added Feb 2026*
> [ Show me ] [ Not now ] [ Let it go ]

Recognition beats recall: the card shows the cluster (label + 2–3 recognizable
titles/thumbnails), the user only reacts. No search required, no blank box.

## Hard rules (from the research; non-negotiable)

- **Question, never a counter.** No unread counts, no red dots, no "82,190 items".
- **One ambient slot**, at most one card per app-open, at most one per day. Alert
  fatigue drops acceptance ~30% per repeat — ration hard.
- **Dismiss = silent decay.** "Not now" hides the cluster for a no-renag window
  (default 30 days) and is never mentioned again. No accumulating debt, no guilt copy.
- **Identity/meme content never resurfaces.** Candidates come from knowledge buckets
  only; a 3-year-old meme resurfaced as a task is noise (CH3).
- **Event-based, not clock-based.** The card renders on app open when a candidate
  exists — never a scheduled notification, never "review Friday 9am" (RT2).

## Candidate clusters

A cluster is either a **knowledge tag** (`tips`, `coding`, `science`, `japan`) or a
**knowledge subreddit** with meaningful volume but no bucket (e.g. `adhd` 569,
`askhistorians`, `personalfinance`) — the curated list lives with the vocab in
`categorize.py`, not in UI code.

Ranking (pick ONE candidate per day, highest first):
1. **Reactivation signal** (CH4: interest is episodic): the user saved into the
   cluster within the last 14 days after ≥90 days of dormancy → "you're back on X —
   want your old saves?"
2. **Dormant + high propensity:** mean `metadata.triage_score` of the cluster's inbox
   items (the Epic 10 triage-score model — shipped on main via `learn-triage`; the ranking term
   is active) × months dormant — surfaces clusters the model thinks he'd actually process.
3. Tie-break random among the top 3 so repeat days vary (bounded surprise).

## Actions

| Action | Behavior |
| --- | --- |
| **Show me** | Opens browse filtered to the cluster (`tag:` or `subreddit:` + `status:inbox`), sorted by `triage_score` desc — quick wins first. |
| **Not now** | Silent dismiss; cluster ineligible for `no_renag_days` (default 30). Stored in `settings.resurfacing_state` (JSON: `{cluster: {dismissed_until, last_shown}}`). No schema change. |
| **Let it go** | Offers a one-tap decay of the cluster's inbox items (reversible *unlabeled* cluster decay — `is:decayed`, **not** `is:swept`; via a POST) with the standard undo toast. Guilt-free exit — "let go" copy, never "delete" or "overdue". |

## A "surprise me" sibling (same slot, cheaper)

When no cluster qualifies, the slot MAY show one bounded random old save
(`get_random_batch(n=1)` filtered to knowledge buckets) phrased as rediscovery
("From your 2021 saves:") — converts the rediscovery-joy that sustains the save habit
into a deliberate loop. Never both cards at once.

## Decisions (Kenja, 2026-06-11)

1. **Knowledge-subreddit seed approved:** `adhd`, `adhdwomen`, `askhistorians`,
   `personalfinance`, `philosophy`, `history` (all deliberately untagged — cluster by
   subreddit, not tag).
2. **`japan` is a resurface cluster, NOT a decay bucket.** It already sat outside the
   swept waves; it is now also removed from the future-waves list in BACKLOG Epic 21 —
   a cluster can't be both "ask me about it later" and "let it go silently."
3. **No-renag window: 30 days** for "Not now"; "Let it go" never re-asks.
4. **"Let it go" needs no extra confirmation** — the standard undo toast suffices
   (it's a reversible decay; extra confirms are exactly the friction to avoid).

## Build sketch — ✅ BUILT (shipped 2026-06-11: `resurface.py` + `/resurface*` routes + the `main.js` card)

- `GET /resurface` → `{cluster, label, sample[3], action_urls}` or `204` (no candidate
  today). Candidate logic in a small `resurface.py` (testable, DB-only).
- v3 browse renders the card from that endpoint in the Stage-C shell slot; dismiss
  POSTs back. No service worker, no notifications, no new tables.
