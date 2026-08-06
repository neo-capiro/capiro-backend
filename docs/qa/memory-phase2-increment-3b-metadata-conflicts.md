# Memory Review UX Phase 2 — Increment 3B: Workflow Metadata and Conflict Integrity

## Status

Increment 3B is complete in the available environment. It strengthens the database-boundary contract while the executable PostgreSQL/Prisma persistence marker remains open.

This increment does not authorize merge, deployment, migration application, backfill execution, or production flag changes.

## Scope completed

### Body-free workflow display metadata

The Phase 2 workflow migration now derives review display metadata through three pure SQL helpers:

- `memory_review_workflow_title(payload_jsonb)`
- `memory_review_workflow_candidate_kind(source_kind)`
- `memory_review_workflow_metadata(source_kind, scope, assignment_enforced)`

The title helper:

- prefers `canonicalItem.title`;
- falls back to the stable candidate `key`;
- normalizes whitespace and control characters;
- falls back to `Memory proposal`;
- is bounded to 300 characters;
- never reads `value`, section bodies, source excerpts, or other proposed-memory content.

The metadata helper persists only:

- workflow version;
- schema version;
- candidate kind;
- source kind;
- scope;
- assignment-enforcement state.

Proposal bodies remain exclusively in `memory_candidate.payload_jsonb`.

### Backfill and partial-application consistency

Both existing pending shared candidates and future trigger-created candidates now receive the same title and candidate-kind vocabulary.

An idempotent reconciliation statement repairs pending workflow rows created by a prior partial or interrupted migration attempt. It preserves:

- tenant and subject identity;
- assignment;
- decision state;
- reviewer feedback;
- extension metadata;
- assignment-enforcement state.

The reconciliation joins `review_request` to `memory_candidate` on both tenant and candidate identity.

### Deterministic revision conflicts

The immutable revision function now returns a stable successor conflict to a legitimate proposer retry after a concurrent revision wins.

The order is enforced as:

1. bind tenant and actor transaction context;
2. lock the predecessor candidate;
3. require the original proposer;
4. detect a durable successor;
5. then evaluate the predecessor's generic terminal state.

This preserves deterministic retry semantics without disclosing successor existence to another tenant member.

The database unique index remains the final one-successor concurrency boundary, and the API continues translating `MEMORY_REVISION_SUCCESSOR_EXISTS` to a stable `ConflictException`.

## Security review findings repaired

### Finding 1 — incomplete trigger-created workflow metadata

Trigger-created and migration-backfilled review rows previously used the generic title `Memory proposal` and did not include `candidateKind`. Application-created rows had richer metadata, creating divergent behavior for inboxes and future notifications.

**Repair:** one body-free SQL derivation contract now serves backfill, reconciliation, and future trigger creation.

### Finding 2 — ambiguous concurrent-revision result

A losing concurrent revision could observe the predecessor as superseded and receive only the generic `PREDECESSOR_NOT_PENDING` response.

**Repair:** after acquiring the predecessor lock, a legitimate proposer retry checks for the durable successor before the generic terminal-state check.

### Finding 3 — successor-existence disclosure

The first deterministic-conflict ordering checked for a successor before verifying that the actor was the original proposer. A direct SQL caller with tenant context could potentially distinguish whether a successor existed.

**Repair:** original-proposer validation now occurs before the successor query. The executable persistence contract rejects any future ordering regression.

## Files changed

- `apps/api/prisma/migrations/20260818010000_memory_phase2_review_workflow_foundation/migration.sql`
- `apps/api/prisma/migrations/20260818020000_memory_phase2_revision_lineage/migration.sql`
- `apps/api/scripts/lib/memory-phase2-persistence-contract.ts`
- `apps/api/scripts/lib/memory-phase2-workflow-metadata-contract.spec.ts`
- `apps/api/scripts/lib/memory-phase2-revision-conflict-contract.spec.ts`

## Validation completed

Passed in the available environment:

- strict isolated TypeScript for the updated persistence contract;
- strict isolated TypeScript for both new focused specifications;
- 17 focused static/runtime contract probes;
- body-free title and metadata-key checks;
- title-length and normalization contract checks;
- immutable candidate-kind mapping checks;
- partial-application reconciliation checks;
- mutation controls for body-derived titles and body-bearing workflow metadata;
- predecessor-lock, proposer-validation, successor-conflict, and terminal-state ordering checks;
- database uniqueness-boundary and API conflict-translation checks;
- post-publication migration diff review for idempotence, body isolation, concurrency, and tenant-safe ordering.

A first local test invocation used an incompatible temporary TypeScript module mode for `import.meta`; it was rerun with ES modules and Bundler resolution and passed. This was a temporary harness configuration issue, not a repository-code failure.

## Gates not claimed

The following were not executable in this environment and remain open:

- applying the guarded Prisma lineage transformer to the complete schema;
- Prisma format, validate, and generate;
- clean and upgrade PostgreSQL migration replay;
- live verification of the SQL title helpers and reconciliation statement;
- real concurrent successor transactions;
- real-role RLS and ethical-wall tests;
- full API Jest and monorepo test/typecheck suites;
- pinned repository formatting;
- web build, Vitest, and authenticated browser acceptance;
- GitHub Actions.

The required persistence marker remains:

```text
MEMORY_PHASE2_PERSISTENCE_CLOSEOUT_COMPLETE
```

## Next increment

Run and repair the existing persistence closeout in a complete checkout with two different empty local pgvector/PostgreSQL databases. Commit the reconciled Prisma schema only after Prisma format, validate, generate, clean migration replay, upgrade migration replay, concurrency, compatibility-route, active-memory, and real-role isolation gates pass.

Do not begin reviewer notifications or frontend inbox work before that marker is green.
