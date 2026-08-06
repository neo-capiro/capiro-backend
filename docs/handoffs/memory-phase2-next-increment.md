# Memory Review UX Phase 2 — Next Increment

Execute and close the revision persistence gate before beginning notifications or the Review Inbox redesign.

## Required execution

From a complete checkout:

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

The database URLs must identify two different, empty, local PostgreSQL/pgvector databases whose names contain `memory_phase2`. The closeout refuses databases with existing public tables.

## Required outcomes

1. Commit the transformer-produced Prisma model and migration ownership comment.
2. Pass Prisma format, validate, and generate without drift.
3. Pass clean and exact pre-Phase-2 upgrade migration deployment.
4. Prove exactly one concurrent successor is created.
5. Prove cross-tenant, wrong-actor, and system-bypass revision calls are denied at the database boundary.
6. Preserve the original reviewer’s attribution through proposer supersession.
7. Prove an unassigned compatibility route cannot decide a successor and the assigned reviewer can.
8. Prove revision does not mutate `memory_items` or `clio_memory`.
9. Require the exact marker:

```text
MEMORY_PHASE2_PERSISTENCE_CLOSEOUT_COMPLETE
```

After the marker, inspect the exact diff, run focused/full repository tests available in that checkout, update PR #761 evidence, and only then begin notification work.
