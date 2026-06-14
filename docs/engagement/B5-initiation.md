# B5 · Initiation / Friction-to-Start

*The hardest rep is the first one — so engineer the app to make starting nearly effortless, lowering activation energy below the point where ADHD task-paralysis kicks in.*

## The idea

For an ADHD user staring at a 12,000-item pile, the bottleneck is not throughput — it's **getting started at all**. Every decision, tap, and field between opening the app and the first satisfying action is friction that can abort the session before it begins. The lever: collapse the path from *open* to *one done thing* to as close to zero choices and zero effort as possible, so the habit can actually form.

## The science

**Fogg's Behavior Model (B=MAP).** BJ Fogg (Stanford Behavior Design Lab) holds that behavior occurs only when Motivation, Ability, and a Prompt converge at the same moment [1]. Ability is the horizontal axis (hard→easy); his central, repeatedly-stated design insight is that **raising Ability (making the action tiny) is more reliable than pumping motivation** — motivation is fickle, ease is durable. Tiny Habits operationalizes this: shrink the behavior until it needs almost no motivation [1][2].

**Choice overload — real but contested.** Iyengar & Lepper's 2000 "jam study" found a 24-jam display drew more interest but yielded far fewer purchases (~3%) than a 6-jam display (~30%) [3]. *However*, this does not robustly replicate: Scheibehenne, Greifeneder & Todd's 2010 meta-analysis (50 experiments, N≈5,036) found a **mean effect size of virtually zero** with large between-study variance — choice overload is real *sometimes* but its preconditions are unknown [4]. Treat "fewer options" as a usually-helpful heuristic, not a law. **Hick's Law** (Hick & Hyman) is better-grounded: decision time rises *logarithmically* with the number of options [5] — so a wall of 12k items is genuinely slower to act on than a single card.

**Decision fatigue — flag as contested.** Baumeister's ego-depletion model (willpower as a depletable muscle) was hugely influential — a 2010 meta-analysis put it at d=0.62 — but a 23-lab pre-registered replication (>2,000 participants) found the effect **near zero (≈0.04)** [6]. I'm flagging this honestly: do *not* build core mechanics on the premise that the user has a finite daily willpower budget; lean on Ability/friction reduction instead, which doesn't depend on the disputed effect.

**ADHD task initiation.** This is the load-bearing science here. Russell Barkley frames ADHD as a disorder of *performance, not knowledge* — "doing what you know" — with a collapsed time horizon where the world splits into **"now" and "not-now"** [7]. Brendan Mahan (ADHD coach) names the emotional barrier the **"Wall of Awful"**: bricks of past failure/shame that make even simple tasks feel dread-inducing to start [8]. The fix is emotional and friction-based, not willpower-based.

**Smallest viable action.** David Allen's GTD **2-minute rule** — if it takes under two minutes, do it now [9] — and Fogg's "make it tiny" both lower the bar to "just one." **Steve Krug's "Don't Make Me Think"** first law of usability: make the next step self-evident; every question mark adds cognitive load and a drop-off point [10].

## How real apps do it

- **Superhuman (keyboard-first speed).** Cmd/Ctrl+K command bar + single-key actions (E=archive, Enter=open) let users clear dozens of emails without a mouse [11]. *Works:* removes per-item navigation friction. *Backfires:* steep learning curve — the first session is *harder*, not easier, so it doesn't lower initiation for a casual user.
- **Meditation apps (single "Start"/"Play").** Headspace/Calm-style apps default to one large play button so the action is one tap with zero configuration. *Works:* near-zero activation energy. *Backfires:* if it opens to a content *library* first (choose course → choose session → choose length), you've reintroduced Hick's-Law paralysis before value.
- **To-do apps that open to one task.** Apps offering a "Today" or single-next-task view (vs. the full project tree) reduce the open→act path. *Works:* picks the decision *for* you. *Backfires:* if the chosen task feels wrong/heavy, the user bounces with no easy "give me a different one."
- **Tinder (swipe = one binary decision).** Reduces each item to a single low-stakes gesture. *Works:* this is exactly the friction profile ADHD initiation needs. *Backfires:* infinite supply can become a compulsion loop — fine for triage, watch for it as a pattern.

## ⚠️ ADHD & ethical caveats

