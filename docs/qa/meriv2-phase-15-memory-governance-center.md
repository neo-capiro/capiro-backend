# MeriV2 Phase 15 — Memory Governance Center

## Status

**Implemented; exact-head focused and cumulative validation pending.**

Phase 15 consolidates governed-memory administration into one Settings → Memory center without creating a second canonical writer.

## Release boundary

The center is dark unless all three server-owned controls are exact:

```text
MEMORY_GOVERNANCE_CENTER=enforce
MEMORY_GOVERNANCE_LIFECYCLE=enforce
MEMORY_GOVERNANCE_ENFORCE=enforce
```

Truthy-looking values do not arm it. A code deploy does not expose the center.

While the center is off or unavailable, `MemoryGovernanceCenterHost` preserves the existing proposer and reviewer queues. Standard users always retain those owner/grant-scoped surfaces and never receive the administration read model.

## Access and confidentiality

The Governance Center API is administrator-only through `@Roles('user_admin')`.

Every read:

- executes inside `withTenantUser`;
- uses the authenticated tenant and effective user from server context;
- applies tenant RLS;
- excludes clients denied by the ethical wall;
- re-evaluates item read authorization before returning an item; and
- derives action capabilities from canonical server facts.

The browser never supplies tenant, role, client scope, wall decision, grant, lifecycle state, approval identity, legal hold, or capability claims.

Restricted-client identity is withheld from item, transition, grant, and projection-health views. Private memory remains owner-only even for tenant administrators.

## Administration views

The center provides:

- Overview counts;
- Active memory;
- Pending review and proposer withdrawal;
- Conflicts;
- Review-due/stale memory;
- Revoked and superseded history;
- Access-grant history and management;
- Transition history; and
- Projection/outbox health.

The item detail drawer exposes:

- scope and client;
- class and authority;
- status and review state;
- confidence;
- provenance and source references;
- approval identities and timestamps;
- temporal validity and review cadence;
- legal hold and retention metadata;
- origin surface, trace, packet, model, and prompt version;
- immutable version lineage;
- conflict members and controlling item;
- transition evidence; and
- projection obligations and failures.

Unknown lifecycle or authority values render as `Unknown`, not raw internal slugs.

## Mutation ownership

The center does not duplicate existing lifecycle writers.

Existing canonical owners remain responsible for:

- candidate approval/rejection — `MemoryCandidateReviewService`;
- proposer withdrawal — `GovernedMemoryCandidateService`;
- correction/restore/contradiction — `ImmutableMemoryVersionService`;
- conflict resolution — `MemoryConflictService`;
- access grants — `MemoryAccessGrantService`; and
- revocation/projection cleanup — `MemoryStoreService.forgetMemory`.

`MemoryGovernanceActionService` owns only direct item actions that previously lacked a complete administration route:

- confirm;
- mark stale; and
- independent second approval.

It also exposes revoke by delegating to the canonical forget path.

Confirm, mark stale, and second approval reload and lock the exact tenant item, re-evaluate authorization inside the transaction, update canonical columns, and append transition evidence atomically.

## Immutable-version review correction

Phase 15 closes an inherited review-routing defect. Candidates with source kinds:

```text
memory_correction
memory_restore
memory_contradiction
```

are now approved and rejected through `ImmutableMemoryVersionService`, never through generic candidate canonical-upsert activation.

The server returns a controlled `candidateKind`. Immutable version rejection requires a bounded reason. The web queue displays the candidate type, collects the reason, and refreshes from the actual server outcome.

## Actions and outcomes

The center supports:

- approve;
- second approve;
- reject;
- withdraw;
- suggest correction;
- mark stale;
- confirm;
- revoke;
- restore as a new version;
- resolve conflicts; and
- create, replace, review, and revoke client grants.

Browser capabilities are display-only. Every endpoint repeats authorization. After every mutation, the UI invalidates overview, category lists, detail, transitions, projection health, review queues, proposal history, and active memory queries.

The success message uses the returned outcome, including `pending_review`, `duplicate`, `already_stale`, and `already_second_approved`, rather than claiming a predicted result.

## Projection health

The center shows status counts and recent failed/dead-letter jobs from `memory_cleanup_outbox`.

Projection failure does not change canonical authority. The UI states that canonical memory remains authoritative while secondary projection work is retained for retry or investigation.

Transition history uses immutable `memory_transition_audit.occurred_at`; it does not invent or substitute a `created_at` timestamp.

## Automated coverage

Phase 15 adds or extends tests for:

- exact release-switch parsing and prerequisites;
- dark-state reads with zero governed-table access;
- ethical-wall filtering contract and `occurred_at` evidence ordering;
- administrator-only route metadata;
- controlled bucket and limit parsing;
- exact controller delegation;
- stale → active confirmation with evidence;
- active → stale transition with bounded reason;
- canonical revocation delegation and legal-hold refusal;
- independent second-approval segregation;
- immutable candidate-kind mapping;
- generic versus immutable candidate routing;
- required immutable rejection reason;
- Governance Center browser visibility;
- controlled tab-to-bucket mapping;
- browser action payloads without authority claims;
- human-readable status and authority labels; and
- immutable review UI affordances.

The permanent `memory-governance-ci` workflow is extended through Phase 15.

## Acceptance gate

Phase 15 passes only when one exact synchronized head proves:

- all five Prisma clients generate;
- clean migration replay passes;
- full repository typecheck passes;
- API and web production builds pass;
- the Phase 15 API and web focused matrices pass;
- inherited Phase 1–14 cumulative gates remain passing;
- Prettier and `git diff --check` pass;
- the working tree is clean; and
- PR #679 remains draft, open, mergeable, synchronized with `main`, and unmerged.

A manual UI pass must verify:

- center-off fallback preserves existing queues;
- standard users do not receive the center;
- all nine center views render;
- an item drawer shows the required governance metadata;
- action buttons match server capabilities;
- version rejection requires a reason;
- grant create/revoke refreshes real history; and
- projection failures do not read as canonical-memory failure.

## Rollback

Set:

```text
MEMORY_GOVERNANCE_CENTER=off
```

This immediately restores the pre-Phase-15 queue experience. It does not disable governed memory itself and does not alter candidates, items, versions, grants, transition evidence, conflicts, or projection jobs.

Application rollback may leave no schema residue because Phase 15 adds no migration.

Do not delete grants, rewrite lifecycle status, reopen terminal candidates, remove transition evidence, or mutate projection jobs as a UI rollback mechanism.

## Production boundary

Phase 15 does not authorize merge, AWS deployment, migration, feature activation, grant creation, real candidate/item mutation, customer-data change, secret retrieval, external send, or production rollout.
