# Business Development Phase 3 — Jev paired shadow

Date: 2026-09-25

Status: complete and deployed for the authorized Phase 3 paired-shadow scope. The development rollout is limited to `capiro-internal`; visible canary remains mechanically blocked and off because no approved human-labeled evaluation set exists.

## Scope and authority boundary

Phase 3 adds two bounded Jev Choice tasks to the existing Phase 2 evidence dossier:

- **BD-ENTITY** compares one unresolved prospect organization with one deterministic canonical-organization candidate. The result is advisory, always review-required, and can never merge, resolve, or rewrite identity.
- **BD-SIGNAL** compares one resolved company with one specific, staged Phase 2 signal/source record. Jev supplies semantic judgment only. A future direct label additionally requires code proof of the resolved company, permitted official record type, source record, financial stage, and locator.

Phase 2 remains authoritative. Candidate search makes zero Jev calls. Only an explicitly opened company/prospect dossier may schedule one detached call for the relevant task. Off mode performs no Jev tenant-settings read, trace write, or provider call. Shadow mode leaves the dossier response byte-for-byte unchanged and cannot add response latency. Provider failure, timeout, malformed output, missing evidence, and exhausted budget all fall back to the unchanged Phase 2 result.

This phase does not add BD-FIT, BD-TIMING, BD-EVIDENCE, PDL ingestion, automatic outreach, automatic client conversion, or any automatic identity merge. It does add the required **dark-only BD-CLAIM contract and recorded replay** for Phase 4: exact amount, identifier, date, source-locator, and financial-stage checks run before the bounded semantic Choice. There is no application caller, Meri interception, visible effect, or live rollout for BD-CLAIM.

## Shared provider and pinned contract

The implementation reuses `packages/meriv2-core/src/jev`; it does not introduce a second Jev SDK or transport contract.

| Control | Pinned value |
| --- | --- |
| Model | `jev-1.13.0` |
| Registry | `jev-task-registry.v5` |
| BD-ENTITY question | `bd_entity.v1` |
| BD-SIGNAL question | `bd_signal.v1` |
| BD-CLAIM question | `bd_claim.v1` (dark replay only) |
| Primitive | `choice` |
| Calls | at most 1 per task/envelope |
| Input/output budget | 16,000 / 1,000 tokens |
| Cost ceiling | $0.001 per decision |
| Price version | `typesafe-public-2026-09-15-usd-0.042-per-million-input-v1` |
| Registry rollout ceiling | `shadow` |
| Evaluation-set status | `proposed` |

TypeSafe's current public site lists $42 per billion input tokens; outputs are free in the implemented price model. The [TypeSafe master customer agreement](https://typesafe.ai/legal/mca) says customer data is not used to train model weights without prior consent, while allowing processing and telemetry under its terms. That public language is not a Capiro-specific legal or privacy approval, so the packet remains restricted to minimal organization/source facts.

## Bounded inputs and retained trace

The provider packet may contain only the minimum public organization description, bounded canonical identifiers, and a bounded normalized source record. It excludes the prospect description/service hypothesis, firm preferences, notes/activity, conflicts, contacts, people records, client files, unrestricted dossier text, and all PDL payloads.

The additive tenant-private trace retains typed outcomes, probabilities, confidence, operational state, model/question/registry versions, redacted hashes, public source ids, token counts, estimated input cost, latency, and review metadata. It never retains prompts or source passages. The table has forced RLS, a tenant policy, tenant-scoped idempotency, status/mode/usage checks, and a database invariant that forbids a visible effect on a shadow row.

Source revisions, question/model/registry changes, and candidate-projection changes invalidate the idempotency key. Reopening an identical envelope is a no-op, including concurrent insert races.

## Paired shadow and manual feedback

- The deterministic Phase 2 dossier is built first and returned unchanged.
- BD-SIGNAL evaluates the first deterministically ordered staged signal and records the corresponding Phase 2 baseline (`explicit_link`, `conditional_alignment`, `thematic_fit`, or `insufficient_evidence`) alongside the Jev observation.
- BD-ENTITY records the unresolved/manual-review baseline and the exact evaluated-candidate projection hash.
- A committed identity correction updates only the latest matching unreviewed BD-ENTITY trace after the Phase 1 transaction commits. Duplicate/no-op resolutions do not create feedback. Selection and update are separate statements, but the write re-checks `review_status = 'unreviewed'`, so a concurrent review cannot be overwritten.
- No recorded decision is used for model training or global promotion.

## Flags and tenant scope

Managed release defaults keep every control dark:

