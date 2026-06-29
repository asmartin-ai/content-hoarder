# content-hoarder · Engagement & Habit Research

Research into making content-hoarder a tool you genuinely *want* to open and find frictionless to
start — building a **sustainable daily triage habit** without dark patterns, guilt, or anxiety.

**Framing.** You're the sole user, and you have ADHD. So this is *self-directed behavior design*, not
engagement-farming: optimize for long-term wellbeing and real backlog progress, never vanity metrics.
Every doc flags where a mechanic tips from "satisfying" into "compulsive/shaming," because for ADHD that
line is thin (interest-based nervous system; rejection-sensitive, all-or-nothing tendencies).

Each doc follows: **the idea → the behavioral science (verified, cited) → how real apps do it → ADHD &
ethical caveats → concrete prioritized takeaways** mapped to content-hoarder's actual features
(triage card, daily goal, Stats, Shuffle/Mix, Surprise card, decay, the shipped triage-score via `learn-triage`).

## Areas

### A · Core loop & rewards — researched 2026-06-14 ✅
| # | Doc | One-line |
|---|-----|----------|
| A1 | [The Habit Loop](A1-habit-loop.md) | Hooked / Fogg / Duhigg — wire cue→action→variable reward→investment so the app pulls you back on its own |
| A2 | [Variable Rewards & Serendipity](A2-variable-rewards.md) | Unpredictable payoffs hook hardest — aim them at rediscovery + progress, not a slot-machine loop |
| A3 | [Progress, Streaks & Goals](A3-progress-streaks.md) | Visible, finishable progress is the cheapest motivation — pointed wrong it manufactures guilt |
| A4 | [Gamification](A4-gamification.md) | Game mechanics can spark the habit — shallow points can poison the motivation the app depends on |

### B · Friction & feel — researched 2026-06-14 ✅
| # | Doc | One-line |
|---|-----|----------|
| B5 | [Initiation / Friction-to-Start](B5-initiation.md) | The ADHD crux — crush the activation energy of the first action; open to one card, not the 12k wall |
| B6 | [Juice & Sensory Reward](B6-juice.md) | Make the swipe-commit feel physically good (haptics/sound/motion) — calm, optional, decision-not-gesture |

### C · Intelligence & triggers — researched 2026-06-14 ✅
| # | Doc | One-line |
|---|-----|----------|
| C7 | [Smart Surfacing / Personalization](C7-smart-surfacing.md) | Tune the shipped triage-score as default ranking (live on main via `learn-triage`); explain the "why"; mix in exploration so it never narrows into a rut |
| C8 | [Triggers & Re-engagement](C8-triggers.md) | A self-set "triage o'clock" nudge (verified PWA-push path; or a cheaper digest first) — never a guilt-trip |

### D · Mindset — researched 2026-06-14 ✅
| # | Doc | One-line |
|---|-----|----------|
| D9 | [Framing & Anti-Overwhelm](D9-framing.md) | The mindset layer — hide the doom-total, reframe the user as a *curator*, make lapses costless; mostly microcopy/defaults |

## Cross-cutting synthesis (A1–A4)

Four docs researched independently, and they converge hard.

### Do-first shortlist — high value · low effort · low risk
1. **Hide the scary 12k total; show "X cleared today."** *(A1, A3)* The lifetime number is pure Zeigarnik dread; today's count is closure. Zero-risk anti-overwhelm. → Stats panel + triage card.
2. **Backlog burn-down as net flow** ("down 340 this week", projected days-to-zero). *(A3, A4)* The **safest** high-value lever — pure competence feedback (SDT), informational so it sidesteps overjustification. → Stats (logic now; chart *needs the design pass*).
3. **Land the home-screen tap on ONE triage card, not the list.** *(A1)* One swipe = one complete loop; kills initiation friction (Fogg "Ability"). → launch route + triage card.
4. **Reframe the daily goal as a forgiving floor with grace built in** — accumulation ("3 done ✓") + endowed-progress head-start, **no punishing chain**. *(A1, A3, A4)* → daily goal.
5. **Tune the shipped triage-score (live on main via `learn-triage`), human-in-the-loop.** *(A1, A2, A4)* It is literally Eyal's "Investment" phase **and** a "Hunt" reward engine **and** an SDT competence/autonomy win — three docs independently say tune it. → triage-score tuning.

