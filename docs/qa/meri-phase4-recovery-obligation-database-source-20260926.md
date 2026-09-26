# Phase 4 recovery-obligation database authority source receipt

Date: 2026-09-26 (America/New_York)

Status: source- and disposable-database-qualified, dormant, not registered, not deployed, and not
activation acceptance.

## Scope

This package adds the durable PostgreSQL authority behind the dormant Phase 4 recovery coordinator.
It deliberately adds no LOGIN, caller membership, scheduler, Nest registration, key source,
transport, production migration, or live activation.

The package provides:

- a FORCE-RLS recovery-obligation table owned by the inaccessible
  `meri_phase4_authority_owner` role;
- a separate NOLOGIN, NOINHERIT `meri_phase4_recovery_operator` role with no table DML or schema
  CREATE privilege;
- bounded reservation, Stop, and status discovery ordered by priority;
- cross-replica claims using database time and `FOR UPDATE SKIP LOCKED`;
- a fresh UUID fencing token for every lease, in addition to the stable operation ID and nonce;
- stable-identity retry for UNKNOWN and boundary failure without stranding a reclaimed lease on a
  repeated outcome;
- exact persisted reservation/dispatch receipt checks before verified completion;
- Stop precedence that invalidates bounded in-flight status claims and rejects a status callback as
  soon as cancellation is durable, while allowing status to resume after receipt-backed
  `stop_accepted`;
- exact native bodies: empty reservation/status bytes and the two-byte Stop body `{}`;
- closed default routine privileges, fixed SECURITY DEFINER search paths, immutable identity,
  deletion denial, and no surviving recovery-role membership edges.

The TypeScript repository and coordinator now carry the lease fencing token and reject malformed
authority rows or noncanonical Stop bytes. The package remains dormant because it does not create a
caller credential or register the coordinator.

## Verification

The following completed successfully on the package working tree based on `9afb40c32`:

```text
pnpm --filter @capiro/api run verify:meri-phase4-reservation-recovery:db
pnpm --filter @capiro/api run verify:meri-phase4-recovery
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/capiro \
  pnpm --filter @capiro/api exec prisma validate
git diff --check
```

Results:

- all 441 API migrations applied in disposable PostgreSQL after the expected pre-existing PUBLIC
  routine negative control was resolved;
- the expanded post-migration invariant proved both recovery roles had zero membership edges and no
  schema CREATE, the operator had no table DML, only the operator could execute the two routines,
  routine/table ownership was correct, FORCE RLS was active, and no non-extension PUBLIC routine
  execution remained;
- 2 database suites / 10 tests passed, including least authority, cross-replica claims, repeated
  UNKNOWN retry, lease takeover fencing, receipt enforcement, follow-up status identity, and the
  Stop/status race;
- the complete recovery package passed 14 suites / 98 tests plus its targeted TypeScript compile;
- Prisma validation and whitespace checks passed.

The disposable PostgreSQL container and ephemeral LOGIN/membership were removed by the rehearsal.

A final bounded, read-only Hermes audit used `openai/gpt-5.6-luna`, low reasoning, no more than two
terminal tool calls, and made no edits. It reported `NO BLOCKERS` after 3 API calls and 51,898 total
reported/cache tokens (estimated USD 0.00994946), safely below the requested 50% session ceiling.

## Explicit non-claims and next boundary

This package does not apply verified recovery outcomes to authoritative run state. It does not bind
a recovered worker to the run, terminalize a recovered run, publish terminal/progress events, or
provide broker-effect idempotency. Those are the next source boundaries and require their own
authority-fenced transactions and signed receipts before any runtime registration.

No production environment, browser, provider, Meri prompt, deployment, production migration, or
live QA was used for this receipt.
