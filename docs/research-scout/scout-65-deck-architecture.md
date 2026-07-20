# scout-65-deck-architecture — scout research memo

> UNVERIFIED scout output (hy3, 2026-07-20). Claims need source-checking before load-bearing use.

**MEMO**

**TO:** Solo Dev / Architect
**FROM:** Research Scout
**DATE:** 2023-10-27
**SUBJECT:** Architecture for "Engagement Deck" Extraction (ADHD-Compliant Constraints)

### Recommendation

**Primary Recommendation:** Option (C) — **Shared Contract + CSS Tokens, Independent Implementations.**

**Confidence:** High (85%)

**Rationale:** For a solo developer with ADHD, "Re-entry Cost" is the primary metric of failure.
*   **Option (A)** (Shared JS Library) creates a "dependency tax." When you return to App A after months of working on App B, updating the shared library to fix a bug in A often breaks B. The cognitive load of maintaining backward compatibility for a shared UI component across two different apps is high.
*   **Option (B)** (Standalone App) introduces deployment friction (managing two servers/ports) and authentication complexity.
*   **Option (C)** (Shared Contract) allows you to rewrite the UI completely if your JS skills improve or if the "ADHD design language" evolves, without breaking the backend logic. It respects the "One card at a time" constraint by enforcing it at the data layer (the API only sends one card), not the component layer.

---

### Evidence & Analysis

#### 1. Architecture Comparison

| Feature | (A) Shared JS Library | (B) Standalone Deck App | (C) Shared Contract + Tokens |
| :--- | :--- | :--- | :--- |
| **Re-entry Cost** | **High.** You must remember how the library works, how to build it (even if vanilla, linking matters), and ensure changes don't regress the other app. | **Medium.** Context switching between two codebases/ports. Auth passing between them is a pain. | **Low.** The contract (JSON) is documentation. The UI code is local to the app. If you change the UI, you don't fear breaking the other app. |
| **DRY Compliance** | High (Code level) | High (Feature level) | Low (UI Code is duplicated) |
| **ADHD Fit** | **Poor.** "Shared code" becomes a mental block. You avoid fixing App A because you don't want to test App B. | **Medium.** Separation is nice, but integration overhead (iframes? popups?) adds friction. | **Excellent.** Permissionless. You can burn down the UI implementation in App B and rewrite it without touching App A. |
| **Constraint Check** | Risk of "Dark Pattern" leakage if logic is embedded in shared JS. | Hard to keep "Why this?" logic consistent across two backends. | **Best.** The "Why this?" logic lives in the Python backend (single source of truth). |

**Winner:** (C). The "Second App" (PKMS) should request `/api/deck?limit=1`. The server decides *what* based on the algorithm; the client decides *how* to render the card.

#### 2. The Card JSON Contract (App-Agnostic)

To satisfy the "Why this?" and "Processing Cost" constraints, the JSON must be declarative, not imperative. The client renders the card, but the server provides the *reasoning context*.

**Required Fields:**

*   **`id`**: `string` (UUID)
*   **`type`**: `string` (e.g., `"bookmark"`, `"note"`, `"task"`)
*   **`content`**: `object`
    *   `title`: `string`
    *   `body_excerpt`: `string` (plain text, no HTML)
    *   `source_url`: `string` (optional)
*   **`provenance`**: `object` (Crucial for "No Dark Patterns")
    *   `created_at`: `ISO 8601`
    *   `origin_app`: `string` (e.g., "Hoarding App", "PKMS")
    *   `origin_id`: `string`
*   **`reasoning`**: `object` (The "Why this?" block)
    *   `rule`: `string` (e.g., "Unprocessed for 30 days", "Matches current 'Work' context", "Random legacy item")
    *   `weight`: `float` (0.0 to 1.0, representing processing cost/importance)
*   **`actions`**: `array` (Action as proposals)
    *   *Constraint:* Do not send "Delete" as a primary action if it triggers anxiety. Send "Archive" or "Process".
    *   `verb`: `string` (e.g., "archive", "move_to_project", "defer_7_days")
    *   `label`: `string` (Display text)
    *   `method`: `string` ("POST", "DELETE")
    *   `endpoint`: `string` (App-specific relative URL)