- `MERI_JEV_PROVIDER_MODE=off`
- `MERI_JEV_PROVIDER_TENANTS=`
- `MERI_JEV_PROVIDER_SURFACES=`
- `MERI_JEV_TASKS=`
- `BIZDEV_JEV_ENABLED=false`
- `BIZDEV_JEV_TASK_BD_ENTITY_MODE=off`
- `BIZDEV_JEV_TASK_BD_SIGNAL_MODE=off`

The development shadow rollout uses the shared provider on the `research` surface and only the internal tenant. Each task additionally requires its tenant flag:

- `businessDevelopment.jev.task.bdEntity.shadow.enabled`
- `businessDevelopment.jev.task.bdSignal.shadow.enabled`
- `businessDevelopment.jev.task.bdEntity.internalCanary.enabled` (kept false)
- `businessDevelopment.jev.task.bdSignal.internalCanary.enabled` (kept false)

Effective mode is the least-permissive result of the global kill switch, per-task environment mode, per-tenant flag, shared-provider tenant/surface/task allowlists, and registry ceiling. Configuration alone cannot arm the canary while the registry is shadow-only and the evaluation set is proposed.

## Evaluation gate and visible-canary blocker

The repository contains a fail-closed offline evaluation schema, evaluator, and CLI. It requires, separately for each task:

- at least 100 genuinely approved, independently human-reviewed cases;
- a held-out cohort partitioned by company, source, and time;
- positive and difficult-negative coverage, with two distinct reviewers and adjudication for difficult negatives;
- pinned model, question, registry, candidate generator, price, thresholds, latency, and cost ceilings;
- complete per-outcome precision/recall thresholds, abstain share, human-review share, confusion matrix, latency, tokens/cost, and required strata;
- zero unreviewed exact-identity merge effects and zero direct signal labels without matching deterministic company/source/type/stage/locator proof.

No approved BD-ENTITY or BD-SIGNAL label set exists in the repository or environment. Therefore no real confusion matrix, precision/recall result, severe-error rate, or human-review share is available, and the visible canary is not authorized. Synthetic fixtures test gate logic only; they are not evidence that Jev is accurate.

BD-CLAIM's synthetic replay likewise validates contract routing, failure handling, and exact-field rejection only. It is not a human-labeled accuracy set and cannot authorize Phase 4 use.

## Optional canary presentation

The web client recognizes only four exact server tokens: `identity_review_required`, `possible_fit`, `direct_fit`, and `not_evaluated`. Unknown or malformed values are treated as absent; raw `jev*` detail fields are never rendered. Missing projection fields reproduce the exact Phase 2 UI. The future identity effect may only reorder the complete unresolved candidate list and show “Jev suggestion — review required.” A future direct signal label is unreachable unless the deterministic server predicate passes.

These presentation paths are tested with mocks only and are not enabled in development or production.

## Verification

- Shared Jev/core suite: 108 suites passed, 1,246 tests passed, 2 todo; core typecheck passed.
- Package 2 replay compatibility remains readable under registry v4 fixtures while new output emits registry v5.
- `report-bizdev-jev-shadow` is a read-only production-image command that emits aggregate task/status/outcome, Phase 2 agreement, review share, p50/p95 latency, tokens, and cost. It does not read subject, source, prospect, person, or firm-configuration fields.
- API verification passed 8 focused suites / 176 tests plus typecheck; the shadow-null hotfix passed 2 focused suites / 73 tests plus typecheck.
- Web verification passed 30 focused tests and the full web typecheck. CDK typecheck, 7 release-control tests, and release-script verification passed.
- The disposable PostgreSQL rehearsal applied the Phase 3 migrations and passed forced-RLS tenant isolation, shadow-invisibility, and database-invariant checks.
- Hermes delegation used `z-ai/glm-5.3` with low reasoning, an 8,192-token response cap, a 40% warning, and a hard stop at 48% context. The observed peak was 7.5592%; the hotfix session peaked at 4.1666% and cost $0.7737846. No Hermes session approached the requested 50% ceiling.
- GitHub Actions did not execute because the repository account reported failed payments or an exceeded spending limit. This is an infrastructure/billing block, not a test failure; merge approval used the independently completed local gates above.

## Release evidence

### Merge and immutable artifacts

