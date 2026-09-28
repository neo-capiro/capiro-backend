# Canonical memory PostgreSQL gate repair report

## Scope and boundary

Base: `0bf8224c73455e3cb5ac25559b05f972445b7fd4` on `codex/meri-postgres-gate`.

This repair changes only the dedicated GitHub Actions workflow, PostgreSQL qualification spec, localhost-only harness, harness README, and this report. It does not change the production adapter, ranking algorithm, Prisma schema, migrations, providers, cloud resources, deploy paths, or live databases.

The existing focused fixture remains intact: generated NOLOGIN owner and least-privilege LOGIN application roles, production `PrismaService.withTenantUser`, real `Prisma.sql`, force-RLS relations, governance/ethical-wall tests, and cleanup of the generated database and roles.

## Repaired gate behavior

- `MEMORY_POSTGRES_REQUIRE_VECTOR=1` now rejects conflicting DB-free mode and absent, empty, nonexistent, malformed, or credential-free database input during module configuration, before `createQualificationDatabase` can construct a client or issue a database write.
- Every accepted target must be `127.0.0.1` with an explicit port, username, password, maintenance database, and `MEMORY_POSTGRES_OWNED_ENDPOINT_ACK` exactly matching `127.0.0.1:<port>`. An omitted port cannot silently select local PostgreSQL `5432`.
- The GitHub Actions pgvector service publishes only on `127.0.0.1:5432`, and the required-vector step explicitly acknowledges that owned disposable endpoint.
- The five semantic cases use `semanticIt`. They are mandatory tests only in required-vector mode; optional mode registers them as Jest skips. No vector-named test can turn green through an early return.
- Optional native PostgreSQL mode reports `MEMORY_POSTGRES_VECTOR NOT_RUN ... semantic_tests=SKIP nonvector=RUN`. A semantic PASS still requires the required-vector marker and successful completion against real pgvector.

## Direct verification

Commands ran from `C:/dev/cap-meri-outcomes-validation` or its `apps/api` directory. No install, external network, provider, cloud, container, push, merge, or deploy operation was used. Existing dependencies from `C:/dev/cap-meri-fixture-hardening` supplied Jest, TypeScript, Prettier, and a generated Prisma client; that dependency reuse is a limitation rather than clean-install evidence.

### Missing-database required-vector negative

The independent review recorded the pre-repair command with `MEMORY_POSTGRES_REQUIRE_VECTOR=1` and no database input exiting `0` with one static pass and nine skips.

After repair, the same condition exited `1` before test registration with:

    MEMORY_POSTGRES_REQUIRE_VECTOR requires MEMORY_POSTGRES_ADMIN_URL or MEMORY_POSTGRES_CREDENTIALS_FILE

Result: before `0`, after `1`.

### DB-free static guards

`MEMORY_POSTGRES_DB_FREE=1` focused Jest exited `0`: one static guard passed and nine database tests skipped. The guard covers required-vector/DB-free conflict, missing and empty target input, nonexistent credential file, missing URL credentials, non-IPv4-loopback hosts, implicit port rejection, owned-endpoint acknowledgement mismatch, workflow host binding, and required-vector CI configuration.

The operational conflict negative with both `MEMORY_POSTGRES_DB_FREE=1` and `MEMORY_POSTGRES_REQUIRE_VECTOR=1` exited `1` before test registration with `MEMORY_POSTGRES_REQUIRE_VECTOR conflicts with MEMORY_POSTGRES_DB_FREE`.

### Malformed target and zero writes

A private-credential catalog probe first asserted the only inspected native endpoint was `127.0.0.1:55433` and reported:

    MEMORY_POSTGRES_CATALOG endpoint=127.0.0.1:55433 databases=0 roles=0 vector_available=false

Focused Jest with required-vector mode, the correct endpoint acknowledgement, and `postgresql://127.0.0.1:55433/postgres` (no credentials) exited `1` before test registration with `memory PostgreSQL qualification requires explicit database credentials`.

The same catalog probe afterward again reported `databases=0 roles=0 vector_available=false`. The malformed target caused zero qualification writes.

### Owned native PostgreSQL 16, optional non-vector mode

Using only `C:/dev/cap-meri-foundation-evidence/private/local-postgres.json` with `MEMORY_POSTGRES_OWNED_ENDPOINT_ACK=127.0.0.1:55433`, focused Jest exited `0` and printed:

    MEMORY_POSTGRES_VECTOR NOT_RUN reason=optional_mode extension=unavailable semantic_tests=SKIP nonvector=RUN

Jest reported five passed and five skipped. The five genuine passes covered the static guard plus least-privilege role/production `SET LOCAL`, RLS/governed eligibility/ethical walls, cursor revocation and wall-grant recheck, and malformed provider-vector lexical fallback. The five semantic cases were explicitly skipped and are not semantic PASS.

### Required-vector missing-extension negative and cleanup

The same owned endpoint with `MEMORY_POSTGRES_REQUIRE_VECTOR=1` exited `1`, expected, because `required pgvector extension is unavailable`. The failure came from `beforeAll`; no semantic test passed. Cleanup readback then reported `databases=0 roles=0 vector_available=false`.

### Focused static verification

- Focused TypeScript compilation of the PostgreSQL spec and harness: exit `0`.
- Prettier check on the workflow, spec, harness, and README: exit `0`.
- `git diff --check`: exit `0`.

Broad root commands were not rerun because the supplied baseline already records unrelated missing-dependency failures and this task prohibited broad root commands and installation.

## Semantic contract and status

The embedding row is treated by the current implementation as a derived ranking projection. The test with stale projection text/hash proves that ranking can select the memory while the returned value, provenance content hash, and source version come from the current canonical memory body. Changing the projection hash then proves cursor drift/restart behavior.

The test does not prove projection-hash equality with the canonical content hash and does not prove stale-hash exclusion from ranking. No ranker or eligibility behavior was changed; that would require a separate measured requirement.

Actual semantic qualification is `NOT_RUN`: native `127.0.0.1:55433` has no pgvector, and the GitHub Actions pgvector workflow was not run from this checkout. The configured CI gate must still execute successfully and emit `MEMORY_POSTGRES_VECTOR RUN engine=postgresql extension=vector dimensions=1024` before any semantic PASS claim.
