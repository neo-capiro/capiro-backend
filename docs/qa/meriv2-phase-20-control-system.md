# MeriV2 Phase 20 — SOC 2 Controls, Monitoring, and Operations

## Status

**BLOCKED — implemented but not accepted.**

Phase 20 requires a reviewable control mapping, bounded operational metrics, actionable alarms, executable rollout/rollback/backfill/policy runbooks, a non-implementer runbook walkthrough, a real isolated non-production alarm demonstration, and successful rollback rehearsals. The implementation and execution contracts are committed, but the hosted workflow did not start a legitimate job and no isolated staging/test AWS control stack exists in the accepted evidence.

No AWS stack, scheduled rule, alarm, dashboard, migration, backfill, policy pack, feature flag, Clerk configuration, customer record, external send, or production service was changed.

## Release baseline

- Repository: `neo-capiro/capirov2`
- Release branch: `agent/meriv2-world-class-closeout`
- Primary PR: `#679`
- Main SHA during Phase 20 implementation: `b792f2d24920d56d7addcda88a602c6282563f47`
- Phase 20 workflow attempt SHA: `9a773f24dc5f746723e4bc15c15dd862fab7ff21`
- Branch relation at evidence capture: 0 commits behind `main`, mergeable, draft, open, and unmerged
- Phase 17: blocked — final hosted CI matrix has not executed
- Phase 18: blocked — clean/upgrade database rehearsal has not executed
- Phase 19: blocked — authenticated browser/accessibility acceptance has not executed

## Control mapping

Created:

```text
docs/security/meriv2-memory-assurance-control-mapping.md
```

The mapping identifies implementation, owner, preventive/detective nature, primary evidence, test/rehearsal, monitoring, and retention for:

- tenant and user isolation;
- ethical walls;
- least-privilege grants;
- segregation of duties;
- legal holds;
- immutable version and transition history;
- policy binding and destination-side revalidation;
- Context Packet provenance;
- high-risk release verification;
- migration and reversible-backfill change control;
- durable outbox recovery;
- policy publication and rollback;
- audit confidentiality.

The mapping explicitly distinguishes committed implementation from operating evidence. It does not claim that the AWS controls operated.

## Bounded metrics contract

Created:

```text
packages/meriv2-core/src/assurance/control-metrics.ts
packages/meriv2-core/src/assurance/control-metrics.spec.ts
```

CloudWatch EMF namespace:

```text
Capiro/MeriV2Control
```

The only dimension is:

```text
Environment = dev | staging | prod | test | unknown
```

Tenant, user, client, memory-item, proposal, policy, model, prompt, tool, source, and content identifiers are deliberately excluded. Metrics contain finite nonnegative counts/ages or a clamped percentage. The emission path is best-effort and cannot alter authorization or release decisions.

### Required metrics

1. `PendingCandidateOldestAgeSeconds`
2. `SelfReviewDenials`
3. `EthicalWallDenials`
4. `ConflictedMemoryCount`
5. `ContextPacketPersistenceFailures`
6. `AssuranceHeldOutcomes`
7. `AssuranceDegradedOutcomes`
8. `UnsupportedHighRiskClaimRate`
9. `OutboxOldestAgeSeconds`
10. `OutboxRetryingCount`
11. `OutboxDeadLetterCount`
12. `PolicyDriftInvalidations`
13. `BackfillQuarantineCount`
14. `BackfillDriftCount`
15. `ControlMonitorFailures`

Canonical runtime emitters were attached to:

- governed-memory authorization decisions for wall and self-review denials;
- truthful Context Packet persistence failures;
- the canonical government-affairs assurance release gate for held/degraded outcomes and unsupported high-risk rate;
- destination assurance-envelope verification for policy-binding drift.

## Read-only database monitor

Created:

```text
apps/api/scripts/emit-meriv2-control-metrics.ts
```

The monitor uses a transaction-local trusted system scope to read aggregate state across tenants. It emits no row IDs or customer content. It measures pending-candidate age, conflict count, outbox age/retry/dead-letter posture, backfill quarantine/drift, and a zero/one monitor-failure heartbeat.

The API image exposes entrypoint verb:

```text
emit-meriv2-control-metrics
```

Successful runs publish `ControlMonitorFailures=0`; the failure path publishes `1` with a bounded error code. This permits a missing-data alarm without treating normal healthy silence as success.

## CloudWatch control stack

Created:

```text
infra/cdk/lib/meriv2-control-stack.ts
```

Wired from:

```text
infra/cdk/bin/capiro.ts
```

The stack contains:

- a separate read-only scheduled ECS task using the existing API image and application database secret;
- a dedicated one-year CloudWatch log group;
- a five-minute EventBridge schedule;
- the complete required alarm set with encrypted SNS `ALARM` and `OK` actions;
- a MeriV2 control dashboard;
- thresholds documented in the control mapping.

The schedule is **disabled by default**. It can be enabled only through explicit CDK context:

```text
enableMeriV2ControlMonitor=true
```

This keeps an infrastructure deployment from silently starting a new cross-tenant monitoring task.

## Guarded alarm demonstration

Created:

```text
apps/api/scripts/demo-meriv2-control-alarms.ts
```

The operator must supply exact confirmation:

```text
MERIV2_ALARM_DEMO_CONFIRM=NONPRODUCTION_ONLY
```

