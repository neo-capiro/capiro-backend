# MeriV2 Phase 0–22 Development Completeness Review

## Decision

**Development disposition: COMPLETE, subject to successful execution of the committed local release preflight.**

This review treats “development complete” separately from “production released”:

- **Development complete** means the required runtime behavior, schema, migration, UI, infrastructure definition, operator command, test/evaluation contract, and rollback mechanism exist in the repository and no known implementation gap remains.
- **Release accepted** means those artifacts have passed the exact local code matrix, disposable clean/upgrade database rehearsal, authenticated browser/accessibility acceptance, AWS read-only diff, human review, migration, dark deployment, and controlled canary.

GitHub Actions is not a prerequisite for this determination. The branch now contains a local, evidence-producing release gate:

```bash
pnpm verify:meriv2-development
pnpm collect:meriv2-aws-context -- --env dev --profile capiro-dev
pnpm verify:meriv2-release -- --ops-context=.artifacts/meriv2-aws-context-dev.json
```

The release command performs no AWS writes. It must pass before PR #679 is marked ready or merged.

## Audit method

The review compared every Phase 0–22 objective in the closeout and production deployment plan against the current implementation rather than trusting prior phase labels. It inspected:

1. canonical write and authorization paths;
2. all 14 additive migrations and Prisma models;
3. Settings, review, Governance Center, Context Inspector, editor, and proposal-card UI;
4. Context Packet v2 and government-affairs assurance behavior across Chat, In-editor, Workspace, Strategy, Outreach, Steward, memo, and district brief surfaces;
5. projection/outbox, policy-pack, and backfill operators;
6. database and authenticated-browser rehearsals;
7. CloudWatch metrics, alarms, dashboards, notification actions, and retention;
8. deployment ownership and rollback safety in the real AWS topology, where the environment named `dev` serves production traffic and the historical Compute stack must not be used as the MeriV2 operations deployment vehicle;
9. TODO/FIXME/bypass searches in the release-critical code;
10. the exact local merge-and-ship path.

The executable static counterpart is:

```text
apps/api/scripts/verify-meriv2-development-completeness.ts
```

It fails if any required phase artifact, migration, tenant/surface rollout boundary, dark schedule, or critical security invariant is absent.

---

## Phase-by-phase disposition

### Phase 0 — Containment and control boundaries

**Development status: complete.**

Covered:

- server-to-server tool and action-proposal boundaries;
- governed Meri tool/research wrappers;
- tenant/private-memory fail-closed behavior;
- exact-row embedding isolation;
- denial of browser-supplied tenant, role, wall, or compliance authority;
- bypass scans for live `ethicalWallAllowed: true` and unexpected `admin_auto_commit` references.

Primary implementation:

```text
apps/api/src/meri/governed-meri-tools.proxy.ts
apps/api/src/meri/governed-meri-research.factory.ts
apps/meriv2-orchestrator/src/meri/api-action-proposal.repo.ts
apps/api/src/memory/memory-embed-isolation.spec.ts
apps/api/src/memory/memory-private-fail-closed.spec.ts
```

No remaining Phase 0 development gap was found.

### Phase 1 — Atomic candidate activation

**Development status: complete.**

Covered:

- candidate row locking with `SELECT ... FOR UPDATE`;
- pending-state recheck after lock acquisition;
- canonical memory mutation, candidate disposition, transition evidence, and required projection obligation in one transaction;
- rollback of all state on injected failure;
- independent reviewer requirement for shared memory;
- concurrent approval convergence to one activation;
- tenant-safe unknown/cross-tenant behavior.

Primary implementation:

```text
apps/api/src/memory/memory-candidate.service.ts
apps/api/src/memory/memory-candidate.atomicity.spec.ts
apps/api/src/memory/memory-candidate.approval.spec.ts
```

No remaining Phase 1 development gap was found.

### Phase 2 — Canonical governed metadata

**Development status: complete.**

Covered:

