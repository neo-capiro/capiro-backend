# Strategy Planner eval harness (Phase 2 Stage B)

Two layers, deliberately different cadences — see `agentic_meri_phase2_plan.md` §3 Stage B.

## L1 — deterministic, CI-gated

`eval/run-l1.ts` (+ `eval/run-l1.spec.ts`) runs `verifyPlan` (`@capiro/strategy-verifier`)
and shape assertions against every golden's own `plan.nodes` — no network call, no LLM,
no DB. It is a normal jest spec (`eval/**/*.spec.ts` is in `jest.config.cjs`'s
`testMatch`), so it already runs on every PR via the existing `pnpm --filter
@capiro/api-strategy test` CI step — **no separate CI wiring was needed**. A broken
golden or a `verifyPlan`/shape regression fails the build like any other spec.

Run locally: `pnpm --filter @capiro/api-strategy run eval:l1`
(or `pnpm --filter @capiro/api-strategy exec tsx eval/run-l1.ts` for a plain
human-readable report outside jest).

## L2 — live LLM judge, manual/scheduled — NEVER runs in CI

`eval/run-l2.ts` generates a real draft-from-goal call per golden (against a real
orchestrator + a real client in the dogfood tenant, using the golden's own
`clientContextFixture` as the fiscal/reference grounding override) and scores it with
a live Claude judge call (realism / grounding / actionability / calendar-fit, 1-5 +
rationale). It costs real inference spend and needs live infrastructure, so it is
**opt-in only** — see the required env vars in the file's header comment. It fails
closed (no network call at all) if any of `MERIV2_ORCHESTRATOR_URL`,
`EVAL_BEARER_TOKEN`, `EVAL_CLIENT_ID`, `ANTHROPIC_API_KEY` are unset.

Run: `pnpm --filter @capiro/api-strategy run eval:l2`

Output: `eval/reports/<YYYY-MM-DD>.json` (full data) + `.md` (scorecard table +
rationales). Every 5th golden (~20%) is flagged `needsHumanReview: true` — per the
plan, expert–judge agreement on knowledge-heavy tasks runs ~64–68%, so a sample of
scored plans needs a person (Neo) to actually read them and confirm the judge agrees
with a human. Track judge-vs-human deltas across runs before trusting the judge signal
at face value.

## When an L2 run is mandatory (not just weekly)

Run `eval:l2` — not skippable, regardless of when the last scheduled run was — on any
change to:
- `apps/meriv2-orchestrator/src/meri/strategy/strategy-prompt.ts` (prompts, tool schemas, sanitizers)
- `packages/strategy-verifier/src/verify.ts` (the check set)
- `apps/meriv2-orchestrator/src/meri/strategy/strategy-context-pack.service.ts` (pack composition)
- the strategy default model (`meri-registry.service.ts`'s model config)

Weekly cadence during dogfood is the floor for everything else.

## Activation gate

Per the plan: Stage F (Watcher auto-apply) and Stage G (Execution Agent) do not
activate until an L2 scorecard exists and L1 is at 100% pass with an L2 median Neo
has reviewed and accepted a threshold for. Any future in-production
`PlanQualityScore` is **advisory-only** — surfaced and trended, never write-gating —
until judge–expert agreement on the Neo sample is actually measured. Deterministic
verifier violations remain the only thing that gates a write.

## Steward fixtures (Stage E)

`eval/steward/` holds seven markdown context documents covering the plan's five
Phase-3 Steward scenarios: a **conflicting-asks pair** (two docs for the same
client/strategy whose asks contradict on amount and timing), a **stale-dates**
doc (valid frontmatter, `valid_until` already in the past), an
**uncertain-positions** doc (hedged stakeholder rows — Unknown stance, Low
confidence), a **hard-vs-soft-deadlines** doc (Hard and Soft calendar rows as
separately citable anchors), and an **authority-levels pair**
(`client_approved` vs `working_draft` asserting different figures for the same
limit).

`eval/steward/steward-fixtures.spec.ts` is the deterministic self-test (no LLM,
no network/DB — runs in CI via the normal jest `testMatch` like L1): every
fixture passes the REAL Stage D `parseFrontmatter` + `validateFrontmatter` with
zero errors (real calendar dates, no template placeholders), `locateAll`
surfaces the expected sections/rows, and each scenario's load-bearing rows
(the contradiction, the hedge, the Hard/Soft split, the disagreeing figures)
resolve via their closed-set `row:<heading>:<n>` refs — the exact anchors a
live Steward extraction cites into `sp_context_fact.sourceRef`.

Scoring an actual LIVE extraction over these fixtures (did the Steward produce
the right facts, flag the conflict, mark the stale doc?) folds into the L2
harness — manual, live-infra, opt-in, same as the draft-quality judge. Stage H
wires the cadence.

## Golden provenance

The current 12 goldens under `eval/goldens/` are synthetic (structurally valid,
internally consistent, verified against the real `verifyPlan`) but have **not** been
reviewed against real dogfood output or received Neo sign-off — that review is a
manual step, not something this harness can do. Treat L1 passing as "internally
consistent," not "expert-approved," until that review happens. Scorecard trends
(including this first review) belong in the Obsidian vault per the plan's DoD — not
tracked here in-repo beyond the dated JSON/markdown reports.
