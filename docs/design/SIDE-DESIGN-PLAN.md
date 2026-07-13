# Side plan — design work without blocking product engineering

**Status:** plan only (2026-07-12). Use when you want design progress *in parallel* with
code packets, without mixing design thrash into implementation PRs.

## Goals

1. Keep **implementation branches** small, offline-testable, and mergeable without design debate.
2. Give design work a **parking lot + decision gate** so it doesn’t stall the main track.
3. Prefer **documented decisions** over open-ended “make it nicer” sessions.

## Cadence (ADHD-friendly)

| Slot | Length | Output |
|---|---|---|
| **Design Friday (or one 45‑min block/week)** | 45 min | 1 decision or 1 critique note, not code |
| **Spike hour (optional)** | ≤60 min | Throwaway mock / CSS playground — **never** on `main` |
| **Ship window** | normal | Only implement packets that already have a locked decision |

Rule: **no design exploration on the same branch as a feature ship.**

## Two tracks

```
Track A — Product code          Track B — Design side
(feat/* from main)              (docs/design/*, optional design/* branches)
  ↓                               ↓
tests + CLI + routes            critiques, mockups, token experiments
  ↓                               ↓
PR → main                       decision note → READY-TO-CODE or icebox
```

Track B **never** mutates live DB, never pushes video/unsave, never redesigns without a one-line decision.

## Where artifacts live

| Kind | Path |
|---|---|
| Critiques / research | `docs/design/<topic>.md` or dated `docs/design/<topic>-YYYY-MM-DD.md` |
| Inline reader / mobile nav history | `docs/design/inline-reddit-reader/`, `docs/design/mobile-nav-redesign/` |
| Locked product design system | `.agents/skills/frontend-design/SKILL.md` + `static/core/tokens.css` |
| Implementation-ready after decision | one line in `docs/READY-TO-CODE.md` |
| Not now | `NEXT.md` Icebox + GitHub `type:icebox` / `needs:design` |

## Decision gate (required before code)

Every design idea becomes implementable only when this is filled:

```md
## Decision: <title>
- Date:
- Problem (1 sentence):
- Chosen option: A / B / C
- Rejected options + why:
- Surfaces touched: (files or routes)
- Done-when: (observable, testable)
- Non-goals:
- Size: S / M / L
```

No decision note → stays research/icebox. Agents must not “just ship a nicer UI.”

## Good side-track candidates (current backlog)

| Issue / topic | Why side-track | Gate |
|---|---|---|
| #57 Triage visual rework | Design-heavy | Deck vs list density + visual language |
| #55 One unified surface | Mostly shipped (P3.5); residual polish only | Confirm residual list |
| #28 Thumbnail cropping research | Research | Cropping rule + fixture images |
| #29 Log title wrapping (GLM) | Visual bakeoff | Pick one wrap rule |
| #47 Collapsing top bar | Mobile feel | Real-device after mock |
| #46 Mobile scrollbar | Spec exists (`mobile-scrollbar.md`) | Approve behavior |
| Tokens / motion polish | Low risk if scoped | Token change list only |

## Bad side-track candidates (don’t mix with “design day”)

- Live unsave / archive / OAuth drains  
- Schema migrations  
- OCR/engine accuracy at scale  
- Anything labeled `safety:external-action` or `needs:real-device` until the device session  

## Working loop (copy-paste)

1. Pick **one** `needs:design` or design doc — not three.
2. Timebox 45 min: critique or 2–3 options max.
3. Write the **Decision** block (or explicitly “no decision — park”).
4. If decided: add a single READY-TO-CODE row with size + first step.
5. Implement later on a **fresh** `feat/…` branch from `main`, with tests.
6. PR description links the decision note.

## Agent rules for design sessions

- Lead with the decision, not mockups.
- Prefer editing `docs/design/*` over large CSS rewrites.
- If changing CSS: match existing comment density; bump `sw.js` CACHE + `APP_VERSION` only on ship branches.
- Screenshot / mock assets: keep under `docs/design/…`, never user media from `data/`.
- Stop at the decision gate — don’t “while I’m here” refactor browse.

## First three side sessions (suggested)

1. **#46 mobile scrollbar** — read `docs/specs/mobile-scrollbar.md`, accept/reject, READY-TO-CODE or close.  
2. **#28 thumbnail crop** — 5 sample crops, pick rule, one decision note.  
3. **#57 triage visual** — only if deck mode still feels unfinished after P3.5; else close/defer with reason.

## Done-when for this plan

- [x] Plan written (`docs/design/SIDE-DESIGN-PLAN.md`)
- [ ] Linked from `NEXT.md` / READY-TO-CODE as the design off-ramp
- [ ] At least one decision note produced in a future session
