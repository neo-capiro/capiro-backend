# Phase 27G — Institutional-learning rollout controls

Phase 27G is the controlled production canary for the Phase 27 institutional
learning loop. This document covers only the *controls*: what can be turned
on, for whom, and how each is reversed.

## The problem 27G found

Phases 27A–27F each shipped a single process-wide switch:

| Control | Env var | Default when unset |
| --- | --- | --- |
| Signal capture | `LEARNING_SIGNAL_CAPTURE` | **enabled** (only the literal `disabled` turns it off) |
| Candidate generation | `LEARNING_CANDIDATE_GENERATION` | disabled |
| Quality telemetry | `LEARNING_QUALITY_TELEMETRY` | disabled |
| Evaluation | `LEARNING_EVALUATION` | disabled |
| Evaluation sample rate | `LEARNING_EVALUATION_SAMPLE_RATE` | `0` |

None of them had a tenant dimension, so the only available rollout
granularity was "off everywhere" or "on for every tenant in the cluster".

`LEARNING_SIGNAL_CAPTURE` is the sharp edge, because it is the one control
that defaults to ON. Phase 27A's own reasoning for that default was sound at
the time — a captured signal was inert, nothing read `learning_signal` — but
the consequence is that deploying 27A armed capture for **every tenant at
once**, and 27B–27D then gave those rows a downstream path. On the
`capiro-dev` cluster this had not yet produced a customer-tenant row, but
only because no user outside the internal tenant had happened to touch a
wired surface. That is luck, not a control.

A controlled canary needs the blast radius bounded by configuration.

## The rollout bound

`LEARNING_TENANTS` is an exact, bounded tenant allowlist read by all four
controls. It is implemented by `learningTenantSelected()` in
`packages/meriv2-core/src/learning/rollout.ts`, and is deliberately the same
shape and the same fail-closed semantics as the existing
`governedMemoryTenantSelected()` / `MEMORY_GOVERNANCE_TENANTS` pair:

- comma- or space-separated list of server-resolved tenant ids
- case-insensitive, whitespace-trimmed, no prefix matching — a near-match
  stays off
- the literal `all` is the only general-availability value
- **unset or empty selects nobody**
- an absent tenant id selects nobody, even under `all`

A browser-supplied tenant hint is never authority; every call site passes the
tenant id the server already resolved.

### It is ANDed, never substituted

Each control keeps its own switch. The allowlist is an additional condition,
so the two remain independently reversible — which Phase 27G §21 requires:

- the per-control switch still stops that one control for **every** tenant,
  regardless of the allowlist;
- the allowlist still bounds **every** control to named tenants, regardless
  of the switches.

For capture this flips the effective default from on-everywhere to
off-everywhere. That is intended: a Phase 27 control should be armed by
naming a tenant, never merely by being deployed.

### Where it is enforced

| Enforcement point | Effect when the tenant is not selected |
| --- | --- |
| `LearningSignalCaptureService.capture` | `{ status: 'disabled' }`, no `learning_signal` row |
| `LearningSignalCandidateService.generateForSignal` | `null` — "not processed yet", no outcome row |
| `LearningSignalCandidateService.processBatch` | `[]`, and the batch read is skipped entirely |
| `QualityTelemetryCaptureService.recordEvent` | `{ status: 'disabled' }`, no telemetry row |
| `EvaluationCaptureService.recordDecision` | `{ status: 'disabled' }`, no `evaluation_record` row — not even a `skipped`/`not_sampled` one |
| `OutreachEvaluationRunner.considerAndRun` | returns before the shadow control replay starts |
| `CrmFillEvaluationRunner.considerAndRun` | returns before the shadow control replay starts |
| `considerMeriResearchEvaluation` | returns; no eligibility decision row |

The two evaluation runners and the Meri factory check the bound in addition
to `EvaluationCaptureService`, so a tenant outside the allowlist never even
*starts* replay work rather than doing it and failing to persist the result.

In the telemetry and evaluation services the check sits immediately after
`validate(input)` rather than before it, so a missing `tenantId` is still
reported as the input error it is instead of being masked as a rollout
decline.

## Rollout order

Each step is one task-definition revision; each is reversed by registering
the prior revision.

```
0. deploy dark          LEARNING_TENANTS unset  → every control off everywhere
1. bound only           LEARNING_TENANTS=<internal-tenant-uuid>
                        (capture is now on for that tenant only; the other
                        three controls are still dark by their own defaults)
2. quality telemetry    LEARNING_QUALITY_TELEMETRY=enabled
3. candidate generation LEARNING_CANDIDATE_GENERATION=enabled
4. governance           (no flag — existing human review queue)
5. evaluation           LEARNING_EVALUATION=enabled
                        LEARNING_EVALUATION_SAMPLE_RATE=<small>
```

Note that step 1 arms capture as a side effect, because capture's own switch
defaults to on. To hold capture off while telemetry runs, set
`LEARNING_SIGNAL_CAPTURE=disabled` alongside the allowlist and remove it when
capture is wanted.

## Reversing

| To stop | Do |
| --- | --- |
| one control, everywhere | set that control's own switch off (`LEARNING_SIGNAL_CAPTURE=disabled`, or remove `=enabled` from the other three) |
| every control, one tenant | remove that tenant from `LEARNING_TENANTS` |
| every control, everywhere | unset `LEARNING_TENANTS` |
| the deployment itself | `update-service` back to the prior task-definition revision |

Reversal disables behaviour; it never erases history. Rows already written
stay written.

## Tests

`packages/meriv2-core/src/learning/rollout.spec.ts` covers the selector
itself (fail-closed, `all`, near-match rejection, absent tenant id). Each of
the four services has rollout-bound cases in its own spec proving no row is
written for a tenant outside the allowlist, and that the bound and the
per-control switch stop the control independently.

`apps/api/jest.setup.ts` sets `LEARNING_TENANTS ??= 'all'` so existing suites
keep exercising governed behaviour directly, matching the
`MEMORY_GOVERNANCE_TENANTS` precedent immediately above it. The dedicated
rollout tests delete or override the value to prove the production
fail-closed semantics.
