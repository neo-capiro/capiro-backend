# Memory and Strategy CI repair qualification

The post-capacity CI run exposed six memory failures and four Strategy failures. This change fixes canonical no-op revision detection, supplies the client-label lookup in two test fixtures, updates static guards to follow the current fail-closed context paths, and moves the news wall decision into the shared wall helper without changing its SQL access rules.

Strategy integration tests create randomly identified tenant/client/reference fixtures, reset overrides per test, and remove only their owned rows. They require an explicit disposable-database flag and a loopback PostgreSQL address. The existing CI database step sets that flag. No existing assertion or release gate is skipped.

## PASS

- Exact memory CI test selection: 811 tests in 100 suites, exit 0.
- Focused memory/news verification: 60 tests in seven suites, exit 0.
- API and Strategy type checks: exit 0.
- Strategy fixture integration: five tests in two suites, exit 0, against all 16 Strategy migrations in an owned local database. The harness supplies minimal API-owned tenant/client tables including their foreign key; full API migration replay remains a hosted gate. Tenant, client, baseline, and audit counts were zero after cleanup; the owned database was removed.
- The actual news helper SQL passed eight PostgreSQL authorization assertions covering grants, revocation, tenant identity, membership, unknown actor, and archived clients. Its owned schema was removed.
- Hermes/Kimi independent static review and final disposition: scoped PASS.

The first local Strategy invocation failed before collecting tests because its generated Prisma client was absent. That setup failure is preserved; generation and the fresh test run exited 0. Hosted failures are retained separately from this setup issue.

Evidence: `C:/dev/cap-meri-foundation-evidence/ci-repairs-gates.json`, `ci-repairs-memory-suite.log`, `ci-memory-repairs-focused.log`, `ci-strategy-fixtures-gates.json`, `ci-strategy-fixtures-tests.log`, `ci-news-wall-real-sql.log`, and `review-ci-repairs-disposition-report.md`.

## NOT RUN

Fresh hosted CI on the published commit, shared-environment acceptance, main integration, deployment, and full Workstream A/File01 acceptance remain pending. These repairs changed no live flags, routing, shared database, or production model policy.
