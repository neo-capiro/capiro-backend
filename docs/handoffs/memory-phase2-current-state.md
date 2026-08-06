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

### Increment 3B — workflow metadata and conflict integrity

- normalized body-free workflow titles for backfills and future trigger-created rows;
- canonical candidate-kind metadata for standard, correction, restore, and contradiction proposals;
- idempotent tenant-bound reconciliation for partial migration application;
- executable contract controls that reject title or metadata body leakage;
- deterministic successor-conflict behavior for legitimate concurrent-revision retries;
- original-proposer validation before successor-existence checks;
- stable API conflict translation protected by the persistence contract.

Evidence: `docs/qa/memory-phase2-increment-3b-metadata-conflicts.md`.

### Increment 3C — persistence closeout runner portability

- removed direct `pnpm.cmd` spawning from the Windows closeout path;
- prefers Node + Corepack and uses a deliberate Windows shell fallback only when required;
- added a bounded 64 MB process-output buffer;
- redacts database URLs and other secret-bearing environment values from diagnostics;
- distinguishes startup errors, exit failures, and terminating signals;
- added helper regression tests and an integration contract pinning the portable runner;
- preserved every existing Prisma, migration, concurrency, tenant-context, compatibility-route, and active-memory assertion.

Evidence: `docs/qa/memory-phase2-increment-3c-closeout-runner-portability.md`.

## Validation completed in the available environment

- strict isolated TypeScript for the persistence contract, closeout runner, portable command helper, and focused specifications;
- target transformer and runtime contract;
- schema and migration-transformer idempotence;
- partial-application and drift refusal;
- composite tenant relation, constraint-name, and referential-action controls;
- tenant-context and system-bypass security review;
- body-free workflow title and metadata mutation controls;
- candidate-kind vocabulary and reconciliation controls;
- predecessor lock, proposer validation, successor conflict, and terminal-state ordering controls;
- database uniqueness-boundary and API conflict-translation checks;
- disposable-database harness safety review;
- Windows/Corepack resolution, bounded-output, credential-redaction, and startup-error probes;
- post-publication diff review.

## Persistence gate still open

The current environment has no complete repository checkout with `pnpm`, Docker, PostgreSQL, and `psql`. The checked-in Prisma schema has therefore not been rewritten and validated through the full repository toolchain, and the executable PostgreSQL closeout has not run.

The executable persistence marker has **not** been achieved. The branch intentionally remains fail-closed until a full checkout runs the guarded transformer, commits the resulting Prisma schema, and passes:

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

On Windows, the closeout now resolves Node-adjacent Corepack automatically. `CAPIRO_COREPACK_PNPM_JS` may be set to an absolute `pnpm.js` path when an unusual Node installation cannot be discovered automatically.

Do not begin notifications or frontend work until this gate is green.
