# Phase 4 verified recovery-outcome application source receipt

Date: 2026-09-26 (America/New_York)

Status: source- and disposable-database-qualified, dormant, not registered, not deployed, and not
activation acceptance.

## Scope

This package closes the gap between an already verified signed recovery receipt and authoritative
Meri run state. It adds no LOGIN, caller membership, scheduler, key source, transport, Nest
registration, production migration, or live activation.

The package provides:

- an append-only, FORCE-RLS projection of bounded terminal response content, independently bound
  to the exact signed native-response digest;
- strict UTF-8/JSON parsing, run/session/status binding, sanitized output/error/usage fields, and an
  explicit unavailable projection when terminal content cannot be safely displayed;
- append-only provenance for applied, superseded, and unresolved recovery outcomes;
- exact reservation/dispatch receipt joins across tenant, run, operation, nonce, route, worker,
  request digest, action, and native request bytes;
- database-clock expiry and fresh-consumer fencing, including null-heartbeat freshness derived
  from the run update timestamp;
- late worker binding with exact Stop or status follow-up work;
- `stop_accepted` as nonterminal proof with a fresh status obligation;
- durable Stop dominance over a late completed response, using only pre-Stop durable output (or a
  fixed Stop message) and never the late display body;
- winner-only terminal compare-and-set before assistant-message and final-event publication;
- exact replay without duplicate message/event publication, while preserving a newly reclaimed
  lease's right to record its own attempt;
- unresolved, alarmable states for missing display proof, sealed absence, and expired uncertainty;
- a dedicated recovery operator with routine execution only and no direct table DML.

## Verification

The following completed successfully on the package working tree based on `78762771e`:

```text
pnpm --filter @capiro/api run verify:meri-phase4-recovery
pnpm --filter @capiro/api run verify:meri-phase4-recovery:db
pnpm --filter @capiro/api run verify:meri-b1-b6-requalification:db
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres \
  pnpm --filter @capiro/api exec prisma validate
git diff --check
```

Results:

- all 442 API migrations applied in disposable PostgreSQL after the expected pre-existing PUBLIC
  routine negative control was resolved;
- the complete recovery source package passed 15 suites / 116 tests plus targeted TypeScript
  compilation;
- 3 recovery database suites / 18 tests passed, including exact replay, cross-replica claims,
  Stop/status races, stale-owner takeover, unresolved proof gaps, exact display publication, and
  operator DML denial;
- B1/B3/B6 requalification passed its 6 database suites / 28 tests on the same 442-migration head;
- Prisma validation and whitespace checks passed.

A final bounded, read-only Hermes audit used `openai/gpt-5.6-luna` with low reasoning and made no
edits. It reported `NO BLOCKERS`. The usage receipt recorded 69,681 total/cache/reasoning tokens,
4 model API calls, and estimated cost USD 0.01208734, approximately 43.6% of a 160k context window
and below the requested 50% ceiling.

## Explicit non-claims and next boundary

This package does not provide broker-effect idempotency or signed effect receipts. It does not wire
the trusted Phase 4 runtime, register the claim controller, caller, reconciler, or scheduler, or
activate any ingress. The next source boundary is a dormant, purpose-separated broker-effect
authority beginning with the transactionally local `meri_record_turn` effect.

No production environment, browser, provider, Meri prompt, deployment, production migration, or
live QA was used for this receipt.
