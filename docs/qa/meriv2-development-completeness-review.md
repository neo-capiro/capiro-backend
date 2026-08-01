# MeriV2 Phase 0–22 Development Completeness Review

## Final development decision

**COMPLETE — no known feature-development or release-automation gap remains in Phases 0–22.**

This decision is deliberately narrower than claiming the release has already passed or shipped:

- **Development complete** means the runtime behavior, schema, migrations, user experience, authorization path, test/evaluation contract, infrastructure definition, operator command, and rollback mechanism required by every phase are present and wired to the live product path.
- **Merge accepted** requires the exact final SHA to pass the repository-owned local release preflight and receive independent security/code, database, product/UX, and release-operator review.
- **Production shipped** requires the guarded migration and all-controls-dark AWS deployment, dark smoke test, disabled-schedule operations-stack deployment, bounded internal canaries, and the documented stop/rollback criteria.

GitHub Actions is not a prerequisite for any of those decisions. The repository-owned evidence path is:

```bash
pnpm verify:meriv2-development
pnpm collect:meriv2-aws-context -- \
  --env dev \
  --profile capiro-dev \
  --region us-east-1 \
  --output .artifacts/meriv2-aws-context-dev.json
pnpm verify:meriv2-release -- \
  --ops-context .artifacts/meriv2-aws-context-dev.json \
  --profile capiro-dev
```

The first two verification commands do not mutate AWS or a shared database. Release mode requires authenticated Clerk browser fixtures and performs only a read-only AWS CDK diff.

The authoritative merge-and-ship procedure is:

```text
docs/runbooks/meriv2-merge-and-aws-ship.md
```

---

## Audit method

The final audit did not accept prior phase labels at face value. It re-read the current branch and traced:

1. every canonical memory mutation and direct caller;
2. every approval, rejection, withdrawal, correction, conflict, revoke, restore, and grant path;
3. every governed-memory and policy tenant selector;
4. Context Packet persistence and rollout on API, orchestrator, Workspace, Strategy, and external-deliverable paths;
5. government-affairs assurance before response, apply, persistence, artifact creation, or external action;
6. all 14 additive migrations, forced RLS, backfill controls, and exact projection obligations;
7. the Settings stable-file identity across immutable versions;
8. browser, accessibility, database, and local release rehearsals;
9. worker/control infrastructure ownership, schedule defaults, image identity, alarms, and notification wiring;
10. the actual merge, migration, ECS deployment, operations-stack deployment, canary, and rollback commands.

The executable static counterpart is:

```text
apps/api/scripts/verify-meriv2-development-completeness.ts
```

It covers all 23 numbered phases and fails when a required migration, live service binding, tenant/surface boundary, dark schedule, immutable Settings path, standalone Workspace gate, or AWS operator is absent.

---

## Release-critical gaps closed during the final audit

The final audit found and closed the following issues that were not adequately covered by earlier phase summaries:

### 1. Existing shared Settings edits could still replace truth in place

An edit to an existing firm/client Settings memory file could enter the generic candidate activation path, whose canonical slug upsert can update an existing row. That contradicted Phase 4’s immutable shared-truth requirement.

Closed with:

```text
apps/api/src/memory/settings-memory-version-candidate.service.ts
apps/api/src/memory/settings-aware-memory-candidate.service.ts
apps/api/src/memory/lineage-aware-memory-store.service.ts
```

Existing shared Settings edits now become `memory_correction` candidates and use `ImmutableMemoryVersionService`. First-time files retain the standard review path.

### 2. Stable Settings type/slug could return a superseded root

Immutable versions receive unique historical slugs. Settings still addresses a file by its stable catalog type/slug. Without lineage resolution, reload could find the superseded root instead of the active descendant.

The final store follows `supersedes_id` recursively and returns the active controlling descendant only for a selected governed tenant. Unselected tenants retain inherited behavior.

### 3. Racing first-time Settings approvals could overwrite one another

Two pending “first-time” shared-file proposals could both be approved. The second activation could hit `ON CONFLICT ... DO UPDATE` after the first created the catalog identity.

Shared catalog activation is now insert-only with `ON CONFLICT ... DO NOTHING`. A stale/racing approval produces a controlled 409, rolls back the complete candidate activation transaction, and tells the user to reload and submit an immutable correction. Active truth is never replaced.

