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

The Governance Center API is administrator-only through `@Roles('user_admin')`; the existing role hierarchy also permits `capiro_admin`.

Every read:

- executes inside `withTenantUser`;
- uses authenticated tenant/effective-user context;
- applies tenant RLS;
- excludes ethical-wall-denied clients;
- re-evaluates canonical item read authorization;
- excludes another user's private `memory_items`, candidates, and `clio_memory`; and
- derives capabilities from server-owned facts.

The browser never supplies tenant, role, client scope, wall decision, grant, lifecycle state, approval identity, legal hold, or capability claims.

Restricted-client identity is withheld from item, transition, grant, and projection-health views. Private memory remains owner-only even for tenant administrators. A private Clio projection hidden by RLS is not retryable merely because its outbox row is tenant-visible; an unresolved Clio subject fails closed.

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

The item drawer exposes scope/client, class/authority, provenance, approvals, temporal validity, confidence, legal hold, retention, origin trace, immutable versions, conflict control, transition evidence, and projection state.

Unknown lifecycle or authority values render as `Unknown`, not raw internal slugs.

## Mutation ownership

The center composes existing canonical owners:

- candidate approval/rejection — `MemoryCandidateReviewService`;
- proposer withdrawal — `GovernedMemoryCandidateService`;
- correction/restore/contradiction — `ImmutableMemoryVersionService`;
- conflict resolution — `MemoryConflictService`;
- grants — `MemoryAccessGrantService`; and
- revocation/projection cleanup — `MemoryStoreService.forgetMemory`.

`MemoryGovernanceActionService` owns direct confirm, mark-stale, independent second-approval, and authorized projection-retry transactions. Revoke delegates to the canonical forget path.

Confirm, mark stale, and second approval reload and lock the tenant item, repeat authorization, update canonical columns, and append transition evidence atomically.

## Immutable-version review correction

Candidates with source kinds:

```text
memory_correction
memory_restore
memory_contradiction
```

are approved and rejected through `ImmutableMemoryVersionService`, never through generic canonical-upsert activation.

The server returns a controlled `candidateKind`. Immutable-version rejection requires a bounded reason. The web queue displays the type, collects the reason, and refreshes from the actual activation/rejection outcome.

## Actions and outcomes

The center supports approve, second approve, reject, withdraw, suggest correction, mark stale, confirm, revoke, restore as a new version, resolve conflicts, grant/revoke client access, and retry failed projection work.

Browser capabilities are display-only. Every endpoint repeats authorization. Mutations invalidate overview, category lists, detail, transitions, projection health, review queues, proposal history, and active-memory queries.

Success copy uses returned outcomes such as `pending_review`, `duplicate`, `already_stale`, `already_second_approved`, `projection_retry_queued`, and `already_retryable` rather than predicting success.

## Projection health and retry

The center reports pending, running, completed, failed, dead-letter, and superseded jobs from `memory_cleanup_outbox`.

Only `failed` and `dead_letter` jobs can be reopened. Pending/running jobs return an idempotent already-queued outcome; completed/superseded jobs are refused.

Retry:

- locks the outbox row;
- enforces private ownership and ethical walls;
- rechecks item read authorization when item-backed;
- resets operational retry fields transactionally;
- preserves prior attempts, operation, subject IDs, and a bounded error code in `AuditLog`; and
- exposes no browser-side job mutation.

Projection failure never changes canonical authority. The UI explicitly states that canonical memory remains authoritative while secondary projections are retained for retry or investigation.

Transition history uses immutable `memory_transition_audit.occurred_at`, not an invented `created_at` timestamp.

## Accessibility and responsive behavior

Item rows are keyboard-operable with Enter and Space and receive a visible focus outline. Tables use horizontal containment, tabs can scroll, cards reduce padding at narrow widths, and the detail drawer is capped to the viewport.

## Automated coverage

Phase 15 adds or extends tests for:

- exact release-switch parsing and prerequisites;
- dark-state reads with zero governed-table access;
- ethical-wall and private-owner filtering;
- immutable `occurred_at` ordering;
- administrator-only route metadata;
- controlled bucket/limit parsing and exact delegation;
- stale → active confirmation;
- active → stale transition with bounded evidence;
- canonical revocation and legal-hold refusal;
- independent second-approval segregation;
- authorized, audited projection retry;
- restricted-client/private-Clio/terminal-job retry refusal;
- immutable candidate-kind routing and required version rejection reason;
- Governance Center browser visibility and controlled action payloads;
- keyboard activation and narrow-width CSS;
- projection retry through an API route only; and
- human-readable status/authority labels.

The permanent `memory-governance-ci` workflow is extended through Phase 15.

## Acceptance gate

Phase 15 passes only when one exact synchronized head proves:

- all five Prisma clients generate;
- clean migration replay passes;
- full repository typecheck passes;
- API and web production builds pass;
- focused API/web matrices pass;
- inherited Phase 1–14 cumulative gates remain passing;
- Prettier and `git diff --check` pass;
- working tree is clean; and
- PR #679 remains draft, open, mergeable, synchronized with `main`, and unmerged.

A manual UI pass must verify center-off fallback, standard-user denial, all nine views, complete item detail, server-capability actions, version rejection reason, grant history refresh, failed projection visibility/retry, keyboard navigation, and narrow-width usability.

## Rollback

Set:

```text
MEMORY_GOVERNANCE_CENTER=off
```

This immediately restores the pre-Phase-15 queue experience. It does not disable governed memory and does not alter candidates, items, versions, grants, transition evidence, conflicts, or projection jobs.

Phase 15 adds no migration. Do not delete grants, rewrite lifecycle status, reopen terminal candidates, remove evidence, or mutate jobs as a UI rollback mechanism.

## Production boundary

Phase 15 does not authorize merge, AWS deployment, migration, flag activation, grant creation, real memory decisions, customer-data mutation, secret retrieval, external send, or production rollout.