### The consensus DON'Ts (every doc warns)
- ❌ **No rigid punishing streaks.** A broken chain after a rough ADHD week → guilt → abandonment (the "what-the-hell effect"). If you ever add a streak, ship **freezes/grace in v1**, never later.
- ❌ **No XP/points/levels per swipe, no leaderboards.** Overjustification (Lepper 1973) can poison the intrinsic motivation you need for years; leaderboards are structurally N/A for a solo app. Reward *real progress*, not taps.
- ❌ **No guilt notifications** ("you're behind", "Duo misses you"). A self-built tool shouldn't nag its owner.
- ❌ **No infinite scroll without a stopping cue.** A 12k backlog *is* an endless feed — raw material for a "machine zone." Pair serendipity with the daily-goal endpoint.

### The recurring positive pattern
Rewards should be **unexpected** (not every-tap), **real** (backlog shrinking / gems found, not vanity numbers),
and **forgiving** (re-entry after a lapse is frictionless, never punished). Two motifs surface again and again:
**decay reframed as a win** ("40 released this week") and **variable rewards weighted toward valuable-but-stale
rediscovery** (invert the triage score to surface high-value buried items).

## B · Friction & feel — key takeaways (added 2026-06-14)

**B5 (initiation)** is the highest-leverage band for an ADHD user — the whole game is the *first* action:
- **Open to ONE card, not the inbox wall** — and let the shipped **triage-score** pick it, so *zero decisions* precede the first swipe. The single biggest initiation fix; it also reinforces the A-band's "tune the triage-score."
- **"5-card sprint" + resume state** — a tiny, closable batch and "pick up where you left off," not infinite scroll from a cold start.
- *Honesty note:* choice-overload (the jam study) and decision-fatigue/willpower-depletion **failed replication** — so the case rests on the well-grounded **Hick's Law** (a 12k list is genuinely slower to act on) + **ADHD task-initiation** (Wall of Awful, now/not-now), not on shaky willpower science.

**B6 (juice)** splits cleanly around the paused visual overhaul:
- **Ship now (no design pass):** a crisp `navigator.vibrate()` haptic on swipe-commit (Android/Chrome PWA ✅; iOS Safari ✗), explicit commit-threshold + snap-back logic, a **mute-first** haptics/sound toggle, `prefers-reduced-motion` plumbing, an optional WebAudio tick.
- **Gated on the design pass:** card motion/spring polish, milestone confetti, drag-state tinting.
- *Honesty note:* a CHI 2024 study found juice mostly buys **appeal, not better outcomes** — so treat it as making the chore pleasant, and **reward the decision, not the gesture** (don't juice swiping into a slot machine).

**The bands stack:** B5 gets you *in* and to one card; A1/A3's closure feedback + B6's commit haptic make each swipe *feel* done; the triage-score (A + B5) means you never choose what to start.

## C · Intelligence & triggers — key takeaways (added 2026-06-14)

**C7 (smart surfacing)** lands on the same centerpiece *yet again*: **tune the shipped triage-score** as the default ranking (live on main via `learn-triage`), with its **"why this" always-on** (autonomy/trust, SDT). But don't let it only *exploit*:
- **Explore/exploit budget** — draw ~15–20% of the queue from the long tail, and route the **Surprise card as the exploration arm** (multi-armed-bandit framing). Pure exploitation narrows into a rut.
- **Seen-recently penalty** — decay a skipped item's score before it reappears (Readwise's cheapest anti-monotony trick; reuses DECAY).
- **Context modes** — a "5 min / 20 min / lots" available-minutes filter (trivial) and **opt-in, user-declared** energy modes (low-energy→listenable). *Honesty:* time-of-day weighting is evidence-based; the ADHD energy→completion link is a *hypothesis to test on your own logs*, not settled — and never silently infer-and-impose (patronising).

