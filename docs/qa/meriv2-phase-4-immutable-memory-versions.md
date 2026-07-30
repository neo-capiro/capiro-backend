# MeriV2 Phase 4 — Immutable Memory Versions

## Scope

Phase 4 closes shared correction and restore paths only. It does not merge, deploy,
apply a migration, enable a production flag, execute a backfill, or alter customer data.

Implementation branch: `agent/meriv2-world-class-closeout`  
Pull request: `#679`

## Invariants implemented

1. Private corrections create a new active row and supersede the prior row in one transaction.
2. Firm/client corrections create `memory_candidate` proposals and leave the controlling item unchanged.
3. Restore never reopens a revoked or superseded row; it creates a new immutable row referencing history.
4. Exact duplicate content confirms and links the controlling row without another `memory_items` insert.
5. Explicit contradictions retain both versions in one open conflict group.
6. Shared approval is independently authorized, row-locked, and atomic with versioning, audit, lineage, and cleanup-outbox intent.
7. Legal-held rows cannot be revoked or superseded, and derivative immutable versions inherit the hold.
8. The generic candidate approval path is database-blocked for correction, restore, and contradiction candidates.
9. Approval is bound to the exact target reviewed at proposal time; a changed controlling version invalidates the activation.
10. Resolved losing conflict members and unresolved conflict members cannot be superseded as controlling truth.
11. Expired durable restores clear stale validity/expiry dates; expired episodic working memory requires a new TTL.
12. Immutable slugs retain the complete UUID identity suffix even when the source slug is already at the 200-character limit.

## Live routing

`MemoryModule` provides `GovernedMemoryStoreService` under the existing
`MemoryStoreService` token. Therefore the existing Meri `correct_memory` tool uses the
reviewed lifecycle without changing its memory-store dependency graph.

`MeriModule` wraps the existing `MeriToolsService` instance with a narrow governed-memory
adapter. When `MEMORY_GOVERNANCE_LIFECYCLE` is armed:

- a shared correction returns `pending_review`, the candidate ID, and
  `activeItemUnchanged=true` as a successful tool result;
- an exact duplicate returns `duplicate` and does not claim a new version was created;
- unrelated tools and failures preserve the original `MeriToolsService` behavior.

When the lifecycle flag is not `enforce`, the inherited legacy correction implementation
remains the rollback path.

Dedicated routes:

- `POST /memory/items/:id/corrections`
- `POST /memory/items/:id/restores`
- `POST /memory/items/:id/contradictions`
- `POST /memory/version-candidates/:id/approve`
- `POST /memory/version-candidates/:id/reject`

The dedicated decision routes intentionally do not call the generic candidate approval
handler.

## Schema and migration

Migration: `20260812010000_memory_immutable_versions`

It adds no Prisma-modeled columns or tables. It adds:

- a validated, source-kind-matched payload constraint for typed version candidates;
- an immutable-version insert guard that binds candidate target lineage, enforces the
  controlling-version rule, carries legal holds forward, and prevents invisible expired restores;
- a candidate-activation guard requiring the transaction-local immutable capability and
  normalizing duplicate/conflict candidate metadata;
- a legal-hold terminal-transition trigger;
- a noncontrolling-conflict supersession guard.

The migration is committed but was not executed by this phase. Actual PostgreSQL replay and
RLS/trigger rehearsal remain Phase 18 release work.

## Regression evidence

Automated tests added or expanded:

- `memory-version.helpers.spec.ts`
- `immutable-memory-version.service.spec.ts`
- `migration-memory-immutable-versions.spec.ts`
- `governed-meri-tools.proxy.spec.ts`
- `memory-candidate.atomicity.spec.ts`

They cover:

- shared correction pending while the active item stays unchanged;
- approved correction inserts a new ID and supersedes exactly one prior version;
- rejected correction writes no memory version;
- restore creates a new ID and never reactivates the historical row;
- duplicate linking without a second active truth;
- contradiction conflict retention;
- legal-hold denial and inheritance guards;
- reviewed-target drift and controlling-version database guards;
- expired-restore protections;
- long-slug identity preservation;
- truthful Meri pending-review and duplicate outcomes;
- generic approval bypass guards.

GitHub Actions results for the exact final Phase 4 SHA must be recorded in PR #679 before
this phase is marked green.

## Explicit downstream boundary

Phase 4 creates canonical `memory_items` versions and durable cleanup intent for superseded
projections. The scheduled, strict forward projection/index worker and exact-version completion
semantics are Phase 5–6 work; this phase must not be represented as completing those later gates.

## Rollback

1. Set `MEMORY_GOVERNANCE_LIFECYCLE=off` for affected tenants/surfaces. Existing
   `MemoryStoreService.correctMemory()` behavior becomes the application fallback and the
   dedicated version routes return 503.
2. Do not delete pending correction/restore candidates or immutable history.
3. If the new code is defective, deploy the prior application image while leaving the
   additive migration and audit rows intact.
4. Do not reopen terminal rows, rewrite public branch history, or hand-edit controlling
   memory in production.
