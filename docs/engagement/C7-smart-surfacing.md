# C7 · Smart Surfacing / Personalization

*Surfacing the right item at the right moment for one ADHD user — content-based + behavioral modeling, explained and honestly bounded, with exploration baked in so the pile never narrows into a rut.*

## The idea

content-hoarder has ~12,000 items and one user. The job is not "what's objectively best" but "what will *this person* actually act on *right now*." That's a ranking-and-timing problem: score items by likely-action, but deliberately mix in novelty and match the surface to the user's current state. The parked triage-score already does the hard half (behavioral modeling); the work is to un-park it, make its "why" visible, and wrap it in an explore/exploit policy and light context-awareness — all mechanics, no visual overhaul.

## The science

**Two classic paradigms.** *Collaborative filtering* (CF) recommends what *similar users* liked — "users like you also saved…" [1][2]. *Content-based filtering* recommends items *similar to what you yourself engaged with*, using item features (source, subreddit, channel, media type, category) [1][3]. CF is the workhorse of big platforms but **structurally cannot apply here**: there are no other users, so there is no neighbourhood to borrow taste from. A solo app is *necessarily* content-based + behavioral. The triage-score — a per-feature processed-rate model, Laplace-smoothed — is exactly this: a content-based model learned from your own behavior. (Laplace/additive smoothing is the textbook fix for sparse features, so a brand-new channel isn't judged on one data point — correct and well-founded [3].)

**Exploration vs exploitation.** Always showing "most likely to finish" is pure *exploitation*: it maximises today's hit-rate but starves you of information about everything you rarely touch, and the long tail rots. The *multi-armed bandit* framing makes the tradeoff explicit — you must sometimes pull an uncertain arm (*explore*) to learn, accepting short-term regret for long-term value [4][5]. In recommenders this is also the engine of *serendipity*: novelty you didn't know to ask for [4]. content-hoarder's "Surprise" card is, conceptually, the exploration arm — it just isn't yet governed by an explicit budget.

**Filter bubble.** Eli Pariser coined "filter bubble" in his 2011 book — "that personal ecosystem of information that's been catered by these algorithms" [6][7]. *Honest flag:* the political/echo-chamber version is **empirically contested** — multiple studies (Wharton, Harvard, Princeton/NYU) found personalization expanded taste or barely moved opinions, and reviews call the evidence inconclusive [7][8]. For a *solo triage tool* the political framing is irrelevant; the real failure mode is **monotony** — over-fitting to "easy" items and burying the long tail. That risk is concrete here even though the democracy-scale claim is not.

**Explainability & autonomy.** Telling the user *why* an item surfaced builds trust and preserves agency. This grounds in Self-Determination Theory (Deci & Ryan, 1985, U. Rochester): wellbeing and durable motivation rest on *autonomy*, *competence*, *relatedness* [9][10]. A recommender that explains itself supports autonomy (you understand and can override the rationale) rather than supplanting it [11]. The triage-score's top-3 "why" is a genuine asset — most consumer recommenders never expose this.

**Context-awareness.** Adomavicius & Tuzhilin formalised *context-aware recommendation*: adapt to the user's situation — time, location, available time, state — not just static taste [12]. Mapping low-energy→"listenable", focused→"watch", short-window→short items is a textbook context dimension. *Honest flag:* that **time-of-day** patterns exist in personal behavior is evidence-based (it's literally how Spotify's daylist works [13]); that a *self-reported ADHD energy level* reliably predicts which media you'll finish is a **reasonable heuristic, not a validated finding** — treat it as a hypothesis to test on your own logs, not a fact.

## How real apps do it

- **Spotify daylist** — refreshes several times daily, keying off *what you historically play at this hour/day* plus context signals; titles like "upbeat pop Monday morning" [13]. Pure time-of-day context-awareness. *Works:* feels uncannily timed. *Backfires:* can ossify into the same loops if exploration is thin.
- **Spotify Discover Weekly** — content/collaborative blend surfacing the adjacent-unknown; the canonical serendipity engine. *Backfires:* over-fit weeks feel like more-of-the-same.
- **YouTube recommendations** — heavy engagement-optimised exploitation; the textbook *monotony/rabbit-hole* cautionary tale — optimising watch-time alone narrows the feed. The anti-pattern to avoid.
- **Readwise Daily Review / resurfacing** — probability-of-resurfacing proportional to share of library, and **each time an item is shown its probability drops sharply** so nothing repeats immediately; Mastery adds a recall-half-life decay [14]. Directly relevant: a *seen-recently penalty* is the cheapest anti-monotony lever there is.
- **A "For You" queue** generally — pre-assembled so the user faces *one next thing*, not 12,000 — exactly the ADHD initiation win.

## ⚠️ ADHD & ethical caveats

- **Monotony is the real bubble.** Optimising "likely-done" alone surfaces the same easy sources forever and buries the long tail you *meant* to process. Exploration is non-negotiable, not a nicety.
- **Energy-matching can patronise.** Inferring "you're low-energy, here's easy stuff" risks being wrong and infantilising. Keep it *opt-in and user-declared* ("I'm low-energy" is a button the user presses), never silently inferred-and-imposed.
- **Don't automate the decision away.** The goal is to *support* triage, not auto-archive. Autonomy (SDT) means the user always sees the reason and can override — surfacing ≠ deciding [9][11].
- **Keep "why" visible.** The moment ranking becomes an opaque black box, trust erodes and you stop believing the queue. Transparency is the feature, not a debug aid.
- **No guilt mechanics.** Tie surfacing to the existing daily goal gently; never weaponise the backlog count or streaks against the user.

## Takeaways for content-hoarder

- **[P1 · S]** **Un-park and ship the triage-score** as the default ranking for "smart triage." It's built, transparent, and content-based — the single highest-leverage move. *Risk:* if it only ever exploits, it narrows — ship it *with* the explore mix below, not before it.
- **[P1 · S]** **Make the "why this" explanation always-on**, not buried. The top-3 feature reasons are your autonomy/trust asset [9][11]. *Risk:* keep it terse — one line, not a lecture.
- **[P1 · M]** **Add an explicit explore/exploit budget** (e.g. ε≈15–20% of the queue drawn from low-data / long-tail items) and **route the existing Surprise card as the exploration arm** [4][5]. *Risk:* tune ε — too high feels random, too low re-creates the rut.
- **[P1 · S]** **Add a "seen-recently" penalty** to ranking so a skipped/declined item's score decays before it reappears — Readwise's cheapest, most effective anti-monotony trick [14]. Reuses the existing DECAY system. *Risk:* don't bury items permanently; let the penalty recover.
- **[P2 · M]** **User-declared energy/mood modes** — explicit buttons ("low-energy"→bias to *listenable*; "focused"→*watch*) that reweight categories. Maps to existing categories. *Risk:* opt-in only; never auto-infer-and-impose (patronising-failure caveat). Treat the energy→completion link as a **hypothesis to validate on your logs**, not settled fact.
- **[P2 · M]** **Time-of-day weighting** from your *own* logged completion-by-hour — evidence-based, unlike mood [12][13]. A small learned prior, not hand-coded rules. *Risk:* needs enough history; cold-start with a neutral prior.
- **[P2 · S]** **Available-minutes filter** — a "5 min / 20 min / lots" control that gates by item length/media type. Pure context-awareness, trivially mechanical. *Risk:* requires duration metadata; fall back gracefully when missing.
- **[P3 · S]** **Long-tail resurfacing quota** — guarantee N items/day from rarely-touched sources, logged in Stats so you can *see* the pile broadening. *Risk:* keep the quota small so it aids rather than derails the session.
- **[P3 · M, needs the design pass]** A pre-assembled **"For You" queue** surface (one-next-thing framing) — the ADHD initiation win — deferred behind the paused visual overhaul.

## Sources

1. [Collaborative filtering — Wikipedia](https://en.wikipedia.org/wiki/Collaborative_filtering)
2. [Collaborative vs Content-Based Filtering — comparative study (arXiv)](https://arxiv.org/pdf/1912.08932)
3. [Content-Based vs Collaborative Filtering — GeeksforGeeks](https://www.geeksforgeeks.org/machine-learning/content-based-vs-collaborative-filtering-difference/)
4. [Bandit algorithms in recommender systems — RecSys 2019 (ACM)](https://dl.acm.org/doi/10.1145/3298689.3346956)
5. [Long-Term Value of Exploration — measurements & algorithms (arXiv)](https://arxiv.org/pdf/2305.07764)
6. [Eli Pariser: Beware online "filter bubbles" — TED](https://www.ted.com/talks/eli_pariser_beware_online_filter_bubbles)
7. [Filter bubble — Wikipedia](https://en.wikipedia.org/wiki/Filter_bubble)
8. [Echo chambers, filter bubbles, and polarisation: a literature review — Reuters Institute, Oxford](https://reutersinstitute.politics.ox.ac.uk/echo-chambers-filter-bubbles-and-polarisation-literature-review)
9. [Self-Determination Theory and the Facilitation of Intrinsic Motivation — Ryan & Deci (PDF)](https://selfdeterminationtheory.org/SDT/documents/2000_RyanDeci_SDT.pdf)
10. [Self-Determination Theory of Motivation — Simply Psychology](https://www.simplypsychology.org/self-determination-theory.html)
11. [Respect for Human Autonomy in Recommender Systems (arXiv)](https://arxiv.org/pdf/2009.02603)
12. [Context-Aware Recommender Systems — Adomavicius & Tuzhilin, AI Magazine (ACM)](https://dl.acm.org/doi/10.1609/aimag.v32i3.2364)
13. [Spotify Daylist: how it works — Tech Times](https://www.techtimes.com/articles/296274/20230912/spotify-daylist-new-service-helps-match-mood-depending-time-dayhow.htm)
14. [Reviewing Your Highlights (resurfacing algorithm) — Readwise Docs](https://docs.readwise.io/readwise/docs/faqs/reviewing-highlights)

---
*Part of the content-hoarder [engagement research set](README.md). Researched 2026-06-14 (Claude + web sources; heuristic-vs-evidence flagged in-line).*
