# Defense-budget Package 2 — Jev task foundation

Package 2 extends the existing Jev client rather than introducing another model stack. The shipped foundation is deliberately non-authoritative: it can compare, abstain, label, or select a caller-supplied candidate, but it cannot create canonical financial facts or merge program identities.

## Delivered scope

- `jev-task-registry.v4` records every task's owner, versioned question, allowed and abstention outcomes, evidence requirements, candidate generator, pinned model, cache identity, action thresholds, timeout, fallback, rollout ceiling, permitted effect, evaluation set and cost budget.
- Versioned Choice tasks cover ambiguous program identity, legislative mention scope and bounded evidence selection. Evidence selection returns an existing candidate pointer, `none`, or `ambiguous`; it never returns model-authored evidence.
- The task-bound provider validates tenant scope, exact question identity, declared evidence metadata and task thresholds before producing a proposal or abstention. Questions are derived from the supplied envelope and SHA-256-bound to its canonical contents; disconnected or altered evidence is refused before a provider call. Malformed responses and timeouts remain explicit operational failures.
- Evidence envelopes carry authority, provenance, document completeness, relation scope, financial stage, publication/effective/retrieval dates and source locators into task state. Provenance now participates in envelope, cache and recording identity.
- Each new task enforces its deadline, input/output-token ceilings and HTTP-attempt ceiling at runtime. The token estimate is a conservative preflight guard; provider-reported usage is checked again before an outcome can be emitted.
- Cache keys and recordings include task, registry, question and model identity. New task cache policy also includes provenance and candidate identity.
- The offline paired evaluator reports per-task/provider calls, outcomes, abstentions, operational failures, input/output tokens, latency percentiles, price version and budget overruns. It emits `estimatedCostUsd: null` when no approved price schedule exists instead of inventing a rate.
- Existing Score support remains limited to the justified `client_fit` alignment question; Package 2 did not add another Score task.

## Safety and rollout state

The three new tasks are registered `shadow_only`, require human review, and set `canonicalFinancialWrite: false`. The deployed dev allowlist remains `claim_support,passage_relevance`, so merging and deploying this package does not activate a new paid provider route. Current claim-support and passage-selection behavior is preserved.

The acceptance corpus is proposed, synthetic contract evidence—not an independently adjudicated accuracy set. It proves routing, abstention, failure handling, provenance survival and accounting behavior. Production calibration and an approved price schedule remain Package 9 qualification work.

## Evidence

- [Paired replay and task-cost report](./paired-replay-report-2026-09-24.md)
- [Validation evidence](./validation-evidence-2026-09-24.md)
- [Runtime baseline](./runtime-baseline-2026-09-24.json)
- [Release evidence](./release-evidence-2026-09-24.json)
- [Operator runbook](./operator-runbook.md)

## Completed release

Package 2 merged through PR #1770 at `9e4466c676c89ff1ad338f4b4abc100f057e538c`. That exact revision was built as a Linux ARM64 orchestrator image, pushed at digest `sha256:3d744a27653097deb0c7a774ff2cc3141e2a58ec2464c93568f65cb1b41a723f`, and deployed only to `capiro-dev-meriv2-orchestrator` on task definition revision 81. The service reached steady state at desired/running/pending 1/1/0, the running task and container reported healthy, and the public health endpoint returned `ok: true`.

The rollout preserved the existing Jev model, timeout, retry, tenant, surface and mode settings. The live task allowlist remains `claim_support,passage_relevance`, so the new Package 2 tasks are shipped but not activated and no paid Package 2 qualification call was made. Revision 80 remains the tested rollback target.