### 4. Settings source vocabulary was inconsistent

First-time Settings activation used `settings_editor`, which was outside the shared governed source vocabulary. First-time and corrected Settings memory now use:

```text
approved_document_edit
```

### 5. Standalone Workspace generation bypassed the Phase 16 claim gate

`generate-all`, retry, and apply paths were gated, but `POST /drafts/:draftId/generate-section` could return a generated high-risk section before claim assurance ran.

Closed with:

```text
apps/workspace/src/generation/single-section-assurance.ts
apps/workspace/src/generation/single-section-assurance.spec.ts
```

The authenticated controller establishes the tenant request scope and applies the same per-section release decision before the generated section leaves the API.

### 6. Disposable Phase 18/19 runners did not select a governed tenant

After tenant allowlists were introduced, the database and browser rehearsals could arm global switches while silently exercising the dark path.

The isolated runners now explicitly select `all` only inside their disposable PostgreSQL/Clerk test environments:

```text
MEMORY_GOVERNANCE_TENANTS=all
MERI_POLICY_PACK_TENANTS=all   # Phase 18 only
```

Production canaries must use exact tenant UUIDs and may not start with `all`.

### 7. Dark ECS preparation could preserve stale tenant selections

The task-definition preparer cleared global modes but did not originally own every tenant allowlist or the legacy Context variable. It now removes and rewrites all controlled values, including:

```text
MEMORY_GOVERNANCE_TENANTS
MERI_POLICY_PACK_TENANTS
MERI_RELEASE_GATE_TENANTS
MERI_RELEASE_GATE_SURFACES
CONTEXT_PACKET_V2
```

### 8. No single guarded migration-and-service deploy command existed

Added:

```text
scripts/execute-meriv2-ecs-release.mjs
```

It resolves exact-SHA ECR tags to immutable digests, registers the migration and five service task definitions, runs the additive migration task first, updates services one at a time, verifies stabilization, and restores every already-updated service to its prior task definition on failure. It does not enable features, schedules, backfill, or sends.

### 9. No guarded independent operations-stack deploy command existed

Added:

```text
scripts/deploy-meriv2-operations-dark.mjs
```

It deploys only:

```text
Capiro-<env>-MemoryProjectionWorker
Capiro-<env>-MeriV2Control
```

through `infra/cdk/bin/meriv2-operations.ts`, verifies both EventBridge rules remain disabled, and never instantiates the historical Compute, Data, Network, DNS, or Alarms stacks.

### 10. Release automation had no syntax/safety gate

Added:

```text
scripts/verify-meriv2-release-scripts.mjs
```

Both local preflight commands now parse every `.mjs` release operator and verify read-only discovery, dark values, migration-before-service ordering, immutable image resolution, rollback presence, and disabled operations schedules before the longer code/test matrix begins.

---

## Phase-by-phase disposition

| Phase | Objective                                                  | Development disposition                  | Final evidence owner                                 |
| ----: | ---------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------- |
|     0 | Containment and server-owned control boundaries            | Complete                                 | Static completeness, API/orchestrator tests          |
|     1 | Atomic candidate activation                                | Complete                                 | API atomicity/concurrency tests; Phase 18            |
|     2 | Canonical governed metadata and lineage                    | Complete                                 | Migration/schema tests; Context recall tests         |
|     3 | Settings shared-memory review lifecycle                    | Complete                                 | Settings API/web tests; Phase 19                     |
|     4 | Immutable corrections, restores, conflicts, and legal hold | Complete                                 | Immutable service tests; Phase 18/19                 |
|     5 | Durable deployable projection worker                       | Complete                                 | Worker tests; operations-stack synth/diff            |
|     6 | Exact projection completion and failure recovery           | Complete                                 | Exact worker/outbox tests; Phase 18                  |
|     7 | Truthful Context Packet persistence                        | Complete                                 | Persistence boundary tests; Phase 18/19              |
|     8 | Context Packet v2 off/shadow/enforce rollout               | Complete                                 | Core/API/orchestrator/Workspace tests                |
|     9 | Authoritative governed lifecycle                           | Complete                                 | Recall/predicate tests across surfaces               |
|    10 | Persisted policy packs as action authority                 | Complete                                 | Policy concurrency/service/UI tests; Phase 18        |
|    11 | Reversible drift-safe governance backfill                  | Complete                                 | Disposable PostgreSQL execute/rollback rehearsal     |
|    12 | Explicit least-privilege client reviewers                  | Complete                                 | Grant/wall/authorization matrix; Phase 19            |
|    13 | Withdrawal distinct from rejection                         | Complete                                 | Migration, service, controller, and UI tests         |
|    14 | Context Inspector identity and accessibility               | Complete                                 | Vitest, axe/ARIA fixture, Phase 19                   |
|    15 | Governed-memory administration UX                          | Complete                                 | API/web tests; Phase 19 lifecycle coverage           |
|    16 | Cross-surface assurance envelope and canaries              | Complete                                 | Core and destination tests; Phase 19 prepared states |
|    17 | One exact local final code matrix                          | Complete as executable gate              | `pnpm verify:meriv2-development`                     |
|    18 | Clean and upgrade database rehearsal                       | Complete as executable rehearsal         | Local PostgreSQL 16 + pgvector run                   |
|    19 | Authenticated browser/accessibility acceptance             | Complete as executable rehearsal         | Local Clerk/Chrome run                               |
|    20 | SOC 2 controls, alarms, rollout, and rollback              | Complete                                 | Operations synth/diff; operator walkthrough          |
|    21 | Trusted PR and release authorization                       | Complete as package                      | PR #679 + local evidence + independent reviews       |
|    22 | Migration, deployment, canary, backfill, and GA            | Complete as executable runbook/operators | Production change execution                          |