**Example Payload:**
```json
{
  "id": "uuid-123",
  "type": "bookmark",
  "content": {
    "title": "Understanding Neurodivergence",
    "body_excerpt": "A guide to..."
  },
  "provenance": {
    "origin_app": "Content Hoarder",
    "created_at": "2023-01-15T10:00:00Z"
  },
  "reasoning": {
    "rule": "Unread for > 90 days. Review before archival.",
    "weight": 0.2
  },
  "actions": [
    {"verb": "archive", "label": "Archive (I've read this)", "endpoint": "/api/items/123/archive"},
    {"verb": "defer", "label": "Remind me in 1 week", "endpoint": "/api/items/123/snooze"}
  ]
}
```

#### 3. Prior Art (Vanilla JS Swipe Decks)

Since we cannot use tools to search, I am relying on established knowledge of the ecosystem up to my last training data.

1.  **Jellyswipe (or generic "Swipe Card" vanilla implementations)**
    *   *Description:* A lightweight, framework-agnostic approach to implementing swipe cards using raw touch events and CSS transforms.
    *   *Physics:* Usually implements basic friction and snap-back using `requestAnimationFrame`.
    *   *License:* Typically MIT (common for vanilla implementations shared on GitHub/Gists).
    *   *ADHD Note:* Often requires manual implementation of the "stack" logic (managing the next card in the DOM).

2.  **Zuck.js / Snapchat-style stories (Concept)**
    *   *Description:* While usually for stories, the "tap to advance" or "swipe horizontal" logic is pure vanilla JS and highly performant.
    *   *License:* MIT.
    *   *Relevance:* Good reference for "One item at a time" horizontal navigation without the "deck" visual metaphor if that becomes overwhelming.

3.  **Interact.js (Library)**
    *   *Description:* A standalone library for drag/drop, resize, and gestures.
    *   *License:* MIT.
    *   *Usage:* You would use this to handle the `drag` event on the card, calculate velocity, and trigger the "swipe off screen" animation. It handles multi-touch and inertia well.

#### 4. Failure Modes of Premature Extraction

*   **The "Second Implementation" Trap (Premature Abstraction):**
    *   *Scenario:* You extract the "Deck Logic" into a shared Python module too early.
    *   *Failure:* App A (Hoarding) uses SQL Alchemy. App B (PKMS) uses raw SQL or a different ORM. The "Shared Logic" now needs adapters. You spend 3 days writing adapters instead of shipping the UI.
    *   *ADHD Impact:* High. This feels like "real work" but yields no visible progress, leading to abandonment.

*   **The "False Consensus" Trap:**
    *   *Scenario:* Assuming a "Bookmark" card and a "PKMS Note" card render the same way.
    *   *Failure:* You build a generic `<div class="card">`. Later, you realize PKMS notes need a "Graph View" button that bookmarks don't have. You either clutter the generic card or break the abstraction.
    *   *Mitigation:* Option (C) allows App B to have a *slightly* different card HTML structure while consuming the same JSON keys.

---

### Do-First Shortlist

1.  **Define the JSON Contract (Server-Side):**
    Implement the `/api/deck` endpoint in **App A (Hoarding)** first. Hardcode the `reasoning` block. Ensure the server strictly enforces the "One card at a time" rule (pagination limit 1). Do not write any shared JS yet.

2.  **Build the "Burnable" UI in App A:**
    Write the vanilla JS swipe logic *directly* in App A's templates. Use `Interact.js` or raw `TouchEvents`. Make it ugly. Make it work. This is your prototype. If the "Why this?" logic is wrong, you haven't wasted time on architecture.

3.  **CSS Variable Extraction (Only):**
    Before touching App B, move your colors, spacing, and fonts into a `:root {}` CSS file. Share *this file* between apps. This gives visual consistency with zero JS coupling.