# AI suggestions and learning

Clear can suggest Keep or Archive without deciding for you. A quiet line gives a reason and an
**AI** or **From your history** tag. Tap it to accept, or use any other decision.

## How hints work

| Source | How it works |
|---|---|
| AI | With consent, an OpenAI-compatible endpoint suggests a verdict and reason. See [`llm.ts`](../src/assist/llm.ts) and [`hints.ts`](../src/assist/hints.ts). |
| History | `learn-triage` writes `metadata.triage_hint` from past decisions. See [`triage_score.ts`](../src/triage_score.ts). |

AI consent is off by default for each library. A first-open popup offers the choice; the Add page
has a toggle to change it. The privacy page names the configured provider. See
[`consent.ts`](../src/assist/consent.ts) and [`auth.ts`](../src/web/handlers/auth.ts).

The deal waits at most `LLM_DEAL_WAIT_MS` for AI hints. Later hints arrive through
`GET /clear/hints`. `LLM_DAILY_CAP` limits calls per library per day; cumulative usage is in the
library's `ai_usage` setting. Configuration and defaults are in [`src/config.ts`](../src/config.ts):
`LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_DISABLE_THINKING`, `LLM_TIMEOUT_S`,
`LLM_DAILY_CAP`, `LLM_DEAL_WAIT_MS`, `LLM_PROVIDER_LABEL`, `TRIAGE_AUTO_LEARN_EVERY` and
`CONTENT_HOARDER_DEMO_ANALYTICS`.

A hinted decision records `metadata.hint_outcome` with `verdict`, `by`, `decided` and `matched`.
Keep matches Keep or Done; a skip verdict matches Archive, not the Clear Skip action. Undo removes
the outcome. Agreement is available through `db.hintAgreement` and `surface-stats`; see
[`db.ts`](../src/db.ts) and [`cli.ts`](../src/cli.ts).

Every `TRIAGE_AUTO_LEARN_EVERY` decisions, the history model refits off the request path. File
databases use a Bun Worker. Smart deck order uses `triage_score = sqrt(p_processed · p_keep)`.
Today can also offer a learned pile, such as “You let go N of M from r/x”. It is a suggestion:
the sweep is undoable. See [`triage_score.ts`](../src/triage_score.ts) and
[`sweeps.ts`](../src/web/handlers/sweeps.ts).

## Local stats and temporary pilot analytics

`bun run src/cli.ts surface-stats --help` describes local analytics for tuning the non-AI
algorithm: feature rates with Wilson confidence intervals, hint agreement, calibration and AI
usage/cost. Use the CLI help as the source of options.

Demo analytics is **temporary and pilot-only**. `CONTENT_HOARDER_DEMO_ANALYTICS=1` records tester
behaviour in a `demo_events` table in each user's own library database. The privacy page discloses
it. [`demo_analytics.ts`](../src/demo_analytics.ts) and
[`track.js`](../src/static/core/track.js) implement it. On the host, read summaries with:

```sh
bun run src/cli.ts demo-events --dir /srv/khaos-demo/data/users
```

See `demo-events --help` for options. Wiping the users directory deletes the events with the
libraries. Remove this pilot instrumentation after the pilot; the final product will have self-owned
analytics. The removal work is listed in [NEXT.md](../NEXT.md).

## Pilot provider and cost

The demo uses the owner's personal Z.ai GLM Coding Plan key with endpoint
`https://api.z.ai/api/coding/paas/v4` and model `glm-5.3-flash`. The key is in the GNOME keyring
note "content-hoarder ZAI-API-KEY"; do not put its value in docs. Z.ai's
[subscription terms §4](https://docs.z.ai/legal-agreement/subscription-terms), checked 2026-11-02,
forbid using Coding Plan quota from your own apps. the owner accepted this for the demo only. Before
real users, switch to a standard pay-as-you-go key and `https://api.z.ai/api/paas/v4`.

On 2026-11-02, 20 calls on the synthetic demo library with GLM-5.3-Flash and thinking disabled
used 3,348 prompt and 778 completion tokens: about 167 in and 39 out per call, with a median call
of about 1.9 seconds. At Z.ai's [list price](https://docs.z.ai/guides/overview/pricing), checked
2026-11-02 ($0.15/M input, $0.50/M output), this is approximately **$0.045 per 1,000
suggestions**. This is a list-price estimate, not a statement of Coding Plan billing.
