# First-chat native database handoff

This note is for a Meri owner building an **independent, task-owned** PostgreSQL
qualification of first-run admission. The Core runner is a useful isolation
pattern, not a runner for Meri's schema. No live service, production database,
or shared checkout is a target here.

## What Core actually qualified

Core's `run-isolated.ps1` used the installed PostgreSQL 16.15 binaries at
`C:\Program Files\PostgreSQL\16\bin`. It created only
`task-3\isolated-postgres-20261016\data`, listened on
`127.0.0.1:55417`, and created `capiro_bootstrap_native_qual`. The wrapper
refused an existing target or listener, required 1.5 GiB free before `initdb`
and at least 1 GiB after startup, and generated a random SCRAM password for
that disposable cluster. It passed the URL in the process environment, removed
the temporary password file, stopped the cluster, checked the exact resolved
cleanup path and listener, and removed the cluster. It retained sanitized logs
in `task-3\core-bootstrap-native-evidence`.

The test runner requires `--run`, the exact loopback host, port, database and
cluster `data_directory`, PostgreSQL 16.15, an empty `public` schema, and no
`capiro_app` role. It uses bundled Node 24, the installed API `pg` and `tsx`
dependencies, generated Prisma client, and `TSX_TSCONFIG_PATH` pointing at
`apps/api/tsconfig.json` so Nest parameter decorators load. The runner applies
[`predecessor.sql`](predecessor.sql) and the **unchanged** Core
`20281016020000_clio_conversation_bootstrap_receipts/migration.sql`, then
calls the real `PrismaService.withTenant` and
`MeriService.bootstrapConversation` methods. The service object omits unrelated
AI/tool constructor dependencies; database calls are not mocked. A committed
rival is interposed between the first receipt read and the real transactional
insertion to prove losing conversation rollback.

The approved 2026-10-16 run exited 0 with six checks: create/replay,
parallel replay, committed-winner race, archive/move/delete poisoning,
client archive/wall revocation, and tenant/actor/foreign-client separation.
Evidence: `task-3/core-bootstrap-native-evidence/first-chat-native-d555eb506e82418eb22d6720381a80ef.txt`.
This qualifies the focused Core source transaction and exact receipt migration
under a disposable **superuser**. It does not prove `capiro_app` grants or RLS
as that role, full predecessor replay, HTTP Clerk authentication, Meri initial
run admission, or cross-repository behavior.

## Migration dependencies and pgvector boundary

Core's receipt migration directly references:

| Required beforehand | Why |
| --- | --- |
| `tenants(id)` | Receipt tenant foreign key. |
| `clio_conversations(id)` | Nullable conversation foreign key with `ON DELETE SET NULL`. |
| `current_tenant_id()` and `rls_bypass()` | Receipt RLS policy. |

Its `capiro_app` grant block runs **only if that role exists**. The real Core
bootstrap service additionally queries `users`, `clients` with `status` and
`memory_wall`, `client_memory_access`, and the relevant conversation fields.
The minimal predecessor models these particular relations and policy helpers;
it is not a substitute for the production migration ledger or complete RLS
suite. Source anchors: `apps/api/src/meri/meri.service.ts:552-675`,
`apps/api/src/prisma/prisma.service.ts:140-168`, and the exact receipt migration.

The fresh, full Core migration tree first requests the `vector` extension in
`20260501000000_init_identity_tenancy`; later migrations create vector columns
and indexes. The installed PostgreSQL lacks pgvector. Thus **a blank-database
full Core migration replay needs pgvector**, while this focused receipt SQL and
bootstrap transaction do not. On an already-baselined Core database, the
ordinary first-chat change is the receipt migration plus the existing identity,
Clio, and memory-wall schema above. Its actual deployed schema and role state
still need separate qualification; the focused run did not inspect them.

The separately reserved Objective migration
`20281016010000_client_objective_workload_delegations` sorts before the Core
first-chat `20281016020000` migration. If both are applied together, preserve
that order. If first chat ships alone first, reallocate the still-unapplied
Objective migration to a later prefix **before** applying it. Ordinary first
chat does not need Objective activation. Preserve committed receipt rows on
rollback so a New Chat request ID cannot remap to a different conversation.

## Meri's corresponding native fixture

Meri's first-run table is in its own database/schema, with source at
`apps/control/conversations/migrations/0017_initial_run_bindings.sql`. The
table uses `(tenant_id, conversation_id)` as its immutable original-binding
key and a separate `(tenant_id, run_id)` uniqueness fence. Its source requires
the `meri_conversations` schema from Meri's predecessor migrations; it does
not depend on Core's `vector` extension or Core's receipt table. The Meri
owner should apply the exact Meri migration over a reviewed, minimal Meri
predecessor or over a separately qualified Meri migration chain, and exercise
the real store/admission transaction with writer fence 1. The Core fixture's
`predecessor.sql` cannot stand in for Meri's tables or triggers.

For a portable Meri runner, allocate a **different** task-owned data directory,
loopback port and database. Pin all three in both wrapper and test, then check
`SHOW data_directory` and version after connecting. Refuse a preexisting
directory, listener, role/schema/data that the test did not create, and a
connection URL outside the exact allowlist. Generate only a disposable SCRAM
credential for that cluster; redact it from evidence and remove its file and
cluster after stopping and verifying the process. Keep Meri logs outside the
disposable data directory. Running `initdb`, starting this new server, or
executing SQL needs the exact-target approval gate even when the source
harness is ready.

An end-to-end handoff needs more than these two isolated transaction tests:
Meri must independently verify native Core `/identity` and two `/context`
reads around its durable admission, and prove `/context` rejects a missing,
foreign, archived, or wrong-client conversation. The browser bootstrap receipt
and request nonce are not Meri admission authority. The two databases must not
be conflated into one fixture; cross-repository HTTP and currentness behavior
remain separate qualification work.
