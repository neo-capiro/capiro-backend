# Disposable PostgreSQL migration-role bootstrap

`bootstrap-disposable-postgres-roles.sh` supplies cluster-scoped role fixtures that a clean GitHub Actions PostgreSQL service lacks but the checked-in API migration chain expects.

The helper currently creates only `capiro_worker`. Migration `20281002010000_research_portfolios_phase10_watch_delivery` grants that role `SELECT, INSERT`; the migration does not create it. Other named roles in the API chain are created by earlier migrations (`capiro_app`, `capiro_pe_promoter`, `capiro_defense_serve`, `capiro_defense_job`, and `capiro_analytics_ro`) and therefore are not bootstrap fixtures.

Safety boundary:

- The target is fixed to `postgres@127.0.0.1:5432/capiro`; no URL, host, port, database, or role override is accepted.
- Mutating mode requires `GITHUB_ACTIONS=true`, `CI=true`, and an explicit `CI_DISPOSABLE_POSTGRES=1` marker from the workflow job.
- Both PostgreSQL commands pin libpq's host and host-address parameters to loopback and discard inherited service-file and `PGOPTIONS` settings. The connected database, user, port, and superuser status are still checked before mutation. PostgreSQL's server address is not compared because Docker reports its bridge address inside the service container.
- The fixture role is `NOLOGIN`, `NOINHERIT`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOBYPASSRLS`, and `NOREPLICATION`, with no inherited role memberships. Existing unsafe role state fails closed.
- The helper changes no tables, migrations, checksums, application grants, or non-CI databases.

Local checks do not contact PostgreSQL:

    bash scripts/ci/bootstrap-disposable-postgres-roles.sh --validate-only
    bash -n scripts/ci/bootstrap-disposable-postgres-roles.sh
    node --test scripts/ci/bootstrap-disposable-postgres-roles.test.mjs

A full migration replay remains a GitHub Actions check because the assigned Windows environment has no Docker/WSL PostgreSQL fixture.