---

## Detailed phase conclusions

### Phases 0–2: authority, atomicity, and canonical truth

Covered development:

- server-to-server action authority and tool-secret enforcement;
- fail-closed tenant/private/ethical-wall behavior;
- candidate row locking and pending-state recheck;
- canonical memory, candidate decision, transition evidence, and exact projection obligation in one transaction;
- governed class, authority, scope, source, approval, temporal, conflict, legal-hold, and origin metadata on `memory_items`;
- candidate-to-canonical lineage and immediate v2 recall only after approval.

No remaining development gap was found.

### Phases 3–4: Settings and immutable shared truth

Covered development:

- user-private Settings writes remain owner-only and immediate;
- first-time firm/client files create independent-review proposals;
- existing firm/client edits create immutable correction proposals;
- pending proposals leave the active item unchanged;
- shared approval requires an independent reviewer;
- first-time catalog activation is insert-only and race-safe;
- correction, contradiction, duplicate, conflict, revoke, restore, and legal-hold behavior preserve history;
- stable Settings identities resolve to the active immutable descendant.

No remaining development gap was found.

### Phases 5–6: projection durability

Covered development:

- exact outbox identity, source version, canonical hash, idempotency key, lease, retry, stale-lease recovery, supersession, and dead letter;
- strict projector/embedding behavior outside database transactions;
- a separate worker stack with retained logs, least-privilege Titan access, alarms, encrypted alert actions, exact-SHA image identity, and a dark schedule;
- failed fast-path work remains durable and retryable.

No remaining development gap was found.

### Phases 7–9: truthful context and governed recall

Covered development:

- public packet IDs exist only after durable read-after-write verification;
- required persistence failure holds the applicable release boundary;
- Context Packet v2 supports exact global ceiling, tenant setting, surface, layers, token budget, persistence, sensitivity, health, exclusions, conflict, and effective-tenant evidence;
- shadow does not change model input;
- `governed_status` is authoritative across API, orchestrator, Workspace, Strategy, Steward, search, graph, and export consumers;
- terminal/noncontrolling records are suppressed consistently.

No remaining development gap was found.

### Phases 10–13: policy, backfill, grants, and candidate dispositions

Covered development:

- persisted policy draft/review/four-eyes/simulate/publish/retire/rollback lifecycle;
- exact policy pack/version/rule/decision/context hashes on proposal, approval, execution, and audit;
- tenant canary in addition to `off`, `shadow`, and fail-closed `enforce`;
- reversible hash-bound backfill with prepare, execute, verify, idempotency, quarantine, drift preservation, and rollback;
- standard client reviewers through explicit permissioned, reasoned, expiring grants without admin elevation;
- wall remains binding for administrators and grantees;
- proposer withdrawal and reviewer rejection are separate terminal events.

No remaining development gap was found.

### Phases 14–16: trustworthy user experience and generation

