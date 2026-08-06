# Memory Review UX Phase 2 — Increment 3A Persistence Gate

## Status

Increment 3A is complete as a **fail-closed persistence gate and database-boundary hardening increment**. The executable Prisma/PostgreSQL acceptance marker has **not** been achieved in the available environment.

Phase 2 remains incomplete. Do not merge, deploy, apply production migrations, run production backfills, or enable production flags.

## Completed in this increment

### Database-boundary authorization

`create_memory_candidate_revision` now independently binds its explicit tenant and proposer arguments to the transaction-local context established by `PrismaService.withTenantUser`:

- `app.current_tenant` must equal `p_tenant_id`;
- `app.current_user` must equal `p_proposer_id`;
- `app.bypass_rls` must not be armed;
- a successor id must differ from its predecessor id;
- the API translates the bounded database denial codes without exposing tenant data.

This is required because the application database role bypasses PostgreSQL RLS and relies on the scoped Prisma transaction for normal tenant isolation.

### Tenant-bound lineage shape

The revision migration now enforces self-lineage within one tenant by using:

- a composite `(tenant_id, id)` unique key;
- composite revision-root, predecessor, and supersession foreign keys;
- exact named constraints shared with the Prisma relations;
- explicit `ON UPDATE NO ACTION` and `ON DELETE RESTRICT` actions;
- one-successor-per-predecessor uniqueness;
- root/revision-number uniqueness.

The target Prisma contract is **Prisma-modeled but SQL-enforced**:

- Prisma must model the four lineage columns, three tenant-bound self-relations, and the composite tenant/id key;
- every self-relation must map to the exact committed PostgreSQL constraint name and referential actions;
- lifecycle creation and mutation remain restricted to `create_memory_candidate_revision` under row locks;
- production code is prohibited from mutating lineage through generated Prisma delegates.

### Guarded schema reconciliation

Added:

- `apps/api/scripts/apply-memory-phase2-prisma-lineage-model.ts`
- `apps/api/scripts/lib/memory-phase2-persistence-contract.ts`
- `apps/api/scripts/verify-memory-phase2-persistence-contract.ts`
- focused mutation-control coverage for ownership, database context, concurrency indexes, unsafe delegate writes, tenant binding, constraint-name drift, and referential-action drift.

The transformer is idempotent and refuses ambiguous or partially applied schema input. It inserts the exact composite relations, constraint mappings, and referential actions required by the committed migration.

### Disposable persistence closeout harness

Added `apps/api/scripts/verify-memory-phase2-persistence-closeout.ts`. It requires two different, empty, local PostgreSQL databases whose names contain `memory_phase2`. It refuses any database with existing public tables.

When executed in a complete checkout, the harness performs:

1. static ownership and security contract verification;
2. Prisma validate and generate;
3. full clean migration deployment;
4. exact pre-Phase-2 upgrade baseline followed by both Phase 2 migrations;
5. transaction-context denial checks for cross-tenant, wrong-actor, and system-bypass calls;
6. two real concurrent successor attempts with exactly one winner;
7. lineage, reviewer-attribution, and one-successor assertions;
8. compatibility-route rejection for an unassigned reviewer and acceptance for the assigned reviewer;
9. active `memory_items` and `clio_memory` non-mutation checks.

The sole success marker is:

```text
MEMORY_PHASE2_PERSISTENCE_CLOSEOUT_COMPLETE
```

## Validation actually completed

- strict TypeScript compilation of the exact persistence contract helper: **PASS**;
- target transformer/runtime contract: **PASS**;
- transformer idempotence and partial-application refusal: **PASS**;
- tenant-bound composite relation and unique-key insertion: **PASS**;
- exact relation constraint-name and referential-action matching: **PASS**;
- five runtime drift controls covering action drift, constraint-name drift, and unsafe delegate mutation: **PASS**;
- unsafe Prisma delegate lineage mutation control: **PASS**;
- static review of disposable-database safeguards: **PASS**;
- post-change security review of tenant GUC binding and system-bypass rejection: **PASS**.

## Not executed or claimed

This environment does not provide `pnpm`, Docker, PostgreSQL, or `psql`. Therefore the following are **not** represented as passed:

- applying the guarded transformer to the full checked-out Prisma schema;
- Prisma format, validate, or generate;
- clean or upgrade migration replay;
- real PostgreSQL concurrency;
- real-role RLS behavior;
- full API Jest or monorepo typecheck;
- pinned Prettier;
- GitHub Actions.

A temporary branch-only workflow was attempted solely to apply the guarded schema replacement. GitHub reported `startup_failure`; the workflow file was immediately removed and made no schema, migration, deployment, or data change.

## Required execution in a complete checkout

```bash
cd apps/api

pnpm exec tsx scripts/apply-memory-phase2-prisma-lineage-model.ts
pnpm exec prisma format --schema prisma/schema.prisma
pnpm exec prisma validate --schema prisma/schema.prisma
pnpm exec prisma generate --schema prisma/schema.prisma

export MEMORY_PHASE2_CLEAN_DATABASE_URL='postgresql://.../capiro_memory_phase2_clean'
export MEMORY_PHASE2_UPGRADE_DATABASE_URL='postgresql://.../capiro_memory_phase2_upgrade'
pnpm exec tsx scripts/verify-memory-phase2-persistence-closeout.ts
```

Require the exact closeout marker and a clean diff review before Increment 3 is accepted.

## Next increment

Execute and repair the persistence closeout in a full checkout with two disposable local pgvector/PostgreSQL databases. Do not begin notifications or frontend work until the closeout marker is green and the reconciled Prisma schema is committed.
