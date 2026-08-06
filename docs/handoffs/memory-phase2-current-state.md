# Memory Review UX Phase 2 — Current State

## Branch and pull request

- Branch: `feat/memory-phase2-review-workflow`
- Draft PR: `#761`
- Base: `main@af9ef9d2b6bf08f08b548d8a7807337fc24d038d`
- Keep the PR draft; do not merge or deploy.

## Completed increments

### Increment 1 — durable review workflow foundation

- body-free workflow obligations;
- dark-rollout-compatible named assignment;
- request-changes and required reasons;
- ethical-wall-aware reassignment;
- assigned-reviewer enforcement after Phase 2 activates assignment.

Evidence: `docs/qa/memory-phase2-increment-1-foundation.md`.

### Increment 2 — immutable revision and resubmission lineage

- proposer-only immutable successor creation after `changes_requested`;
- root/predecessor/revision lineage and one-successor concurrency guards;
- atomic predecessor and workflow supersession;
- fresh authorization before and after successor creation;
- fresh reviewer assignment and no active-memory mutation.

Evidence: `docs/qa/memory-phase2-increment-2-revision-lineage.md`.

### Increment 3A — persistence gate and database-boundary hardening

- revision SQL bound to `app.current_tenant` and `app.current_user`;
- system-bypass revision calls denied;
- tenant-bound composite lineage foreign keys and unique key;
- exact Prisma/PostgreSQL constraint-name mapping;
- explicit matching `ON UPDATE NO ACTION` and `ON DELETE RESTRICT` behavior;
- target ownership contract changed to Prisma-modeled but SQL-enforced;
- guarded idempotent schema and migration-ownership transformers;
- executable clean/upgrade PostgreSQL, concurrency, compatibility-route, and active-memory closeout harness;
- disposable-database refusal safeguards.

Evidence: `docs/qa/memory-phase2-increment-3-persistence-gate.md`.

## Validation completed in the available environment

- strict isolated TypeScript for the exact persistence contract helper;
- target transformer and runtime contract;
- schema and migration-transformer idempotence;
- partial-application and drift refusal;
- composite tenant relation, constraint-name, and referential-action controls;
- five runtime negative controls for action drift, name drift, and unsafe Prisma mutation;
- tenant-context and system-bypass security review;
- disposable-database harness safety review.

## Persistence gate still open

The current environment has no `pnpm`, Docker, PostgreSQL, or `psql`. The checked-in Prisma schema could not be rewritten safely through the connector, and GitHub Actions returned `startup_failure` for a temporary guarded patch workflow. The workflow was removed and made no product or data change.

The executable persistence marker has therefore **not** been achieved. The branch intentionally remains fail-closed until a full checkout runs the guarded transformer, commits the resulting Prisma schema, and passes:

```text
MEMORY_PHASE2_PERSISTENCE_CLOSEOUT_COMPLETE
```

## Phase 2 is not complete

Still required:

- execute and repair the persistence closeout;
- commit the reconciled Prisma schema;
- notifications and email obligations;
- Review Inbox and proposer-history UX;
- compatibility-route closeout;
- full API/monorepo tests, typecheck, pinned formatting, real-role RLS, web build/Vitest, and browser acceptance.

## Next increment

In a complete checkout:

1. run `pnpm exec tsx scripts/apply-memory-phase2-prisma-lineage-model.ts` from `apps/api`;
2. run Prisma format, validate, and generate;
3. review the generated relation constraints and confirm no schema drift;
4. provide two different empty local pgvector/PostgreSQL databases named with `memory_phase2`;
5. run `scripts/verify-memory-phase2-persistence-closeout.ts`;
6. repair every failure and require the exact completion marker;
7. review and commit the resulting schema/migration diff.

Do not begin notifications or frontend work until this gate is green.