**C8 (triggers)** is the one genuinely **new capability** — the app has a full loop but nothing to *start* it. A user-set **"triage o'clock"** daily nudge is the missing external spark.
- **Verified technical path:** PWA web push works on the Pixel-6 via **Web Push + VAPID + `pywebpush` from Flask — no Firebase/Google account needed**. Schedule it **server-side** (cron); the client Notification Triggers API is dead. The Tailscale delivery path is *reasoned, not verified* — test it.
- **The pragmatic call:** prototype a **daily email/Telegram digest first** (one cron + one send, zero client work) — same external trigger, far less fragility — and only build full push if the lighter nudge proves it earns a session.
- **Ethics (the dark-pattern hotzone):** neutral copy ("12 waiting", never "you're behind"), quiet hours, one-tap off, **skip-when-zero**, no streak-shame. You're building for your future self's calm, not a growth metric.

**Tally so far:** "open to one card + ship the triage-score" now surfaces in **5 of 7 content docs** (A1, A2, A4, B5, C7) — it is unambiguously the first thing to build. C8's nudge is the natural second, started cheap.

## D · Mindset — key takeaways (added 2026-06-14)

**D9 (framing)** is the layer that makes every other mechanic *sustainable* — almost no new code, all **microcopy / framing / defaults**:
- **Hide the doom-total** (a standing loss-frame + ADHD shame trigger) — show "your stream," not "12,000 to do."
- **Decay = "released" / "let go," celebrated as curation** — the *celebrate-subtraction* motif that recurs in A1, A4, and D9.
- **"Curator," never "hoarder/backlog/debt"** — identity-based habits (every swipe is a vote); plus **kind lapse handling** ("welcome back, your stream kept flowing") to defuse the what-the-hell effect. Self-compassion out-motivates self-criticism (Neff).
- Watch for **toxic positivity** — calm and genuine beats cheerleading.

---

## ★ Master recommendation — the build order (synthesis of all 9 docs)

The whole sweep points at one core, wrapped in kind framing, with a cheap external nudge. Suggested order:

**Phase 1 — the convergent core** (the loudest signal; mostly backend logic, dodges the design freeze)
1. **Tune the shipped triage-score (live on main via `learn-triage`)** as default smart-triage ranking — *with* an explore-mix (Surprise = the explore arm) + a seen-recently penalty + always-on "why." *(A1·A2·A4·B5·C7 — 5 docs)*
2. **Open to ONE card** (triage-score-picked), not the 12k list. *(B5)*
3. **Hide the scary total; show "X cleared today" + "your stream" framing.** *(A3·D9)*
4. **Daily goal → a forgiving floor**, endowed-progress head-start, no punishing chain. *(A1·A3·A4·D9)*
5. **Mute-first haptic on swipe-commit + commit-threshold logic.** *(B6 · ship-now)*

**Phase 2 — make it stick**
6. **Backlog burn-down**, framed as encouragement not audit. *(A3·A4·D9)*
7. **Decay reframed as "released" wins + curator microcopy.** *(A1·A4·D9)*
8. **A cheap daily email/Telegram digest** as the external trigger — *before* full web push. *(C8)*
9. **Forgiving streak with grace built in — or skip streaks.** *(A3·A4)*

**Guardrails — every doc agrees:** ❌ no punishing streaks · ❌ no per-swipe XP/levels/leaderboards · ❌ no guilt notifications · ❌ no infinite scroll without a stop-cue · ✅ reward the *decision*, not the gesture · ✅ keep "why" visible · ✅ build for your future self's calm.

---
*Sweep complete 2026-06-14 — all 9 areas (A1–D9) researched via parallel web research (Claude + cited sources;
load-bearing claims verified, contested/unverifiable findings flagged in-doc).*
