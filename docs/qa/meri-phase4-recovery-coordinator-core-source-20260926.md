# Phase 4 recovery coordinator core — source qualification

Date: 2026-09-26 (America/New_York)

Status: dormant source core qualified; not registered, scheduled, activated, or deployed

## Outcome

`MeriHermesPhase4RecoveryCoordinatorV1` now supplies the authority-neutral orchestration boundary
between durable recovery obligations and the already-qualified reservation/dispatch recovery
boundaries. It owns no Nest provider, timer, database connection, clock, randomness, transport, or
key source.

The coordinator:

- starts only through an explicit default-off `enabled` port;
- asks an authority repository to atomically claim a bounded batch;
- requires every candidate to already contain its durable operation ID and exact 16-byte canonical
  attempt nonce;
- never creates a replacement nonce after transport uncertainty;
- rejects malformed, over-limit, or duplicate-operation source batches;
- copies caller-owned Stop body bytes before the first boundary call;
- processes reservation lookup before known-worker Stop, and Stop before status;
- prevents overlapping ticks within one coordinator instance;
- isolates failures per obligation so one unavailable worker does not abandon the rest of a valid
  bounded batch;
- records verified, UNKNOWN, and boundary-failure outcomes through one explicit authority port;
- treats uncertain outcome persistence as unconfirmed rather than success.

Only exact verified boundary results can later drive known-worker completion or terminalization.
UNKNOWN and boundary failures are scheduling facts, not absence/effect evidence.

## Evidence

Command:

```text
pnpm --filter @capiro/api run verify:meri-phase4-recovery
```

Result:

- 12 Jest suites passed;
- 83 tests passed;
- targeted `tsc -p tsconfig.meri-phase4-recovery.json --noEmit` passed;
- coordinator-specific suite passed 9/9;
- no network, provider, browser, production database, deployment, or Meri prompt was used.

A bounded read-only Hermes Luna architecture audit preceded the implementation. It made four model
calls, recorded 156,482 total/cache tokens and an estimated $0.02549 cost, stayed below the user's
50% ceiling, edited no files, and stopped after returning the source map. Its conclusions were used
only as review input; the checked-in source and tests are the evidence.

## Remaining boundary

The coordinator is intentionally unusable until a separately owned authority package supplies:

- durable candidate discovery and cross-replica exclusive claims;
- stable pre-transport operation/nonce persistence;
- retry/lease state and bounded indexes;
- verified-outcome completion under the Phase 4 authority fence;
- dedicated command/receipt key custody and exact endpoint mapping;
- default-off Nest/timer registration.

Broker-effect idempotency/signed receipts remain a separate package. Production privilege baseline,
topology, durability, backup/restore, rollback, deployment GO, live QA, Phase 5, and Phase 6 remain
outside this source qualification.