- canonical governed status, class, scope, authority, provenance, approval, temporal, origin, conflict, and legal-hold fields;
- canonical activation helpers shared by candidate, correction, restore, and governed ingest paths;
- forced-RLS schema and indexes;
- conservative classification of legacy/unclassified data.

Primary implementation:

```text
apps/api/prisma/migrations/20260729010000_memory_governance_context_v2/migration.sql
apps/api/src/memory/memory-governance.service.ts
apps/api/src/memory/governed-memory-candidate.service.ts
apps/api/src/memory/governed-memory-store.service.ts
apps/api/prisma/schema.prisma
```

No remaining Phase 2 development gap was found.

### Phase 3 — Settings shared-memory review lifecycle

**Development status: complete.**

Covered:

- firm/client edits create proposals instead of directly mutating active steering context;
- first-time shared files also enter review;
- personal owner-only memory remains immediate;
- truthful pending/rejected/withdrawn state survives reload;
- independent approval activates the exact proposed content;
- client-wall checks occur server-side.

Primary implementation:

```text
apps/web/src/components/MemoryFileEditor.tsx
apps/web/src/components/MemoryProposalQueue.tsx
apps/web/src/components/MemoryReviewQueue.tsx
apps/api/src/memory/memory.controller.settings-review.spec.ts
apps/web/src/components/MemoryFileEditor.phase3.test.ts
```

No remaining Phase 3 development gap was found.

### Phase 4 — Immutable corrections, contradictions, conflicts, revoke, restore, and legal hold

**Development status: complete.**

Covered:

- corrections and contradictions create new reviewed versions;
- conflict groups and controlling-version resolution;
- reversible revocation;
- restoration as a new version rather than resurrection in place;
- legal hold blocks destructive operations;
- append-only transition evidence and lineage.

Primary implementation:

```text
apps/api/prisma/migrations/20260812010000_memory_immutable_versions/migration.sql
apps/api/src/memory/immutable-memory-version.service.ts
apps/api/src/memory/memory-conflict.service.ts
apps/api/src/memory/memory-version.controller.ts
```

No remaining Phase 4 development gap was found.

### Phase 5 — Durable projection worker

**Development status: complete.**

Covered:

- durable outbox draining outside the request transaction;
- lease-based concurrent worker safety;
- bounded batch and lease duration;
- Titan-only embedding permission;
- runtime application database credential;
- dedicated retained logs;
- five-minute EventBridge schedule;
- failed, dead-letter, and crash alarms.

Release-hardening gap closed during this audit:

- the schedule previously defaulted enabled; it now uses `enabled: props.scheduleEnabled` and is dark unless explicitly armed;
- the worker previously referenced a mutable `latest` image; it now requires the exact release-SHA image tag;
- worker alarms previously had no notification action; they now publish both `ALARM` and `OK` to the encrypted operational SNS topic.

Primary implementation:

```text
apps/api/src/memory/exact-memory-projection-worker.service.ts
apps/api/scripts/drain-memory-cleanup-outbox.ts
infra/cdk/lib/constructs/scheduled-memory-projection-worker.ts
infra/cdk/lib/memory-projection-worker-stack.ts
```

No remaining Phase 5 development gap was found.

### Phase 6 — Exact projection completion and recovery

**Development status: complete.**

Covered:

- source version and canonical content-hash binding;
- exact idempotency key and completion receipt;
- retry, stale-lease reclaim, supersession, and dead letter;
- safe fast-path completion only for the exact obligation;
- revocation cleanup does not re-authorize memory while projection deletion is pending.

Primary implementation:

```text
apps/api/prisma/migrations/20260812020000_memory_cleanup_worker_leases/migration.sql
apps/api/prisma/migrations/20260812030000_memory_projection_exact_completion/migration.sql
apps/api/src/memory/exact-memory-cleanup-outbox.service.ts
apps/api/src/memory/exact-memory-projection-worker.service.ts
```

No remaining Phase 6 development gap was found.

