# Decision memo — multi-value + boolean semantics for content-hoarder search operators

Date: 2026-06-12 (overnight research run, unattended)
Scope: Epic 12 — `source:reddit AND source:youtube` does nothing useful today (an item has ONE source; bare `AND` is free text).
Grounding: `K:\Projects\ch-score\src\content_hoarder\search_query.py` (read-only worktree, main branch) read in full this session.
Quote discipline: every verbatim quote below was fetched this session and re-verified against the raw downloaded HTML of the cited page. Anything not in quotes is paraphrase. One claim is explicitly marked as community-observed (not in official docs).

---

## TL;DR

1. No mass-market search bar gives users a general boolean grammar by default: Gmail offers only flat `OR`/`{}`; Discord and Slack offer filters with implicit AND and no boolean keywords at all; grammar (AND/OR/NOT + parens) appears only in developer surfaces (GitHub code search, GitHub's new issues filter) that pair it with heavy autocomplete UI.
2. The industry pattern that fits content-hoarder is cardinality-aware repetition: repeating a single-valued filter means OR (Discord `from:`), repeating a multi-valued filter means AND with comma=OR for the OR case (GitHub `label:bug,resolved` vs `label:bug label:resolved`) — and content-hoarder's `tag:` already implements the GitHub-label half exactly.
3. Recommendation: Model B — comma/pipe multi-value (`source:reddit,youtube`) on all enumerable keys plus same-key-repeat=OR for single-valued keys; keep `tag:` semantics as-is; explicitly do NOT build a boolean grammar (Model C) — it structurally conflicts with the parser's degrade-to-free-text philosophy.

---

## Per-platform semantics

| Platform / surface | Multi-value same key | Different keys combine as | Boolean keywords | Grouping | Negation |
|---|---|---|---|---|---|
| Gmail | No comma syntax; use `OR` or `{ }` between repeated operators | Implicit AND (not formally stated); explicit `AND` exists | `OR`, `AND` (flat) | `( )` groups terms after an operator (`subject:(dinner movie)`); `{ }` = OR-group | `-` excludes |
| Discord (official doc, current) | Not documented (see note: repeat=OR is community-observed UI behavior) | Filters combine to narrow = implicit AND | None documented | None documented | None documented |
| GitHub issues/PR search (classic qualifiers) | `label:bug,resolved` = OR; `label:bug label:resolved` = AND | Implicit AND (shown by example, not formally stated) | None in this surface | None in this surface | `-qualifier` (e.g. `-author:octocat`) |
| GitHub issues page — new advanced filters | via `OR` between qualifiers | Space = `AND` (explicitly stated) | `AND`, `OR` | Parens, nesting up to 5 levels | (inherits qualifier `-`) |
| GitHub code search (new) | Repeat same qualifier with explicit `OR` | Whitespace = implicit `AND` (explicitly stated) | `AND`, `OR`, `NOT` | Parens, full expressions | `NOT` |
| Slack | Not documented | Implicit AND ("combine multiple modifiers") | None documented | None documented | Dash: `-in:`, `-from:`, `-word` |

### Gmail
Source: https://support.google.com/mail/answer/7190 (official "Search in Gmail" operators page; raw HTML downloaded and quotes verified).
Gmail's table lists `OR` and `{ }` together with the description "Find emails that match one or more of your search criteria" — examples `from:amy OR from:david` and `{from:amy from:david}` (both verbatim from the page). `AND` is listed separately: "Find emails that match all of your search criteria", example `from:amy AND to:david` (verbatim). Parentheses "Group multiple search terms together" (verbatim), example `subject:(dinner movie)` — note this is term grouping after an operator, not boolean-expression grouping; Gmail has no documented operator-precedence grammar with nesting. Negation is the minus sign (paraphrase; the doc warns excluded conversations can still appear if another message in the thread matches — paraphrase). There is no comma multi-value syntax anywhere in the doc: the only way to OR two values of the same operator is to repeat the operator with `OR` or wrap the repeats in `{ }`. The doc never formally states what plain adjacency means (implicit AND is the observed/assumed behavior, not documented).

Takeaway for us: Gmail solves "same key, two values" by repetition + an OR connective, not by multi-value values. `{ }` is widely considered obscure; nothing else in the market copied it.

### Discord
Source: https://support.discord.com/hc/en-us/articles/115000468588-How-to-Use-Search-on-Discord (official article; WebFetch was 403-blocked, so the page was downloaded via curl with a browser UA and the body text extracted — quotes verified against that HTML).
The current article documents filters `from:`, `in:`, `mentions:`, `has:` as "shortcuts to quickly filter results" (verbatim) plus mobile-listed date filters (sent on / before / after a date) and author type. On combining, it says only that More Filters "combines multiple search criteria for precise results" (verbatim) and to "combine multiple search options or add criteria like date ranges and author type (user, bot, or webhook)" (verbatim) — i.e., combining different filters narrows results: implicit AND. The article documents no AND/OR keywords, no parentheses, no negation syntax, and — notably — nothing about using the same filter twice.
Caveat flagged honestly: the premise that Discord treats a repeated filter (e.g. two `from:` users) as OR is real, commonly-observed client behavior (the search popout accumulates multiple values per facet and matches any of them), but it is NOT stated in the current official article, and a web search found no official statement of it. Treat it as community-observed, not doc-backed.

Takeaway for us: the most chat-native comparator ships zero grammar. Facets AND together; multi-value-within-a-facet is handled by the UI (and, observed, ORs). Their doc doesn't even need to explain boolean logic — that's the simplicity bar.

### GitHub — issues/PR search (classic qualifiers)
Source: https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests (official; raw HTML verified).
This is the closest analog to content-hoarder's current design: `key:value` qualifiers, implicit AND between different qualifiers (shown by example throughout, never formally stated). The label qualifier is the canonical multi-value design, verbatim from the doc's table: "label:bug,resolved" "matches issues with the label \"bug\" or the label \"resolved.\"" while "label:bug label:resolved" "matches issues with the labels \"bug\" and \"resolved.\"" — comma = OR, repetition = AND. Negation: "minus (hyphen) symbol to exclude results that match a qualifier. For example, to ignore issues created by the \"octocat\" user, you'd use -author:octocat" (verbatim). No AND/OR keywords or parens in this surface; the doc points elsewhere, verbatim: "You can build advanced filters using boolean and nested queries on your repository's issues page and the issues dashboard."

Takeaway for us: GitHub labels are multi-valued per item (like our tags) and got repetition=AND + comma=OR — which is exactly what `search_query.py` already implements for `tag:`. Single-valued qualifiers (e.g. `author:`) have no documented repetition semantics in this surface.

### GitHub — new issues advanced filtering and code search (the grammar surfaces)
Sources: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests and https://docs.github.com/en/search-github/github-code-search/understanding-github-code-search-syntax (both official; raw HTML verified).
Issues advanced filters: "You can use AND and OR operators to refine your filters" (verbatim); without them "GitHub will treat a space between statements as an AND" operator (verbatim fragment); parens allow "parentheses up to five levels deep" (verbatim fragment), e.g. fetched example `(type:"Bug" AND assignee:octocat) OR (type:"Feature" AND assignee:hubot)` (as reported by fetch — paraphrase-level confidence). Crucially this grammar lives on a dedicated surface (repo issues page / dashboard) with an autocomplete filter builder, not in plain global search.
Code search: "Code search supports boolean expressions. You can use the operators AND, OR, and NOT to combine search terms." (verbatim) and "By default, adjacent terms separated by whitespace are equivalent to using the AND" operator (verbatim fragment). Full expression example, verbatim: `(language:ruby OR language:python) AND NOT path:"/tests/"`. No comma multi-value and no `-` negation are documented in code search — OR between repeated qualifiers is the multi-value mechanism.

Takeaway for us: where GitHub does offer a grammar, it (a) targets developers, (b) states implicit-AND explicitly, and (c) backs it with UI assistance and server-side error reporting — luxuries a degrade-to-FTS local search bar doesn't have.

### Slack (bonus comparator)
Source: https://slack.com/help/articles/202528808-Search-in-Slack (official; raw HTML verified).
Modifiers `from:`, `in:`, `to:`, `with:`, `has:`, `is:`, `before:/after:/on:/during:`. Combining, verbatim: you can "combine multiple modifiers to find information more quickly" — example given is `marketing report in:#team-marketing from:@Sara`, i.e. implicit AND. Negation, verbatim: "Add a dash in front of a specific word to omit results that contain it"; a dash also works on `in:`/`from:` modifiers (paraphrase). Nothing on repeating the same modifier, no AND/OR keywords, no parentheses.

Takeaway for us: second confirmation of the Discord shape — filters + implicit AND + dash negation, no grammar.

---

## Current parser baseline (what "complexity" is measured against)

`search_query.py` today: single pass over whitespace/quote-aware tokens; one regex (`^-?\w+:.+$`) classifies operator tokens; per-key if-chain fills a flat frozen `ParsedQuery` dataclass. Single-valued keys (`source/kind/status/subreddit`, `has`) are scalars with silent last-wins on repetition. `tag:` already does comma/pipe=OR within a token and repetition=AND across tokens, collapsed to a v1 `tags + tags_all` shape (mixed AND+OR degrades to global OR, documented in-code). House philosophy, stated in the `parse()` docstring: unknown operators and malformed known operators degrade to free-text tokens — never dropped, never an error. Negated operators (`-source:x`) already deliberately degrade to free text.

---

## Candidate models

### Model A — multi-value values only (`source:reddit,youtube`)
Extend comma/pipe OR-lists from `tag:` to the other enumerable keys (`source:`, `kind:`, `status:`, `has:`, optionally `subreddit:`). Different keys stay implicit-AND. Repetition of a single-valued key stays last-wins. Bare `AND`/`OR` stay free text.

- New queries: `source:reddit,youtube`, `has:video|gallery`, `status:new,seen tag:ai before:2026-01-01`. Epic 12 is solved iff the user learns the comma spelling.
- Parser complexity: trivial — reuse the exact `re.split(r"[,|]", val)` idiom `tag:` already uses; `ParsedQuery` scalar fields become `list[str]`; SQL layer swaps `= ?` for `IN (...)`. No tokenizer or grammar change; the parse loop shape is untouched.
- Degrade behavior: identical to today. A value that splits to nothing degrades the whole token to free text (as `tag:` does); `has:` keeps validating members against `{video,image,gallery}` and degrades on unknown members, matching its current behavior. Zero new failure modes.
- Gap: `source:reddit source:youtube` (the way people naturally retype) still silently last-wins — the Epic 12 query typed naively still half-works at best.
- Precedent: GitHub `label:a,b` (comma=OR) — https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests.

### Model B — cardinality-aware repetition + comma (Discord/GitHub hybrid; supersets A)
Everything in A, plus: repeating a single-valued key merges to an OR-list (`source:reddit source:youtube` ≡ `source:reddit,youtube`). `tag:` keeps its existing repetition=AND + comma=OR (the GitHub-label semantics). Different keys remain implicit-AND. Bare `AND`/`OR` remain free text (optionally: drop a bare `AND` token only when sandwiched between two operator tokens — a peephole, not a grammar; icebox it).

- New queries: both natural spellings of Epic 12 work (`source:reddit,youtube` and `source:reddit source:youtube`); same for `kind:`, `status:`, `has:`. The rule users learn: "repeat = OR when an item has exactly one of the field; repeat = AND when an item can have many (tags)" — and that asymmetry is exactly what Discord (`from:`, observed) and GitHub (`label:`, documented) shipped, because repeat=AND on a single-valued field is provably-empty and useless.
- Parser complexity: small — the per-key scalars become accumulating lists inside the existing loop (the `tags_groups` pattern already in the file, then merged after the loop). Single pass, one regex, flat dataclass all preserved. Roughly the same diff size as A plus one merge step; the bulk of the work is tests and the spec-doc update.
- Degrade behavior: unchanged philosophy, and repetition cannot be malformed — there is literally no new parse-failure surface. Unknown keys/values degrade to free text exactly as today.
- Gap: still no cross-key OR (`source:youtube OR tag:video-essay` is impossible), no operator negation, no grouping.
- Precedent: Discord repeated-facet OR (community-observed; official doc documents only filters + combining-to-narrow — https://support.discord.com/hc/en-us/articles/115000468588-How-to-Use-Search-on-Discord); GitHub label comma/repeat duality — https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests.

### Model C — full boolean grammar (AND/OR/NOT + parentheses)
GitHub-code-search-style expressions over operator and text terms, implicit AND for whitespace.

- New queries: cross-key OR and arbitrary nesting — `(source:reddit AND tag:ai) OR (source:youtube AND has:video)`, `NOT (tag:meme OR is:nsfw)`.
- Parser complexity: an order-of-magnitude jump, not an increment. The tokenizer must additionally classify parens and keywords; a recursive-descent (or shunting-yard) parser must build an expression tree; the flat frozen `ParsedQuery` can no longer represent results, so every consumer — the SQL WHERE builder and anything reading `.source`/`.tags` — must become a tree walker or the tree must compile straight to SQL. Precedence/associativity need a spec. The FTS leftover-text contract ("everything unclaimed flows to FTS as one string") becomes ambiguous inside groups: what does free text inside one branch of an OR mean for FTS ranking? This is a rewrite of `search_query.py` and its consumer, not an extension.
- Degrade behavior: the structural conflict. The house rule is "malformed input degrades to free text, never errors." A grammar's malformed states (unclosed paren, dangling `AND`, `a OR`) are constant while typing — degrading the whole query to free text on each such keystroke makes results flip wholesale between grammar-mode and FTS-mode mid-typing. The platforms that ship grammars (GitHub code search, GitHub issues advanced filters) instead surface errors/autocomplete on a dedicated server-backed UI — Gmail keeps its grammar flat (no nesting) likely for the same reason. To ship C honestly you'd need partial-parse recovery or an error UI, both of which abandon the degrade philosophy.
- Precedent: https://docs.github.com/en/search-github/github-code-search/understanding-github-code-search-syntax (verbatim above) and https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests (5-level paren nesting).

---

## Recommendation

Ship Model B (which includes A's comma syntax). Do not build Model C.

Rationale:
1. Convergent industry evidence: four products, zero general-purpose boolean grammars in their default search bars. Discord and Slack ship filters + implicit AND only; Gmail adds one flat OR connective; GitHub reserves real grammar for developer surfaces wrapped in autocomplete UI. content-hoarder's search bar is the Discord/Slack/GitHub-issues archetype, not the code-search archetype.
2. The cardinality rule is the actual industry answer to Epic 12: an item has ONE source, so repetition must mean OR (Discord `from:`); items have MANY tags, so repetition means AND with comma for OR (GitHub `label:` — and `tag:` in `search_query.py` already matches GitHub exactly, so B completes a pattern the codebase already chose).
3. Epic 12's real need is per-key OR over single-valued facets. Nothing in the backlog needs cross-key OR; C's entire extra power is speculative, and its cost lands on the two things the codebase most prizes — the flat `ParsedQuery` contract and degrade-to-free-text.
4. B has zero new malformed-input states, so the degrade philosophy survives untouched; C structurally fights it.
5. B is forward-compatible: list-valued per-key filters are precisely the leaf nodes a future expression tree would need, so nothing shipped in B is wasted if cross-key OR ever earns its way onto the backlog.

Explicitly out of scope for v1 (document in the spec): bare `AND`/`OR` remain free text (note it in docs/search-operators-spec.md so the Epic 12 query's literal-AND spelling is a documented non-feature); Gmail-style `{ }` (no one else adopted it); operator negation `-source:x` (already deliberately degraded today — separate decision).

## Decision block (ADHD-shaped)

THE ONE QUESTION: "Will I ever actually type a cross-key OR — e.g. `source:youtube OR tag:video-essay` — in this app? If no: Model B is the decision. If yes: pause Epic 12 and spec Model C's error-UI first (do not ship C without one)."

- ⏱ 15 min total.
- ▶ First action (~10 min): write down the last 5 multi-criteria searches you genuinely wanted in content-hoarder (from memory or saved searches), and check each one against the Model B row above — if all 5 are expressible, circle B on the Epic 12 ticket.
- ✓ Done-when: the Epic 12 ticket names the chosen model, pastes the per-key semantics line ("source/kind/status/has: comma=OR, repeat=OR; tag: comma=OR, repeat=AND; different keys AND"), and records "bare AND/OR remain free text" as a documented non-feature.

Icebox (pause, don't delete — reactivation condition in parentheses):
- Sandwiched-`AND` peephole drop (reactivate if the literal Epic-12 spelling keeps getting typed after B ships).
- Operator negation `-source:x` (reactivate when a concrete exclusion query is written down).
- Model C cross-key OR (reactivate only when a real wanted-query that B cannot express is recorded on the ticket).

---

## Sources (all fetched 2026-06-12; quotes verified against raw downloaded HTML)

1. Gmail — Search in Gmail (operators): https://support.google.com/mail/answer/7190
2. Discord — How to Use Search on Discord: https://support.discord.com/hc/en-us/articles/115000468588-How-to-Use-Search-on-Discord
3. GitHub — Searching issues and pull requests: https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests
4. GitHub — Filtering and searching issues and PRs (advanced filters): https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests
5. GitHub — Understanding GitHub Code Search syntax: https://docs.github.com/en/search-github/github-code-search/understanding-github-code-search-syntax
6. Slack — Search in Slack: https://slack.com/help/articles/202528808-Search-in-Slack
