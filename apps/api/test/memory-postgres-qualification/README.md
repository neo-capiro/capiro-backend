# Canonical memory PostgreSQL qualification

This focused harness executes `InstitutionalKnowledgeRetrievalAdapter` against PostgreSQL 16 through the production `PrismaService.withTenantUser` interactive-transaction wrapper. The adapter builds its normal `Prisma.sql`; no SQL text is copied into a fake query bridge and no vector operator is mocked.

## Safety boundary

The harness accepts only an explicitly acknowledged `127.0.0.1:<port>` PostgreSQL URL with a port, username, password, and maintenance database. `MEMORY_POSTGRES_OWNED_ENDPOINT_ACK` must exactly match that host and port, so omitting a port can never fall through to a live local `5432`. It creates a uniquely named `meri_memory_qualification_*` database, a NOLOGIN owner role, and a LOGIN application role declared `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`. All fixture objects live in the dedicated `memory_qualification` schema. Cleanup disconnects sessions and drops the database and both roles. It never runs a production migration, writes `public`, uses a shared schema, or contacts a provider/cloud database.

`MEMORY_POSTGRES_ADMIN_URL` is intended for the disposable GitHub Actions service. Local runs should pass `MEMORY_POSTGRES_CREDENTIALS_FILE`; the JSON is read in-process and credential values are never logged. Required-vector mode rejects DB-free mode and absent, empty, nonexistent, malformed, or credential-free database inputs during configuration, before any database client can mutate the target.

## DDL boundary

This is a focused final-shape fixture, not a full migration replay.

- `tenants`, `users`, and `clients` are explicitly minimal parent fixtures needed by foreign keys and ethical-wall checks.
- `client_memory_access`, canonical `memory_items`, governance constraints/indexes, current owner/expiry/wall RLS, and `context_embeddings` use the relevant definitions from the migration sources listed by `DDL_PROVENANCE` in `harness.ts`.
- `context_embeddings` and its HNSW index are installed only when the real `vector` extension is available. CI sets `MEMORY_POSTGRES_REQUIRE_VECTOR=1`, so a missing extension fails the job rather than skipping semantic qualification.
- No migration SQL or Prisma schema file is changed by this harness.

## Commands

DB-free guard/manifest smoke:

    MEMORY_POSTGRES_DB_FREE=1 pnpm --filter @capiro/api exec jest --ci --runInBand --runTestsByPath src/retrieval/adapters/institutional-knowledge-retrieval.adapter.postgres.spec.ts

Native local PostgreSQL 16 (credentials remain private):

    MEMORY_POSTGRES_OWNED_ENDPOINT_ACK=127.0.0.1:55433 MEMORY_POSTGRES_CREDENTIALS_FILE=C:/dev/cap-meri-foundation-evidence/private/local-postgres.json pnpm --filter @capiro/api exec jest --ci --runInBand --runTestsByPath src/retrieval/adapters/institutional-knowledge-retrieval.adapter.postgres.spec.ts

The native service at `127.0.0.1:55433` has no pgvector. That run must print:

    MEMORY_POSTGRES_VECTOR NOT_RUN reason=optional_mode extension=unavailable semantic_tests=SKIP nonvector=RUN

It still executes application-role, SET LOCAL, RLS, governed eligibility, ethical-wall, revocation/cursor, and malformed-provider-vector lexical fallback assertions. The five semantic cases are registered with `it.skip`, not passing test bodies with early returns, so Jest reports five passed non-vector cases and five skipped semantic cases. It does not qualify semantic SQL.

A real pgvector run must print:

    MEMORY_POSTGRES_VECTOR RUN engine=postgresql extension=vector dimensions=1024

Only a required-vector run may be cited as semantic PASS. It covers real 1024-dimensional cosine operators, current-model and source correlation, two models, an embedding used as a derived ranking projection while the returned value/provenance remain the current canonical body/version, an unembedded old lexical hit after 1,000 embedded rows, a semantic-only hit against 501 sparse rows, dimension mismatch/25P02 abort recovery, and semantic-query rollback before a fresh lexical fallback transaction. The canonical-body case also proves cursor drift when the projection hash changes; it does not prove projection/canonical hash equality or stale-hash exclusion. Changing rank eligibility requires a separate measured requirement.