### Phase 7 — Truthful Context Packet persistence

**Development status: complete.**

Covered:

- persistence is inside the release boundary rather than best effort;
- exact packet ID returned only after read-after-write verification;
- failure is recorded request-locally even when a legacy caller catches an ordinary context exception;
- Workspace and API persistence boundaries hold output rather than claiming nonexistent provenance.

Primary implementation:

```text
apps/api/src/context/context-persistence-boundary.service.ts
apps/api/src/context/context-persistence-boundary.interceptor.ts
apps/api/src/context/context-required-persistence.ts
apps/workspace/src/generation/context-persistence-hold.ts
```

No remaining Phase 7 development gap was found.

### Phase 8 — Context Packet v2 rollout and parity

**Development status: complete.**

Covered:

- `off`, `shadow`, and `enforce` modes;
- exact server-resolved tenant and surface selection;
- governed and legacy packet comparison in shadow;
- health, exclusions, required layers, truncation, token budget, compiler/prompt/policy version, and effective-tenant evidence;
- fail-closed ethical-wall lookup.

Primary implementation:

```text
packages/meriv2-core/src/context/context-rollout.ts
packages/meriv2-core/src/context/context-release-switch.ts
packages/meriv2-core/src/context/compiler-v2.spec.ts
apps/api/src/context/context-compiler.service.ts
```

No remaining Phase 8 development gap was found.

### Phase 9 — Governed lifecycle convergence

**Development status: complete.**

Covered:

- one governed status vocabulary and validated transition graph;
- canonical governance propagation for auto-commit and reviewed activation;
- synchronous terminal-state suppression;
- withdrawal/rejection reason preservation;
- lineage migration and transition audit.

Primary implementation:

```text
apps/api/prisma/migrations/20260729011000_memory_governance_lineage/migration.sql
apps/api/src/memory/memory-governance-lifecycle.helpers.ts
apps/api/src/memory/memory-canonical-activation.helpers.ts
packages/meriv2-core/src/memory/governance.ts
```

No remaining Phase 9 development gap was found.

### Phase 10 — Persisted policy authority and selected-version decisions

**Development status: complete.**

Covered:

- tenant-persisted immutable policy packs;
- draft, review, four-eyes approval, simulation, publication, retirement, and rollback;
- integrity/rules hashes;
- exact selected pack/version/rule binding;
- transaction-scoped authoritative decision record;
- `off`, `shadow`, and fail-closed `enforce` modes;
- disabled/sample legal policies cannot publish.

Primary implementation:

```text
apps/api/prisma/migrations/20260811010000_assurance_policy_packs/migration.sql
apps/api/prisma/migrations/20260813010000_policy_pack_action_authority/migration.sql
apps/api/prisma/migrations/20260813020000_policy_pack_lifecycle_concurrency/migration.sql
apps/api/src/meri/meri-policy-pack.service.ts
apps/api/src/meri/meri-policy-pack.controller.ts
apps/web/src/pages/settings/PolicyPacksPage.tsx
```

No remaining Phase 10 development gap was found.

### Phase 11 — Reversible governed-memory backfill

**Development status: complete.**

Covered:

- tenant-scoped durable prepare/execute/verify/rollback jobs;
- exact tenant and job confirmations;
- plan, before, and post hashes;
- quarantine instead of guessing;
- idempotent rerun;
- drift-safe execution and rollback;
- append-only backfill event evidence and delete guards.

Primary implementation:

```text
apps/api/prisma/migrations/20260814010000_memory_governance_backfill_jobs/migration.sql
apps/api/prisma/migrations/20260814011000_memory_governance_backfill_delete_guards/migration.sql
apps/api/scripts/backfill-memory-governance-v2.ts
apps/api/scripts/lib/memory-governance-backfill-store.ts
apps/api/scripts/test-memory-governance-backfill-rollback.sh
```

No remaining Phase 11 development gap was found.

### Phase 12 — Least-privilege client review grants

**Development status: complete.**

Covered:

- standard-user reviewer path without administrator elevation;
- explicit client, user, permission, reason, grantor, expiry, status, and revocation;
- grant does not bypass the ethical wall;
- expired/revoked grants fail closed;
- grant and wall checks occur inside the canonical authorization decision.

Primary implementation:

```text
apps/api/src/memory/memory-access-grant.service.ts
apps/api/src/memory/memory-authorization.service.ts
apps/api/src/memory/memory-authorization.phase12.spec.ts
```

No remaining Phase 12 development gap was found.

### Phase 13 — Proposer withdrawal versus reviewer rejection

**Development status: complete.**

Covered:

- proposer can withdraw their own pending proposal;
- reviewer rejection remains a distinct action and reason code;
- shared self-approval remains prohibited;
- terminal state and truthful labels survive reload.

Primary implementation:

```text
apps/api/prisma/migrations/20260815010000_memory_candidate_withdrawal/migration.sql
apps/api/src/memory/memory-candidate-withdrawal.helpers.spec.ts
apps/web/src/components/MemoryProposalQueue.tsx
apps/web/src/components/MemoryReviewQueue.tsx
```

No remaining Phase 13 development gap was found.

### Phase 14 — Accessible Context Inspector

**Development status: complete.**

Covered:

- exact packet/provenance display without raw secret or unauthorized content;
- exclusions and unauthorized count;
- keyboard activation, focus, ARIA relationships, labels, live states, responsive layout, and reduced motion;
- deterministic accessibility fixture and tests.

Primary implementation:

```text
apps/web/src/components/trust/ContextInspector.tsx
apps/web/src/components/trust/ContextInspector.css
apps/web/src/components/trust/ContextInspector.test.tsx
apps/web/src/components/trust/ContextInspector.a11y-fixture.tsx
```

No remaining Phase 14 development gap was found.

### Phase 15 — Memory Governance Center

**Development status: complete.**

Covered:

- overview, active, pending, conflicts, review due, history, grants, transitions, and projection health;
- item detail with provenance, approvals, temporal validity, origin, versions, conflicts, transitions, and projection obligations;
- confirm, stale, second approval, correction, revoke, restore, and conflict resolution;
- legal-hold and authorization-driven action visibility;
- release switch requiring lifecycle and authorization controls.

Primary implementation:

```text
apps/api/src/memory/memory-governance.controller.ts
apps/api/src/memory/memory-governance-read.service.ts
apps/api/src/memory/memory-governance-action.service.ts
apps/web/src/components/MemoryGovernanceCenter.tsx
```

No remaining Phase 15 development gap was found.

### Phase 16 — Cross-surface government-affairs assurance envelope

**Development status: complete after tenant/surface corrections made during this audit.**

Covered:

- government-affairs operating frame;
- domain evidence plan;
- claim ledger and authoritative-evidence ceilings;
- deterministic legislative, budget, role, district, deadline, negative-claim, and recommendation checks;
- high-risk buffering, repair, hold, and human-review decisions;
- immutable envelope binding surface, verifier version, Context Packet, policy pack/version/rule, decision hash, and context hash;
- destination-side revalidation;
- section-level finding attribution;
- exact tenant and surface canaries across Chat, In-editor, Workspace, Strategy, Outreach, Steward, memo, and district brief.

Release-critical gaps closed during this audit:

1. Workspace had a tenant-aware resolver but the live HTTP generation path still called the legacy all-tenant helper. The authenticated `WorkspaceTenantContext` is now carried through request-local `AsyncLocalStorage`, including concurrent-request isolation.
2. API Strategy destination verification used the legacy all-tenant helper. `AgentsController` execution is now wrapped by a server-resolved tenant interceptor, and the exact verified envelope surface is bound before persistence.
3. Strategy document generation treated Workspace and Outreach artifacts as one `strategy` surface. The controller now resolves and compiles `outreach` separately, establishes the exact tenant/surface assurance scope, and rejects unknown artifact kinds before context compilation or model execution.