- Phase 3 implementation: [PR #1797](https://github.com/neo-capiro/capirov2/pull/1797), merge commit `bf8936001fe326d0d93a8e185be356b46fbfe560`.
- Shadow SQL-null recovery: [PR #1801](https://github.com/neo-capiro/capirov2/pull/1801), GitHub/local `main` merge commit `3bf895a45ee600e9a63e3c0e03f6af2832d7ef87`.
- API image built from the hotfix merge: `sha256:d971e26f72ae292eeb9c0ba2bc4cd428203b0b799d8e60ebdd4a4fb4c73b1b02`.
- Web image: `sha256:de182c3535b2dc21bb56bb7fece187b59031eedb88b4c39fa822fdc8d7e84b51`.

### Direct AWS CLI deployment

- Account/region/cluster: `967807252336` / `us-east-1` / `capiro-dev`.
- Original Phase 3 migration task definition `capiro-dev-api-admin-migrate:69` applied `20280925010000_business_development_phase3_jev` successfully.
- Recovery migration task definition `capiro-dev-api-admin-migrate:70` applied `20280926010000_business_development_phase3_shadow_null_recovery` successfully; the database then reported 430 applied migrations.
- API service task definition `capiro-dev-api:456` is `COMPLETED`, with 2/2 tasks healthy on the exact API digest above.
- Web service task definition `capiro-dev-web:139` is `COMPLETED`, with 1/1 task healthy on the exact web digest above.

### Tenant controls

The only enabled tenant is `capiro-internal` (`17b63099-bc0f-4ac5-b596-496161e9481e`). Final flags are:

- `businessDevelopment.jev.task.bdEntity.shadow.enabled=true`
- `businessDevelopment.jev.task.bdSignal.shadow.enabled=true`
- `businessDevelopment.jev.task.bdEntity.internalCanary.enabled=false`
- `businessDevelopment.jev.task.bdSignal.internalCanary.enabled=false`

The service allowlists only the `research` surface and the `bd_entity,bd_signal` tasks for this tenant. PDL remains disabled/deferred. Registry `jev-task-registry.v5` still caps both tasks at shadow, so tenant flags alone cannot enable visible output.

The deployed task definition sets `MERI_JEV_PROVIDER_MODE=shadow`, `MERI_JEV_PROVIDER_TENANTS=17b63099-bc0f-4ac5-b596-496161e9481e`, `MERI_JEV_PROVIDER_SURFACES=research`, `MERI_JEV_TASKS=bd_entity,bd_signal`, `MERI_JEV_MODEL=jev-1.13.0`, `BIZDEV_JEV_ENABLED=true`, and both task modes to `shadow`. The TypeSafe credential is injected through the existing secret reference; it is not present in the task environment or this evidence record.

### Production acceptance and telemetry

- Signed-in browser QA confirmed that the resolved SATCOM dossier still renders the Phase 2 evidence and no Jev-only label or action. BD-SIGNAL recorded `explicit_link` in 321 ms without changing the response.
- A clearly labeled manual QA prospect, `1da7f223-6e38-4dd6-8c71-111a9d0966e1` (`SATCOM DIRECT`), remains unresolved. Opening its identity dossier returned the deterministic SATCOM DIRECT GOVERNMENT candidate and recorded BD-ENTITY `insufficient_evidence` in 276 ms; Jev did not resolve, merge, or reorder the prospect.
- The aggregate report since `2026-09-25T03:18:00Z`, generated at `2026-09-25T04:41:38.014Z`, contains one completed BD-ENTITY observation (970 input / 63 output tokens, estimated $0.000040740) and two BD-SIGNAL observations (one completed and one recovered failure; 1,180 input / 66 output tokens, estimated $0.000049560).
- The single failed BD-SIGNAL row is the initial deployment's trace-persistence defect: JavaScript `null` was encoded as JSON null instead of SQL NULL and violated the shadow-invisibility check. The recovery migration only marked shadow rows still pending for more than 10 minutes as failed/not-checked and moved their idempotency keys to a recovery namespace. The live post-hotfix invocation completed normally.
- No `trace completion failed` log exists after the hotfix deployment boundary (`2026-09-25T04:31:00Z`). Browser console errors/warnings were empty during acceptance.
- Telemetry `agreement` means equality with the stored deterministic Phase 2 outcome. Each task currently has zero agreements / one disagreement; those counters are **not human accuracy**, and all rows are unreviewed. They do not satisfy or bypass the visible-canary evaluation gate.

## Rollback

1. Disable the affected per-task tenant shadow flag.
2. Set the affected `BIZDEV_JEV_TASK_*_MODE=off`, or set `BIZDEV_JEV_ENABLED=false` to stop both tasks.
3. If the shared provider or Phase 3 application code is implicated, restore API task definition `capiro-dev-api:454` (`sha256:a10007952f6bce99c8646de1c8e13963934234a01c2efeb406bb00ffe312ff0d`). If the web release must also be reverted, restore `capiro-dev-web:138` (`sha256:368cd7370731caf4f16c36c3aa44d37a28e631201def81d0a641ed841c63933d`). Do not roll back to API `:455`, which contains the shadow-persistence defect corrected in `:456`.
4. Keep the additive trace and existing Phase 1/2 prospect, identity-review, source, and audit records; do not rewrite or delete them during rollback.

Phase 1 prospect workflow and Phase 2 evidence dossiers remain available through every task-level rollback.
