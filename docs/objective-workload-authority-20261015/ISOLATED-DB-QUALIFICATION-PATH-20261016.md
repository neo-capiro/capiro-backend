# Isolated native database qualification path (candidate)

The installed `C:\Program Files\PostgreSQL\16\bin\{initdb,pg_ctl,postgres,psql}.exe`
all report PostgreSQL 16.15. The uninstall registry lists PostgreSQL 16
version 16.15-4, publisher PostgreSQL Global Development Group, installed
2026-09-27. PE Authenticode reports `NotSigned`: registry and executable
version provide installation provenance, not a verified publisher signature.
SHA-256 is `39ECBE302ADDD9550CA7DCC70CD608F50B462759502095444286A7FC300BF00D`
for `initdb.exe`, `DE74F8014462003FB23EDC2D3D0A8EBF35CBB46F92174632C5698FAD71B0DBE6`
for `pg_ctl.exe`, and `0F859019E969CAFD9E42664AD157514BED9062D9873D98F8F114FC3B45A1B531`
for `postgres.exe`.

The existing `postgresql-x64-16` service runs automatically as
`NT AUTHORITY\NetworkService` from `C:\Program Files\PostgreSQL\16\data`;
it listens on `0.0.0.0:5432`. Do not connect to it, inspect its data, or
change its service, credentials, ACLs, or authentication settings. Docker,
AWS, and production databases are outside this path.

Create a new cluster **only** at
`C:\Users\Administrator\Documents\Codex\2026-10-16\task-3\isolated-postgres-20261016\data`,
with sibling `server.log`, listening only on `127.0.0.1:55417`. Create the
test database `capiro_bootstrap_native_qual` on this endpoint only. Verify
that the root directory does not exist and port 55417 has no listener just
before initialization. The harness must reject a host, port, database, or
data-path mismatch; never fall back to the default PostgreSQL endpoint.

Read-only inventory found 2,026,606,592 bytes free on C: (about 1.89 GiB).
Reserve **at least 512 MiB** for focused cluster files, WAL, fixtures, and
log, with **at least 1 GiB residual free** after that reservation. Recheck
before initialization and during testing; stop if the threshold would be
crossed. This is a conservative budget, not a measured initial cluster size.

The installed extension tree has `uuid-ossp`, `citext`, `pg_trgm`, and
`pgcrypto`, but **no `vector.control` or vector DLL**. The first predecessor
migration, `20260501000000_init_identity_tenancy`, requires `CREATE EXTENSION
IF NOT EXISTS "vector"`; the full 476-migration tree cannot be replayed on
this installation. For ordinary first chat, build a minimal fixture schema
from the actual tenant/user/client/Clio conversation DDL and RLS helpers,
then apply the actual `20281016020000_clio_conversation_bootstrap_receipts`
migration. This can prove focused native transaction behavior, **not**
full migration replay or production role privileges. Objective migration
`20281016010000_client_objective_workload_delegations` needs its own scoped
predecessor fixtures and separate native proof before activation.

PostgreSQL 16 on Windows supports SSPI, but compatibility of this repo's
Prisma Client 5.22.0 and `pg` driver with SSPI is unverified; the existing
Prisma qualification harness requires URL credentials. The proposed
exact-target entry point for the first-chat run is
[`../first-chat-native-qualification-20261016/run-isolated.ps1`](../first-chat-native-qualification-20261016/run-isolated.ps1),
executed from this task-owned checkout after the supported approval mechanism
has reviewed its exact `initdb` and `pg_ctl start` target. Do not substitute
the host service, a manual sequence, or another port.

That wrapper creates a fresh 48-byte random, test-only SCRAM password in
memory, writes a temporary password file in the task-3 root for `initdb`,
and deletes the file immediately after initialization. It starts the new
cluster with `pg_ctl -D` pointed only at the exact task-owned data directory
and `-h 127.0.0.1 -p 55417`, then creates
`capiro_bootstrap_native_qual` through that endpoint. It injects a scoped
Prisma URL for the focused qualifier and restores previous environment
values in `finally`. The disposable cluster holds a SCRAM verifier until
cleanup; no host-service or persistent application credential is created.
Do not print or reuse the random value. If even a temporary verifier is
disallowed, Prisma endpoint qualification remains incomplete.

The wrapper rejects an existing cluster target, an occupied port, missing
binaries/Node runtime, PostgreSQL versions other than 16.15, and free disk
below 1.5 GiB before initialization. It checks for at least 1 GiB free after
startup. A successful run saves a sanitized qualifier report and PostgreSQL
log in task-owned `core-bootstrap-native-evidence` before deleting the
disposable data. Starting a new server and executing its focused SQL still
require the supported exact-target approval. Both executed attempts used that
approval gate. The first exposed a `tsx` Nest decorator configuration error;
after pinning `apps/api/tsconfig.json`, the second exited 0 with six focused
first-chat checks. Sanitized evidence is retained at
`task-3/core-bootstrap-native-evidence/first-chat-native-d555eb506e82418eb22d6720381a80ef.txt`.

The focused native checks should prove concurrent exact replay commits one
conversation and receipt; wrong-client replay remains denied; archived,
foreign, and invisible rows fail currentness; hard deletion poisons the
receipt; and actual uniqueness/transaction behavior holds under races.
Effective production tenant RLS and role grants remain separate qualification
targets because this fixture deliberately uses a new cluster owner role. Objective
denied-proof persistence, phase fences, and unknown-tenant privilege behavior
are separate qualification targets. Source-level Prisma validation is not a
substitute for these native checks. The disabled Objective delegation
constraint remains closed, while first chat can qualify independently.

The wrapper's `finally` restores environment variables, removes any
temporary password file, checks `pg_ctl status` for this exact data directory,
and stops that instance with `pg_ctl -D ... stop -m fast` if running. Before
recursive deletion it verifies the absolute data path is beneath task-3 and
is not a reparse point, then deletes only that data directory. It removes
the task-owned parent only when empty. On stop or log-sanitization failure
it retains the data directory for diagnosis and reports the cleanup error;
do not redirect cleanup to another path. Never remove or move
`C:\Program Files\PostgreSQL\16\data` or shared caches.

If the combined migration tree is deployed, apply Objective `10000` before
first-chat `20000`. If ordinary first chat deploys alone first, reallocate
the still-unapplied Objective migration to a later prefix **before** any
deployment. On application rollback, retain both reservation records and
all committed first-chat bootstrap receipts so an exact request ID cannot
silently map to another conversation. Both disposable clusters were stopped
and removed after their runs; no password file or port listener remains. The
host service and production database were not touched.
