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
7. Legal-held rows cannot be revoked or superseded, including through an unknown future code path.
8. The generic candidate approval path is database-blocked for correction, restore, and contradiction candidates.

## Live routing

`MemoryModule` provides `GovernedMemoryStoreService` under the existing
`MemoryStoreService` token. Therefore the existing Meri `correct_memory` tool uses the
reviewed lifecycle without changing its dependency graph.

When `MEMORY_GOVERNANCE_LIFECYCLE` is not `enforce`, the inherited legacy implementation
remains the rollback path. When armed, a shared `correct_memory` call returns an honest
HTTP 202 payload with `status=pending_review`, the candidate ID, and
`activeItemUnchanged=true`.

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

- a validated payload constraint for typed version candidates;
- a trigger requiring the transaction-local immutable-activation capability before a
  version candidate can become approved/auto-committed;
- a legal-hold terminal-transition trigger.

The migration is committed but was not executed by this phase.

## Regression evidence

Automated tests added:

- `memory-version.helpers.spec.ts`
- `immutable-memory-version.service.spec.ts`
- `migration-memory-immutable-versions.spec.ts`

They cover:

- shared correction pending while the active item stays unchanged;
- approved correction inserts a new ID and supersedes exactly one prior version;
- rejected correction writes no memory version;
- restore creates a new ID and never reactivates the historical row;
- duplicate linking without a second active truth;
- contradiction conflict retention;
- legal-hold denial;
- migration bypass guards.

GitHub Actions results for the exact final Phase 4 SHA must be recorded in PR #679 before
this phase is marked green.

## Rollback

1. Set `MEMORY_GOVERNANCE_LIFECYCLE=off` for affected tenants/surfaces. Existing
   `MemoryStoreService.correctMemory()` behavior becomes the application fallback and the
   dedicated version routes return 503.
2. Do not delete pending correction/restore candidates or immutable history.
3. If the new code is defective, deploy the prior application image while leaving the
   additive migration and audit rows intact.
4. Do not reopen terminal rows, rewrite public branch history, or hand-edit controlling
   memory in production.