The command allows only normalized `staging` or `test` environments. It refuses `dev` and `prod`; Capiro `dev` currently serves production traffic and cannot be used for the demonstration.

The command emits one bounded alarm-breaching sample for all 15 metrics. It does not mutate a database or customer record. A successful Phase 20 acceptance still requires observing each AWS alarm transition to `ALARM`, notification delivery, and recovery to `OK` in an isolated non-production stack.

## Executable runbooks

Created or finalized:

```text
docs/runbooks/meriv2-memory-context-assurance-rollout.md
docs/runbooks/meriv2-memory-context-assurance-rollback.md
docs/runbooks/meriv2-memory-backfill.md
docs/runbooks/meriv2-policy-pack-operations.md
```

The runbooks now include:

- named operator/reviewer roles;
- exact prerequisites and stop conditions;
- dark deployment, additive migration, diagnostics, backfill, control-monitor, shadow, enforce, and canary ordering;
- smallest-scope rollback before global mode or image rollback;
- exact reversible backfill prepare/execute/idempotency/rollback commands and hash/drift behavior;
- policy draft/review/second approval/simulation/publication/retirement/rollback endpoints;
- explicit prohibition on destructive schema rollback as the normal incident response;
- evidence and confidentiality requirements;
- the warning that `capiro-dev` is production.

The prior rollback document’s obsolete `CONTEXT_PACKET_V2` variable and false statement that backfill rollback was not implemented were removed.

## Static and disposable validation workflow

Created:

```text
.github/workflows/meriv2-phase20-control-system.yml
apps/api/scripts/verify-meriv2-phase20-control-system.ts
```

The workflow is designed to:

1. install from the frozen lockfile;
2. generate required Prisma clients;
3. build shared runtime packages;
4. replay migrations on disposable PostgreSQL 16 + pgvector;
5. typecheck MeriV2 core, API, and CDK;
6. run bounded-metric, envelope, assurance, memory-authorization, and Context persistence tests;
7. verify all alarms, dimensions, entrypoint verbs, runbooks, and removal of obsolete instructions;
8. execute the read-only database monitor and validate its EMF heartbeat;
9. execute the alarm payload in `test` and prove it refuses `dev`;
10. rehearse reversible backfill rollback and policy-pack lifecycle concurrency;
11. upload bounded evidence for 30 days.

## Hosted execution attempt

- SHA: `9a773f24dc5f746723e4bc15c15dd862fab7ff21`
- GitHub run: `30690830116`
- Workflow identity: orphan `324351375` / `BuildFailed`
- Result: `startup_failure`
- Jobs executed: **0**
- Tests/typechecks executed: **0**
- Database commands executed: **0**
- AWS alarm demonstration executed: **0**
- Evidence artifact: none

This run is not control evidence.

## Acceptance matrix

| Requirement                            |                         Implementation |                             Operating evidence | Result  |
| -------------------------------------- | -------------------------------------: | ---------------------------------------------: | ------- |
| Complete control mapping               |                              committed | document inspection pending independent review | blocked |
| Bounded dimensions                     | committed and unit-test contract added |                           workflow did not run | blocked |
| Pending candidate metric/alarm         |                              committed |                     no AWS alarm demonstration | blocked |
| Self-review metric/alarm               |                              committed |                     no AWS alarm demonstration | blocked |
| Ethical-wall metric/alarm              |                              committed |                     no AWS alarm demonstration | blocked |
| Conflict metric/alarm                  |                              committed |                     no AWS alarm demonstration | blocked |
| Context persistence metric/alarm       |                              committed |                     no AWS alarm demonstration | blocked |
| Held/degraded/unsupported metrics      |                              committed |                     no AWS alarm demonstration | blocked |
| Outbox age/retry/dead-letter metrics   |                              committed |                     no AWS alarm demonstration | blocked |
| Policy-drift metric/alarm              |                              committed |                     no AWS alarm demonstration | blocked |
| Backfill quarantine/drift metrics      |                              committed |                     no AWS alarm demonstration | blocked |
| Runbook executable by non-implementer  |                              committed |                     no independent walkthrough | blocked |
| Rollback tested in Phase 18/staging    |                      scripts committed |          Phase 18 and staging execution absent | blocked |
| ALARM → notification → OK demonstrated |             guarded operator committed |                                   not executed | blocked |

## Remaining acceptance work

1. Restore legitimate GitHub Actions workflow registration or run the committed workflow from an authenticated clean checkout.
2. Pass Phases 17–19 on one exact synchronized SHA.
3. Establish an isolated staging/test AWS stack; do not use `capiro-dev`.
4. Have a non-implementer execute each runbook from the committed version and record gaps.
5. Deploy only the separate MeriV2 control stack with the monitor initially disabled.
6. Run the read-only monitor successfully, then enable the schedule explicitly.
7. Drive every Phase 20 alarm to `ALARM`, verify encrypted SNS delivery, and drive it back to `OK`.
8. Execute and retain the database/backfill/policy rollback rehearsals.
9. Review metric/log samples for bounded cardinality and absence of customer content or secrets.
10. Replace this blocked record with exact successful run, stack, alarm-history, notification, and reviewer evidence.

## Safety boundary

Phase 20 added no production authorization. PR #679 must remain draft and unmerged. All governed-memory, Context Packet v2, persisted-policy, assurance, and release-gate controls remain off outside an explicitly approved disposable/internal environment until the release prerequisites are satisfied.
