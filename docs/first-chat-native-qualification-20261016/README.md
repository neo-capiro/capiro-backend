# First-chat native PostgreSQL qualification

This harness exercises `MeriService.bootstrapConversation` through the real
`PrismaService.withTenant` and PostgreSQL transactions. It applies the **exact**
`20281016020000_clio_conversation_bootstrap_receipts/migration.sql` from this
checkout. `predecessor.sql` supplies only the tables, policy helpers and client
memory-wall relation needed by that service. PostgreSQL 16.15 on the jump box
has no `pgvector`, so this is a focused native transaction qualification, **not**
a full migration-chain replay, full HTTP authentication test, or a deployed
role/privilege qualification.

The runner refuses all targets except SCRAM-authenticated
`127.0.0.1:55417/capiro_bootstrap_native_qual`, checks PostgreSQL 16.15 and
the exact task-owned `data_directory`, then refuses a nonempty public schema
or any cluster containing `capiro_app`. It requires `--run` to connect or
execute SQL. `run-isolated.ps1` creates a random SCRAM password in memory,
uses a short-lived initdb password file, passes the URL only through process
environment variables, and removes the test cluster after capturing sanitized
evidence. It does not change the running `postgresql-x64-16` host service or
contact another host.

## Exact isolated target and prerequisites

- Installed binary source:
  `C:\Program Files\PostgreSQL\16\bin\{initdb,pg_ctl,postgres,createdb,psql}.exe`.
- Task-owned data directory:
  `C:\Users\Administrator\Documents\Codex\2026-10-16\task-3\isolated-postgres-20261016\data`;
  server log is its sibling `server.log`.
- Loopback port: `55417`; database: `capiro_bootstrap_native_qual`.
- Existing `apps/api/node_modules` with generated Prisma client, `pg` and
  `tsx`, plus bundled Node 24 at
  `C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`.
- Reserve at least **1.5 GiB free before initialization**: at most 512 MiB
  working budget while preserving at least 1 GiB residual headroom. The
  wrapper rechecks that 1 GiB remains after startup, before creating the
  test database and applying SQL. It refuses an existing target or listener.

New-server initialization and SQL execution require the separate, exact-target
approval gate. The approved run used this single guarded command:

```powershell
& 'C:\Users\Administrator\Documents\Codex\2026-10-16\task-3\capiro-backend\docs\first-chat-native-qualification-20261016\run-isolated.ps1'
```

The harness checks six focused behaviors: create and same-key replay; parallel
same-key calls; a deterministic committed-winner race that proves a losing
conversation insert rolls back; archive/move/delete poisoning and immutable
receipt update refusal; client archive and ethical-wall grant/revocation; and
tenant/actor/foreign-client separation. It prints each passed check and an
aggregate count. A failed check still leaves sanitized runner and server logs
outside the disposed data directory.
The deterministic race interposes a committed rival **between the service's
first read and its real Prisma insertion**; it does not replace either
transaction with an in-memory mock.

The orchestrator's `finally` stops the exact cluster, verifies its resolved
task-owned data path, and deletes that disposable data. It retains redacted
runner and PostgreSQL logs in task-owned `core-bootstrap-native-evidence`.
If the cluster cannot be stopped, its data remains for manual inspection;
other checkouts, shared caches, and the host service are untouched.

## Result on 2026-10-16

The first approved run reached the isolated server, then stopped and cleaned
it after `tsx` failed to load Nest parameter decorators. The wrapper now pins
`apps/api/tsconfig.json` via `TSX_TSCONFIG_PATH`. A second approved run exited
0 with all six focused checks passing. The sanitized result is
`task-3/core-bootstrap-native-evidence/first-chat-native-d555eb506e82418eb22d6720381a80ef.txt`.
After exit, the cluster directory and temporary
password file were absent and port 55417 had no listener. This evidence covers
the focused Core source transaction path and exact receipt migration under a
disposable cluster owner; production role grants, the full migration tree,
HTTP bearer authentication, and Meri original-run admission remain separate.

For production migration order, ordinary chat is independent of disabled
Objective activation, but an unapplied Objective `20281016010000` must be
reallocated to a later prefix if `20281016020000` is applied first. Retain the
reservation record and committed receipt rows across application rollback.
