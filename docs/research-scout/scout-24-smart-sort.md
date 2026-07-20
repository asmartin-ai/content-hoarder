# scout-24-smart-sort — scout research memo

> UNVERIFIED scout output (hy3, 2026-07-20). Claims need source-checking before load-bearing use.

# Research Memo: Ranking Algorithms for Ethical Personal Triage

**To:** Product Lead / Engineering
**From:** Research Scout
**Subject:** Offline ranking strategies for ADHD-friendly content triage (90k items, SQLite)

---

## 1. Lightweight Ranking Signals (Offline, Personal Scale)

For a local dataset of ~90k items, we avoid neural nets. We rely on heuristics that can be computed via SQL window functions or simple Python iteration.

### A. Recency & Staleness (Time-Decay)
*   **Formula:** **Exponential Decay.**
    $$Score_{recency} = e^{-\lambda (t - t_0)}$$
    Where $t$ is current time, $t_0$ is save time, and $\lambda$ is the decay constant (e.g., $\ln(2) / \text{half-life}$).
*   **Application:** Items saved 5 minutes ago score high; items saved 2 years ago score near zero unless revived by other signals.
*   **Failure Mode:** **"Novelty Bias."** High-quality evergreen content (e.g., a timeless tutorial) drowns in the sea of recent but low-value news articles.

### B. Dwell/Skip History (Implicit Feedback)
*   **Formula:** **Bayesian Smoothing (Wilson Score Interval).**
    Instead of simple Click-Through Rate (CTR), use the lower bound of the Wilson score interval for a Bernoulli parameter to handle small sample sizes.
    $$s = \frac{p + \frac{z^2}{2n} - z \sqrt{\frac{p(1-p)}{n} + \frac{z^2}{4n^2}}}{1 + \frac{z^2}{n}}$$
    Where $p$ is the ratio of "Kept" (did not skip) to "Shown", and $n$ is the total views for that tag/source.
*   **Application:** Prevents a tag opened once (lucky guess) from dominating a tag opened 50 times with mixed results.
*   **Failure Mode:** **Cold Start.** New tags or sources have no data, forcing them to rely entirely on the prior (global average).

### C. Subreddit/Domain Affinity (Content Similarity)
*   **Formula:** **Jaccard Similarity of Co-occurrence.**
    Calculate affinity between the current item's source (e.g., `r/Python`) and the user's "Kept" history.
    $$Affinity = \frac{|A \cap B|}{|A \cup B|}$$
    Where $A$ is the set of sources for "Kept" items, $B$ is the set of sources for the candidate item.
*   **Application:** If you keep items from `r/Go`, the algorithm boosts `r/Programming` even if `r/Programming` hasn't been explicitly interacted with much, based on overlap.
*   **Failure Mode:** **Filter Bubble.** The user never sees diverse content, leading to stagnation.

### D. Content Class (Semantic Type)
*   **Formula:** **Manual Weighting / Naive Bayes Classifier.**
    Classify items into: `Tutorial`, `News`, `Discussion`, `Media`.
    Assign a static weight based on user intent (e.g., "I want to learn" vs "I want to relax").
*   **Application:** Downranking `News` on weekends; upranking `Tutorial` on Tuesday mornings.
*   **Failure Mode:** **Misclassification.** If the heuristic for "Tutorial" is weak (e.g., just checking for long words), it fails silently.

---

## 2. Commercial Algorithms: Addiction Mechanics vs. Ethical Repurposing

### The "Addiction Loop" Mechanics
1.  **TikTok (Monolith/Vine):** Uses a **Successive Halving** mechanism. It rapidly allocates traffic to high-engagement content and starves low-engagement content in real-time. It optimizes for *session time*.
2.  **Reddit (Best Sort):** Uses the **Wilson Score Interval** (as mentioned in Sec 1) but applies it to *community upvotes*, not personal relevance. It balances *confidence* vs. *rating*.
3.  **Anki (FSRS - Free Spaced Repetition Scheduler):** Uses a **DSR (Difficulty, Stability, Retrievability)** model. It calculates the exact moment memory decay occurs to prompt review. It optimizes for *retention efficiency*.

### Ethical Repurposing (Per Constraints)
*   **From TikTok:** **Reject** successive halving (it creates the "doom scroll" by aggressively feeding the fire). **Adopt** the concept of *rapid negative feedback*. If a user skips 3 items from `r/News` in a row, the system should *immediately* swap to `r/DIY` (Context Switching), not just lower the score slightly. This respects attention, it doesn't trap it.
*   **From Reddit:** **Adopt** Wilson Scoring for *personal* history. It is mathematically honest about uncertainty.
*   **From Anki:** **Adopt** the concept of **Staleness Decay (Half-Life)**. Anki ensures you see a card right before you forget it. For triage, we want to surface an item right before it becomes "stale guilt." We can calculate a "Relevance Half-Life" based on the item type.

