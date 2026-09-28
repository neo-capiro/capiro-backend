# Disposable PostgreSQL migration-prerequisite bootstrap

`bootstrap-disposable-postgres-roles.sh` supplies external baseline prerequisites that a clean GitHub Actions PostgreSQL service lacks but the checked-in API migration chain expects.

The helper creates only one cluster role, `capiro_worker`. Migration `20281002010000_research_portfolios_phase10_watch_delivery` grants that role `SELECT, INSERT`; the migration does not create it. Other named roles in the API chain are created by earlier migrations (`capiro_app`, `capiro_pe_promoter`, `capiro_defense_serve`, `capiro_defense_job`, and `capiro_analytics_ro`) and therefore are not bootstrap fixtures.

Safety boundary:

- The target is fixed to `postgres@127.0.0.1:5432/capiro`; no URL, host, port, database, or role override is accepted.
- Mutating mode requires `GITHUB_ACTIONS=true`, `CI=true`, and an explicit `CI_DISPOSABLE_POSTGRES=1` marker from the workflow job.
- Every PostgreSQL command pins libpq's host and host-address parameters to loopback and discards inherited service-file and `PGOPTIONS` settings. The connected database, user, port, and superuser status are still checked before mutation. PostgreSQL's server address is not compared because Docker reports its bridge address inside the service container.
- The fixture role is `NOLOGIN`, `NOINHERIT`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOBYPASSRLS`, and `NOREPLICATION`, with no inherited role memberships. Existing unsafe role state fails closed.
- `research-portfolio-append-only-prerequisite.sql` creates `public.reject_append_only_mutation()` only when missing. A compatible existing definition is preserved exactly; an incompatible definition fails closed.
- The helper changes no tables, migration files, migration checksums, application grants, or non-CI databases.

Local checks do not contact PostgreSQL:

    bash scripts/ci/bootstrap-disposable-postgres-roles.sh --validate-only
    bash -n scripts/ci/bootstrap-disposable-postgres-roles.sh
    node --test scripts/ci/bootstrap-disposable-postgres-roles.test.mjs

A full migration replay remains a GitHub Actions check because the assigned Windows environment has no Docker/WSL PostgreSQL fixture.

## Phase 10 append-only prerequisite

Migration `20281002010000_research_portfolios_phase10_watch_delivery` references `public.reject_append_only_mutation()`. A direct read-only live probe established that this function is a known, unledgered deployed baseline prerequisite, in the same class as the externally provisioned `capiro_worker` role. Clean CI therefore installs the known function fixture after the role fixture and before migration replay.

This is a disposable-CI bootstrap, not an application migration. It proves replay after explicit external-baseline setup; it does not claim a pristine migration-only replay. The SQL input has no production rollout path, does not connect to production, and is not a production repair or reconciliation of live migration-ledger state.

The focused test uses only the installed PGlite PostgreSQL runtime:

    node --test scripts/ci/research-portfolio-migration-prerequisite.test.mjs