Primary implementation:

```text
packages/meriv2-core/src/assurance/*
apps/meriv2-orchestrator/src/meri/chat/chat-assistant.service.ts
apps/meriv2-orchestrator/src/meri/in-editor/in-editor-assistant.service.ts
apps/workspace/src/generation/generation-assurance.ts
apps/workspace/src/generation/generation.controller.ts
apps/meriv2-orchestrator/src/meri/strategy/strategy.controller.ts
apps/meriv2-orchestrator/src/meri/strategy/strategy-assurance.ts
apps/meriv2-orchestrator/src/meri/steward/steward-assurance.ts
apps/api-strategy/src/agents/execution-assurance.ts
apps/api-strategy/src/agents/execution-assurance-tenant.interceptor.ts
```

No remaining Phase 16 development gap was found.

### Phase 17 — One exact release matrix

**Development status: complete; local execution required.**

GitHub Actions is no longer the sole acceptance mechanism. The repository now has:

```text
scripts/verify-meriv2-release.mjs
apps/api/scripts/verify-meriv2-development-completeness.ts
```

Development mode runs the complete exact-head code/test/eval matrix and Phase 18. Release mode additionally runs Phase 19 and read-only AWS operations-stack synth/diff. It checks a clean checkout and current `main`, writes per-step evidence, and performs no AWS mutation.

Remaining work is execution, not development.

### Phase 18 — Clean and production-equivalent upgrade database rehearsal

**Development status: complete; local execution required.**

Covered:

- clean PostgreSQL 16 + pgvector replay from migration zero;
- current-main-equivalent upgrade database plus branch migrations;
- migration-set parity;
- Prisma validation and migration status;
- `migrate diff --exit-code` drift gate;
- schema/index/check/trigger/forced-RLS assertions;
- real `capiro_app` role tenant/private isolation;
- canonical memory lifecycle, Context Packet, exact outbox, backfill, and policy-pack rehearsal;
- no manual SQL repair.

Primary implementation:

```text
apps/api/scripts/meriv2-phase18-database-rehearsal.sh
apps/api/scripts/meriv2-phase18-schema-assertions.sql
apps/api/scripts/meriv2-phase18-rls-rehearsal.sh
apps/api/scripts/meriv2-phase18-application-rehearsal.ts
apps/api/scripts/meriv2-phase18-backfill-rehearsal.ts
```

Remaining work is execution, not development.

### Phase 19 — Authenticated browser and accessibility acceptance

**Development status: complete; Clerk-backed local execution required.**

Covered:

- four real Clerk actors: proposer, independent reviewer, granted standard reviewer, and wall-denied user;
- private save/reload;
- shared proposal and independent approval;
- grant-scoped review without admin elevation;
- denied-response confidentiality scan;
- withdrawal/rejection, correction, conflict, legal hold, revoke/restore, projection retry;
- focus trap/return, keyboard, ARIA, live regions, reduced motion, clipping, overflow, and four viewports;
- live Context, shadow/enforce, Chat, Editor, Workspace, Strategy/Steward, export, and policy-version prepared states.

The new local runner performs the disposable database/API/Web/Chrome lifecycle without GitHub Actions:

```text
scripts/run-meriv2-phase19-local.mjs
```

Remaining work is test-identity/prepared-state configuration and execution, not development.

### Phase 20 — SOC 2 controls, alarms, rollout, and rollback runbooks

**Development status: complete; non-production alarm demonstration and operator walkthrough required.**

Covered:

- control mapping for every plan-listed security/assurance control;
- 15 bounded-cardinality metrics under `Capiro/MeriV2Control`;
- only the `Environment` dimension;
- retained logs, dashboard, ALARM and OK notification actions;
- read-only database posture monitor;
- guarded non-production alarm demonstration;
- rollout, rollback, backfill, and policy-pack operator runbooks.

Release-hardening gaps closed during this audit:

