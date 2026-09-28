# Canonical memory PostgreSQL qualification report

## Scope

Target source: `df679a1ba775629f829fe02ab0762e2f4c9327e7` on `codex/meri-memory-postgres`.

This change adds only:

- a focused PostgreSQL qualification spec for the production `InstitutionalKnowledgeRetrievalAdapter`, production `Prisma.sql`, real `PrismaClient`, and `PrismaService.withTenantUser` transaction wrapper;
- a localhost-only disposable database/role/schema harness and its README;
- a pull-request/manual GitHub Actions job backed by `pgvector/pgvector:pg16`;
- this evidence report.

No adapter algorithm, migration SQL, Prisma schema, production workflow, deploy path, IAM, routing, provider, cloud, or remote database was changed.

## Fixture boundary

The harness creates a uniquely named `meri_memory_qualification_*` database owned by a generated NOLOGIN role and a separate LOGIN app role. The app role is asserted at runtime to be `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`, `NOBYPASSRLS`, non-replicating, and not a member of the owner role. All test relations and extensions are installed in `memory_qualification`, never `public`.

`tenants`, `users`, and `clients` are deliberately minimal parent fixtures. This is not a full migration replay. The adapter-relevant final shapes for `client_memory_access`, `memory_items`, `context_embeddings`, governance checks/indexes, current owner/expiry/wall RLS, and the 1024-dimensional HNSW vector column are sourced from the migrations enumerated by `DDL_PROVENANCE` in `apps/api/test/memory-postgres-qualification/harness.ts`.

Both accepted database inputs are fail-closed to loopback hosts. The native credentials file is read in-process and was never printed. Every local run created a fresh database and generated roles, then cleanup verification found zero remaining qualification databases and roles.

## Direct execution evidence

All commands ran from `C:/dev/cap-meri-fixture-hardening`. No dependency install or network access was used.

### DB-free review guard

Command:

    MEMORY_POSTGRES_DB_FREE=1 pnpm --filter @capiro/api exec jest --ci --runInBand --runTestsByPath src/retrieval/adapters/institutional-knowledge-retrieval.adapter.postgres.spec.ts

Exit: `0`.

Observed: `MEMORY_POSTGRES_DATABASE NOT_RUN mode=DB_FREE`; 1 static/guard test passed and 9 database tests were skipped. The guard checks the minimal-parent/canonical-relation manifest, relevant migration provenance, non-public schema, rejection of non-loopback targets, and the dedicated workflow's PR/manual trigger, pgvector service, frozen-lock install, localhost target, required-vector flag, and absence of deploy/AWS actions.

### Native PostgreSQL 16, non-vector qualification

Command:

    MEMORY_POSTGRES_CREDENTIALS_FILE=C:/dev/cap-meri-foundation-evidence/private/local-postgres.json pnpm --filter @capiro/api exec jest --ci --runInBand --runTestsByPath src/retrieval/adapters/institutional-knowledge-retrieval.adapter.postgres.spec.ts

Exit: `0`.

Observed: `MEMORY_POSTGRES_VECTOR NOT_RUN reason=extension_unavailable nonvector=RUN`; suite 1 passed, 10 registered tests passed.

Executed assertions covered the generated least-privilege app role, production `SET LOCAL` tenant/user GUCs, fail-closed RLS outside the wrapper, governed eligibility, tenant/private/client walls, grant deletion, canonical revocation and cursor restart, and 1023-dimensional/non-finite provider vectors degrading to a fresh lexical read without poisoning fallback.

The five pgvector-only test bodies return before vector setup when `vectorAvailable` is false. Their registered Jest names therefore appear in the passing suite, but they are explicitly **NOT semantic PASS**; the marker above is authoritative.

### Missing-extension CI guard negative control

Command:

    MEMORY_POSTGRES_CREDENTIALS_FILE=C:/dev/cap-meri-foundation-evidence/private/local-postgres.json MEMORY_POSTGRES_REQUIRE_VECTOR=1 pnpm --filter @capiro/api exec jest --ci --runInBand --runTestsByPath src/retrieval/adapters/institutional-knowledge-retrieval.adapter.postgres.spec.ts

Exit: `1`, expected.

Observed failure: `required pgvector extension is unavailable`. This is the same flag set by the GitHub Actions database step, so a service image without the extension cannot produce a green qualification job.

### Focused static verification

Command:

    pnpm --filter @capiro/api exec tsc --noEmit --module Node16 --moduleResolution Node16 --target ES2022 --lib ES2022 --esModuleInterop --skipLibCheck --strictNullChecks --noImplicitAny --experimentalDecorators --emitDecoratorMetadata --types node,jest src/retrieval/adapters/institutional-knowledge-retrieval.adapter.postgres.spec.ts test/memory-postgres-qualification/harness.ts

Exit: `0`.

Command:

    pnpm exec prettier --check .github/workflows/memory-postgres-qualification.yml apps/api/src/retrieval/adapters/institutional-knowledge-retrieval.adapter.postgres.spec.ts apps/api/test/memory-postgres-qualification/harness.ts apps/api/test/memory-postgres-qualification/README.md

Exit: `0`; all matched files use Prettier style.

Cleanup readback command used the private credentials in-process against asserted `127.0.0.1:55433` and queried only catalog counts. Exit: `0`; observed `MEMORY_POSTGRES_CLEANUP databases=0 roles=0`.

### Repository-wide commands

These required root commands were attempted without installing dependencies, as required by the task:

- `pnpm run test` — exit `1`: unrelated workspace packages have missing local executables/node_modules (`jest` first surfaced in infra/auth tasks).
- `pnpm run lint` — exit `1`: unrelated workspace packages have no local `eslint` executable/node_modules.
- `pnpm run typecheck` — exit `1`: unrelated workspace packages have missing Nest/Express/Clerk types; the API stage also has pre-existing business-development spec errors.
- `pnpm run build` — exit `1`: unrelated workspace packages have no local `nest` executable/node_modules.

No install was attempted. The focused Jest, TypeScript, formatting, PostgreSQL, and cleanup checks above are the applicable verification for this change.

## Semantic qualification status

`NOT_RUN` locally because native PostgreSQL 16 at `127.0.0.1:55433` does not provide pgvector. The GitHub Actions job was not run from this unpushed branch.

The dedicated pgvector job is configured to execute, without mocked vector operators:

- genuine 1024-dimensional vectors, exact current-model/source/tenant correlation, two models, stale projection hash/text versus canonical document body version and provenance;
- an old unembedded lexical hit after 1,000 embedded distractors;
- a semantic-only hit alongside 501 sparse rows whose semantic score/rank projections are SQL `NULL`;
- a real vector-dimension operator error, observed aborted transaction state, rollback, and recovery in a fresh production transaction;
- a real semantic SQL permission failure followed by lexical fallback in a fresh transaction.

No semantic PASS is claimed until this job, or the same harness against a real loopback PostgreSQL 16 with pgvector, completes with `MEMORY_POSTGRES_VECTOR RUN engine=postgresql extension=vector dimensions=1024` and exit `0`.