---

## 3. Proposed Transparent Scoring Model (SQLite/Python)

This is a linear combination model. It is interpretable (satisfying the "Why this?" constraint) and computationally cheap.

**The Formula:**
$$Score = (W_{rec} \cdot S_{rec}) + (W_{aff} \cdot S_{aff}) + (W_{int} \cdot S_{int}) - (W_{sta} \cdot S_{sta})$$

### Signal Definitions & Weights

1.  **Signal: Recency Decay ($S_{rec}$)**
    *   *Logic:* New saves get a boost, but it fades.
    *   *Calc:* $e^{-(\ln 2 / 30) \cdot \text{days\_old}}$ (Half-life of 30 days).
    *   *Weight ($W_{rec}$):* **0.25**
    *   *Reason String:* "Saved recently (within X days)."

2.  **Signal: Source Affinity ($S_{aff}$)**
    *   *Logic:* How much do you usually like this domain/subreddit?
    *   *Calc:* Wilson Score Lower Bound of "Keep" rate for this `source_id`.
    *   *Weight ($W_{aff}$):* **0.45** (Highest weight, personal relevance is key).
    *   *Reason String:* "You usually enjoy content from [Source/Subreddit]."

3.  **Signal: Intent Match ($S_{int}$)**
    *   *Logic:* Does this match the user's current mode (e.g., "Deep Work" vs "Casual")?
    *   *Calc:* Binary match (1 or 0) based on item tags vs. current user mode.
    *   *Weight ($W_{int}$):* **0.20**
    *   *Reason String:* "Matches your current 'Learning' mode."

4.  **Signal: Staleness Penalty ($S_{sta}$)**
    *   *Logic:* Old items shouldn't be forgotten, but they shouldn't dominate.
    *   *Calc:* $\ln(\text{days\_since\_save} + 1)$.
    *   *Weight ($W_{sta}$):* **0.10**
    *   *Reason String:* "This is an older save (X months ago)."

**Total Score:** Sum of weighted signals.
**Transparency UI:** Display the top 2 contributing signals as the "Why this?" explanation.

---

## 4. Logging Requirements for Offline Tuning

To retune weights ($W_{rec}, W_{aff}, \dots$) offline using Logistic Regression or Gradient Descent, we must log the "State" and the "Action."

**Log Schema (SQLite Table: `interaction_log`):**

1.  `item_id`: The content.
2.  `surface`: Where it appeared (e.g., "Main Queue", "Search").
3.  `rank_position`: (Always 1 in strict mode, but useful for debugging).
4.  `score_snapshot`: The raw score calculated in Step 3 (crucial for reproducing results).
5.  `signal_values_json`: A JSON blob storing the 4 signal values at the moment of surfacing.
    *   *Why:* Allows you to change the weights later and replay history to see if the new weights would have performed better.
6.  `action`: `SKIP_IMMEDIATE`, `KEEP_LATER`, `ARCHIVE`, `OPENED`.
7.  `dwell_time_ms`: If opened, how long was it open? (Implicit signal of depth).
8.  `timestamp`: When the decision happened.

---

## Do-First Shortlist

1.  **Implement Wilson Score for Source Affinity:**
    Calculate the "Keep" rate per subreddit/domain using the lower bound of the Wilson score interval. This prevents high-volume, low-quality sources from flooding the queue due to one or two lucky hits.

2.  **Build the "Reason" Generator:**
    Before writing the ranking query, write the function that translates the top-weighted signal into human-readable text. If you cannot explain why an item is shown, remove the signal.

3.  **Log `signal_values_json`:**
    Do not just log the final score. Log the inputs. This allows you to simulate changing the "Recency" weight from 0.25 to 0.50 next month without re-processing 90k items.

---

## Traps (Constraint Violations)

1.  **The "Sunk Cost" Nudge:**
    *   *Violation:* Showing "You have 450 unread items" or "Clear the backlog!"
    *   *Why:* Induces anxiety/guilt (violates "No guilt copy").
    *   *Fix:* Always display "1 of 1" or simply the item. Hide total counts.

2.  **Variable Reward Scheduling:**
    *   *Violation:* Inserting a "High Value" item randomly to keep the user "hooked" (Intermittent Reinforcement).
    *   *Why:* This is the definition of a dark pattern for ADHD brains.
    *   *Fix:* Strictly deterministic ranking based on the transparent score. Predictability reduces anxiety.

3.  **Auto-Advance:**
    *   *Violation:* Automatically loading the next item after the user archives one.
    *   *Why:* Removes the "Breakpoint" (Constraint 4). It creates a slide, not steps.
    *   *Fix:* Require a deliberate click/tap to load the next item.