- **The "open to a wall of items" anti-pattern is the core problem.** Landing on a 12k inbox *list* maximizes Hick's-Law decision time and feeds the Wall of Awful at the worst moment — the instant of opening.
- **Choice overwhelm from the pile is real even if the lab effect is shaky** — at 12k items the relevant cost is decision *time* (Hick, well-grounded), not the contested overload effect.
- **Don't over-hide.** Crushing friction by reducing everything to one forced card can feel patronizing or trap-like ("am I allowed to just browse?"). Preserve an obvious escape hatch to the full list and an easy "skip/next."
- **No guilt mechanics.** Because decision-fatigue/willpower science is contested, *don't* frame slow days as "depleted willpower" or guilt the user. Make starting easy; never punish not-starting.

## Takeaways for content-hoarder

- **[P1 · effort S]** *Open to ONE triage card, not the inbox list* — a setting/default that lands on a single swipeable card instead of the wall. Maps to the existing triage card + a new "start screen" preference. Risk: power-users who want the list; keep a one-tap toggle to list view.
- **[P1 · effort S]** *Pick that first card with the parked triage-score / smart-triage queue* — the "likely-done" model already exists; use it to choose the *one* card so the user never decides what to start. Risk: a bad first pick; allow instant "skip."
- **[P1 · effort S]** *"5-card sprint" framing* — open offers a tiny, closable batch ("5 cards") not infinite scroll; a tiny goal beats an open-ended one (Fogg "tiny", GTD "just one"). Maps onto Focus mode's batching. Risk: don't auto-extend the sprint (compulsion); let *them* re-trigger.
- **[P1 · effort S]** *Resume state — "pick up where you left off"* — persist last position/queue so reopening restarts mid-flow, not from a cold wall (Krug: reduce steps-to-value). Risk: stale resume after long gaps — offer "resume vs fresh 5."
- **[P2 · effort S]** *One-tap actions, sensible defaults everywhere on the card* — Keep/Archive/Done as single gestures with undo (already present); never require a field or menu to act. Maps to existing swipe + undo. Risk: mis-swipes — keep undo prominent.
- **[P2 · effort M]** *Make "Surprise"/Shuffle the zero-config entry point* — a "Just give me something" button that hands one resurfaced/interleaved card with no setup. Maps to existing Surprise + Shuffle. Risk: randomness surfacing junk — bias toward smart-triage, not pure random.
- **[P2 · effort S]** *Lower the per-card decision count* — show only what's needed to triage (title + source + one action row); defer detail to tap-through (Hick's Law). Mechanics-only; **visual layout needs the design pass**.
- **[P3 · effort S]** *Keyboard/gesture shortcuts on the card* (Superhuman-style: one key = Keep/Archive/Done) for desktop sessions. Risk: discoverability — surface hints, don't hide value behind unlearned keys.

## Sources

1. Fogg Behavior Model (B=MAP), BJ Fogg — https://www.behaviormodel.org/
2. The Fogg Behavior Model, The Behavioral Scientist — https://www.thebehavioralscientist.com/articles/fogg-behavior-model
3. Iyengar & Lepper (2000), "When Choice is Demotivating" / jam study summary — https://www.pbs.org/newshour/economy/is-the-famous-paradox-of-choic
4. Scheibehenne, Greifeneder & Todd (2010), meta-analytic review of choice overload, *J. Consumer Research* — https://academic.oup.com/jcr/article-abstract/37/3/409/1827647
5. Hick's law (Hick–Hyman), Wikipedia — https://en.wikipedia.org/wiki/Hick%27s_law
6. Ego depletion — replication collapse (d=0.62 → ≈0.04) — https://en.wikipedia.org/wiki/Ego_depletion
7. ADHD "now vs not-now" / Barkley time horizon — https://adhdos.substack.com/p/from-now-to-not-now-adhd-and-temporal
8. The Wall of Awful™ (Brendan Mahan), ADHD Essentials — https://www.adhdessentials.com/essentials/the-wall-of-awful/
9. The Two-Minute Rule (David Allen), Getting Things Done® — https://gettingthingsdone.com/2020/05/the-two-minute-rule-2/
10. "Don't Make Me Think" (Steve Krug) — key principles — https://www.liquidlight.co.uk/blog/dont-make-me-think-a-bible-on-usability-by-steve-krug/
11. Superhuman keyboard shortcuts / Command — https://help.superhuman.com/hc/en-us/articles/45191759067411-Speed-Up-With-Shortcuts

---
*Part of the content-hoarder [engagement research set](README.md). Researched 2026-06-14 (Claude + web sources; contested findings flagged in-line).*
