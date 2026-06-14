# Reddit thread hydration backfill — feasibility (2026-06-12)

> **STATUS 2026-06-13 — IMPLEMENTED.** This was the planning doc; the feature now exists.
> `reddit-hydrate --from <bdfr-dir>` (offline local-archive, lossless synthesized comment
> permalinks, skip-already-hydrated) + `reddit-hydrate --batch` (cookie, rate-limited, resumable,
> `--dry-run`) shipped (Epic 24). The "nothing hydrates today / Recover is a stub" statements below
> are the pre-build state, kept for the reasoning — no longer current.

Prompted by PKMS: `pkms promote` (PKMS build-plan slice 2) renders saved threads from
this DB into vault reading notes, but can only offer **hydrated** threads —
`reddit_threads` holds **672** rows against **55,444** saved posts. Assessed read-only;
no fetches were run.

## 1. What writes `reddit_threads` today

**Nothing live.** The only writer is the one-shot RSM migration
(`rsm_threads.py` → `db.set_reddit_thread`, its sole caller). The `/reddit` thread
viewer is cache-only; its `cached: False` state ("Recover / live fetch") is a UI stub
with no fetcher behind it. The `archival/` package (PullPush + Arctic-Shift) recovers
post *content* onto `items` rows — it does not produce comment trees in
`reddit_threads`. So the 672 threads are exactly what RSM had cached at migration time.

## 2. Viable hydration paths

| Path | Auth | Shape | Verdict |
|---|---|---|---|
| **Cookie fetch of `<permalink>.json`** | `reddit_session` cookie (same one `reddit-sync`/`reddit-unsave` already manage; validated live ~0.5s/req, no login wall — note unauthenticated `.json` is 403-blocked from this machine, so the cookie is what makes this work) | Exactly the `[post, comments]` listing `reddit_threads` already stores and PKMS consumes | **Primary.** Cookie expires every few days → fine for attended batches + on-demand, wrong for unattended cron |
| Archives (PullPush/Arctic-Shift, already integrated) | none | Flat comment lists, different shape; PullPush omits comment permalinks; lossy/laggy | **Fallback only** — for threads deleted from Reddit; needs tree re-assembly + shape conversion |
| OAuth (`feat/reddit-oauth`, parked) | needs the reddit script app (also a pending PKMS-program user action) | native | Unlocks unattended hydration later; not a blocker |

## 3. Scope & cost (queried 2026-06-12)

- 55,444 saved posts · 672 hydrated · only **422** have `raw_json` (recent cookie syncs;
  the legacy bulk import stored none, and stored permalink-as-url, so `url` can't
  distinguish self from link posts).
- Best promote-priority signal: **non-empty `body` (selftext) = 8,495 self/discussion
  posts**, essentially all unhydrated, all `status=inbox`. Top subs: ExperiencedDevs,
  ClaudeCode/ClaudeAI, AskReddit, LifeProTips, ADHD — exactly promote material.
- Cost of the prioritized batch: 8.5k requests at a courteous ~2s spacing ≈ **~5h,
  resumable**; sample thread JSON ≈ 22 KB → roughly **200–400 MB** DB growth. A
  single on-demand hydration is ~1s.
- Hydrating all 55k (memes, galleries, image posts) is NOT recommended: identity/
  entertainment content is rarely promoted (shared design language §5 — identity
  content is never re-presented as work), and it would quadruple the cost for little
  promote value.

## 4. Recommended shape (staged — see BACKLOG Epic 24)

1. **`reddit-hydrate` CLI + endpoint** (P2): hydrate one fullname (wires the Recover
   stub) and `--batch` over the prioritized set (non-empty body, newest-saved first),
   cookie-auth, ledger-resumable, `--limit` cap, **dry-run listing first and an
   explicit approved scope before any mass fetch** (Epic 21 trust mechanics apply).
2. **Archive fallback** (P3): when the cookie fetch 404s (deleted thread), assemble a
   best-effort tree from the archival providers, marked as archive-sourced.
3. PKMS stays read-only on this DB; on-demand hydration is invoked on the hoarder side
   (CLI/endpoint), which PKMS's agent layer can shell out to later.

## Side note (cross-project)

Epic 22's AnkiConnect prototype assumes `localhost:8765` — **PKMS's capture service
now listens on 8765**. Whichever lands second needs a different port; flagged in both
backlogs' shared-port awareness now rather than at debug time.