- disabled monitor silence is now `NOT_BREACHING`; once armed, a missing heartbeat is `BREACHING`;
- the monitor is bound to an exact release-SHA API image;
- the worker and control stacks have one sole deployment owner: `infra/cdk/bin/meriv2-operations.ts`;
- the operations app imports live resources by ARN/id, never instantiates Compute/Data/Network/Alarms, and therefore does not require a dangerous update to the frozen Compute stack;
- operations evidence is retained even though the live environment is named `dev`.

Remaining work is isolated alarm demonstration and human walkthrough, not development.

### Phase 21 — Trusted PR and release authorization package

**Development status: complete; exact-head evidence and independent approvals required.**

Covered:

- base/head, migrations, flags/defaults, schema, tests/evals, database rehearsal, browser acceptance, SOC 2 mapping, deployment order, rollback order, and no-production-action statement;
- exhaustive development review;
- local release evidence format;
- no unresolved implementation thread identified in this audit.

The PR must remain draft until `pnpm verify:meriv2-release` passes and the four required reviewers approve.

### Phase 22 — Production migration, dark deployment, canary, backfill, and GA

**Development status: complete as an executable operator procedure; production execution not performed.**

Covered by:

```text
scripts/collect-meriv2-aws-context.mjs
docs/runbooks/meriv2-merge-and-aws-ship.md
docs/runbooks/meriv2-memory-context-assurance-rollout.md
docs/runbooks/meriv2-memory-context-assurance-rollback.md
```

The procedure captures the live baseline and rollback points, builds immutable SHA-tagged images, applies additive migrations, deploys code with all controls dark, deploys only the independent operations stacks, manually exercises the worker/monitor, enables schedules deliberately, backfills one tenant/job at a time, and advances `off → shadow → enforce` one tenant/surface at a time.

Remaining work is the explicitly authorized production operation.

---

## Complete migration set

The MeriV2 release carries 14 additive migrations:

1. `20260729010000_memory_governance_context_v2`
2. `20260729011000_memory_governance_lineage`
3. `20260811010000_assurance_policy_packs`
4. `20260811020000_assurance_eval_runs`
5. `20260811030000_assurance_feedback_fixtures`
6. `20260811040000_memory_index_outbox_subject`
7. `20260812010000_memory_immutable_versions`
8. `20260812020000_memory_cleanup_worker_leases`
9. `20260812030000_memory_projection_exact_completion`
10. `20260813010000_policy_pack_action_authority`
11. `20260813020000_policy_pack_lifecycle_concurrency`
12. `20260814010000_memory_governance_backfill_jobs`
13. `20260814011000_memory_governance_backfill_delete_guards`
14. `20260815010000_memory_candidate_withdrawal`

They remain subject to the Phase 18 clean/upgrade replay and live pre-migration inspection.

## Merge gate

PR #679 can be marked ready and merged only after all of the following are true on one exact head:

1. `pnpm verify:meriv2-development` passes.
2. `pnpm collect:meriv2-aws-context -- --env dev --profile capiro-dev` succeeds without reading secret values.
3. Dedicated Clerk actors and prepared-state environment variables are configured.
4. `pnpm verify:meriv2-release -- --ops-context=<collector-output>` passes.
5. The resulting summary has:
   - `releaseReady: true`;
   - `phase18Passed: true`;
   - `phase19Passed: true`;
   - `operationsSynthPassed: true`;
   - `operationsDiffPassed: true`.
6. Security/code-owner, database/migration, product/UX, and release-operator approvals are recorded.
7. The branch is still current with `main`, clean, and mergeable.

## Final conclusion

The audit found and closed four material development gaps: dark scheduling/notification, monitor-heartbeat semantics, Workspace tenant canary propagation, and Strategy/Outreach tenant/surface propagation. It also removed the frozen Compute stack from the MeriV2 operations deployment path.

**No known Phase 0–22 development item remains open.** The remaining work is evidence-producing local execution, independent approval, merge, and the authorized AWS operation described in the ship runbook.
