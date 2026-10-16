# Isolated native database qualification path (candidate)

On the authorized Windows jump box, PostgreSQL 16.15 binaries are present at
`C:\Program Files\PostgreSQL\16\bin` (`initdb.exe`, `pg_ctl.exe`, `postgres.exe`,
and `psql.exe`). The machine's `postgresql-x64-16` service is running. It is
not a qualification target and must remain untouched. Docker daemon access
was denied; this path does not require Docker, AWS, or a production database.

The permitted candidate is a **new, task-owned, ephemeral PostgreSQL 16
cluster**, with its data and logs inside this task's writable workspace or
temporary directory, loopback-only listening on an unused port, and an
ephemeral test-only role/password. Use a new database containing the exact
predecessor Core schema, then apply the reserved Objective
`20281016010000_client_objective_workload_delegations` migration followed by
the ordinary first-chat `20281016020000_clio_conversation_bootstrap_receipts`
migration. Exercise rollback/replay and catalog checks in this disposable
cluster only. Keep the existing service, its data directory, ports, roles,
passwords, and connection strings out of the test process.

Before running this path, verify a free local port and task-owned process,
enough free space for the cluster and predecessor migrations, the exact
PostgreSQL version and Prisma engine used by the application, and the
predecessor migration set. Current C: free space was about 2.03 GB at the
read-only inventory; do not start if there is insufficient headroom. No
cluster was initialized, no SQL was executed, and no live privilege result is
claimed by this note.

The native qualification must prove transaction lock/replay behavior,
immutable receipt and proof rows, tenant isolation and actual effective role
privileges (including owner-role inheritance and `FORCE ROW LEVEL SECURITY`).
It must test denied proof persistence after the response is denied and
cross-tenant/unknown-tenant refusal. Source-level Prisma validation is not a
substitute for those checks. The disabled Objective delegation constraint
must continue to reject enablement, while the first-chat route can qualify
and deploy independently once its own migration and application checks pass.

If the combined migration tree is deployed, apply `10000` before `20000`.
If ordinary first chat must deploy alone first, the still-unapplied Objective
migration needs a new later allocation **before** any deployment; this note
does not reallocate it. On application rollback, retain both reservation
records and all committed first-chat bootstrap receipts so exact request IDs
cannot silently map to different conversations.