Covered development:

- unique Context Inspector IDs, correct ARIA relationships, keyboard operation, focus, live announcements, restricted aggregate-only exclusions, and responsive behavior;
- complete Governance Center read model and canonical mutation delegation;
- government-affairs operating frame, evidence plan, claim ledger, deterministic checks, hold/repair decision, envelope integrity, Context/policy binding, and destination revalidation;
- Chat, In-editor, Workspace standalone and multi-section generation, Strategy, Outreach, Steward, memo, district brief, and research surfaces;
- exact tenant and surface canaries with request-local isolation;
- low-risk parity and high-risk buffering before response, apply, persistence, or artifact creation.

No remaining development gap was found.

### Phases 17–19: local release evidence

Covered development:

- one repository-owned local matrix for locked install, five Prisma generations, required builds, formatting, static phase completeness, typechecks, tests, and MeriV2 evals;
- clean and current-main-equivalent PostgreSQL 16 + pgvector migration replay;
- Prisma validation/status/diff, forced RLS, actual application role, lifecycle, outbox, backfill, policy, and Context persistence rehearsal;
- four authenticated Clerk actors, real API/web processes, Chrome DevTools Protocol, four viewports, keyboard/focus/live-region/overflow/reduced-motion checks, and confidentiality scans;
- disposable runners explicitly select their test tenants.

No additional harness development is required. These commands still must be executed on the exact final SHA.

### Phases 20–22: controls and production execution

Covered development:

- bounded CloudWatch EMF metrics with only `Environment` as a dimension;
- read-only cross-tenant control monitor, encrypted alarm/OK actions, dashboard, and retained logs;
- isolated operations app that imports live resources and cannot deploy Compute/Data/Network/DNS;
- read-only AWS discovery and task-definition preparation;
- exact-SHA/digest migration and service deploy operator with automatic task-definition rollback;
- dark operations-stack deployer with post-deploy schedule verification;
- exact merge, build, migration, dark smoke, worker/monitor enablement, tenant/surface canary, backfill, stop, and rollback order.

No remaining release-automation development gap was found.

---

## What is intentionally not performed by this branch audit

The following are production/release actions, not missing development:

- running the local preflight on the final merge SHA;
- supplying dedicated Clerk test actors and prepared browser states;
- obtaining the four independent reviews;
- merging PR #679 into `main`;
- building and pushing exact-SHA ARM64 images;
- taking/verifying the production database snapshot;
- running the production migration task;
- updating ECS services;
- deploying the two operations stacks;
- enabling either EventBridge schedule;
- enabling an internal tenant or surface;
- publishing a production policy pack;
- running any tenant backfill;
- expanding to a design partner or general availability.

Those actions are fully specified and guarded, but they require explicit production authorization and operator credentials.

---

## Exact next steps

### Before merge

```bash
pnpm verify:meriv2-development
pnpm collect:meriv2-aws-context -- \
  --env dev \
  --profile capiro-dev \
  --region us-east-1 \
  --output .artifacts/meriv2-aws-context-dev.json
pnpm verify:meriv2-release -- \
  --ops-context .artifacts/meriv2-aws-context-dev.json \
  --profile capiro-dev
```

Require:

```text
MERIV2_RELEASE_SCRIPTS_OK
MERIV2_DEVELOPMENT_COMPLETENESS_OK
MERIV2_LOCAL_RELEASE_PREFLIGHT_OK
```

### After merge

Run the same release preflight on the exact merge SHA, build/push the five ARM64 images tagged with that SHA, then follow:

```text
docs/runbooks/meriv2-merge-and-aws-ship.md
```

The guarded AWS commands are:

```bash
pnpm prepare:meriv2-ecs-release -- --sha <merge-sha> ...
pnpm ship:meriv2-ecs-release -- --sha <merge-sha> ...
pnpm deploy:meriv2-operations-dark -- --sha <merge-sha> ...
```

The initial production state remains all-controls-dark. Tenant/surface activation and backfill occur only after dark smoke and operations monitoring are accepted.

---

## Final conclusion

The final review found development omissions and closed them rather than reclassifying them as operational work. At this point, **all development described by Phases 0–22 is covered**. The remaining work is to execute the committed local evidence matrix, complete independent review, merge the trusted PR, and run the guarded AWS rollout in the documented order.
