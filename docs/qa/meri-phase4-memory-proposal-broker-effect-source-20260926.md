# Phase 4 memory-proposal broker-effect source receipt

Date: 2026-09-26 (UTC)

Source commit: `ecccaf9296bacfb9dfafeec377282e3f1ad61ea9`
Migration commit: `629281284f3a656118b31116fdd4bc841897f1d4`

This package adds a dormant, transactionally local effect authority for
`meri_propose_memory`. It does not register a runtime caller, install a signer or key,
enable a scheduler, deploy a migration, or change production traffic.

## Implemented boundary

### TypeScript source package (commit ecccaf929)

Contract additions to `meri-hermes-broker-effect.contract.ts`:

- `MeriHermesMemoryProposalRequestV1` with key/value/scope/clientId/confidence/sourceExcerpt
  normalization: key trimmed 1..200 chars, value trimmed 1..8000 chars, scope in
  personal/firm/client, clientId required iff scope=client, confidence null or [0,1] finite,
  sourceExcerpt sliced to 4000 chars preserving JavaScript UTF-16 semantics.
- IEEE-754 `writeDoubleBE` confidence canonical encoding (8 bytes big-endian hex, matching
  PostgreSQL `float8send`). Null confidence encodes as the string `'null'`.
- Deterministic `memcand_<operationId>` candidate ID scheme.
- Length-framed request SHA-256 binding key, value, scope, clientId, confidence bytes, and
  source excerpt into the digest domain `capiro.meri.phase4.broker-effect-request/v1`.
- Receipt claims SHA-256 following the shared domain with result_summary `memory_proposed`,
  `denied`, or `unknown` and domain_ref `memcand_<operationId>` for committed effects.
- Receipt parser with Ed25519 signature verification, claims digest validation, and
  timing-safe comparison.
- Result mapping with scope passed from the request layer (not stored in the receipt row).

Repository additions to `meri-hermes-broker-effect.repository.ts`:

- `applyMemoryProposal` method with input freezing, normalization, request SHA-256 validation,
  dedicated SQL routine call to `meri_phase4_propose_memory_effect`, receipt parsing, and
  scope-aware result mapping.
- `FrozenMemoryProposalInput` interface with deep-frozen identity, normalized request, and
  snapshot verification keys.

16 new source tests: 4 contract spec + 12 repository spec.

### Migration SQL package (commit 629281284)

Migration `20280928130000_meri_phase4_memory_proposal_effect` (445th) extends the one global
broker-effect operation namespace. A single operation UUID cannot commit once for
`meri_record_turn`, `meri_request_clarification`, or `meri_propose_memory`.

The migration adds:

- six NULLable columns to the operations table: `memory_key`, `memory_value_sha256`,
  `memory_scope`, `memory_client_id`, `memory_confidence`, `memory_source_excerpt_length`;
- updated tool-discriminated union constraint requiring memory_* NULL for record-turn and
  clarification, and enforcing key 1..200, value SHA-256 hex, scope in personal/firm/client,
  clientId required iff scope=client, confidence null or [0,1], excerpt length null or 0..4000;
- updated receipt shape constraint adding `meri_propose_memory` committed pattern with
  `detail='memory_proposed'`, `result_summary='memory_proposed'`,
  `domain_ref='memcand_' || operation_id::text`;
- RLS INSERT policies on `memory_candidate` and `review_request` for
  `meri_phase4_authority_owner`;
- `SECURITY DEFINER` function `meri_phase4_propose_memory_effect` with identical
  authority/fence/route/binding verification as clarification;
- IEEE-754 `float8send` confidence in the canonical request digest (matching TypeScript
  `writeDoubleBE`);
- scope/clientId constraint validation before budget reservation;
- raw value text excluded from operation row (only SHA-256 hash stored);
- committed effect: one pending `memory_candidate` with `source_kind='model_extraction'`,
  `status='pending'`, `governed_status='suggested'`, `memory_class='operational'`,
  `memory_authority='ai_extracted'`, `memory_scope` mapped from proposal scope;
- conditional `review_request` INSERT for firm/client scope (unassigned, `risk_tier='moderate'`,
  `surface='memory-proposal'`);
- one `memory.proposed` internal event;
- no run status change (unlike clarification's `waiting_for_clarification`);
- no `clio_memory`, `memory_items`, `memory_cleanup_outbox`, embedding, projection, or review
  notification rows;
- column-specific INSERT grants on `memory_candidate` and `review_request`;
- function ownership to `meri_phase4_authority_owner`, execute-only grant to broker operator;
- post-migration safety audit of role membership and privileges.

8 new migration spec tests across 8 structural assertions.

## Qualification

Final source gate:

```text
pnpm --filter @capiro/api run verify:meri-phase4-broker-effects
```

Result: 5 suites / 67 tests passed (59 prior + 8 new migration spec), followed by the focused
TypeScript compilation.

Recovery requalification:

```text
pnpm --filter @capiro/api run verify:meri-phase4-recovery
```

Result: 14 suites / 109 source tests passed on the 445-migration head. One suite
(`meri-hermes-phase4-terminalization-fence.spec.ts`) failed to run due to a pre-existing
`@capiro/meriv2-core` module resolution issue unrelated to this package. This failure is
identical on the prior handoff commit and on the current HEAD.

Disposable PostgreSQL gate (commit f336b87d3, run by user on a Docker-equipped machine):

```text
pnpm --filter @capiro/api run verify:meri-phase4-broker-effects:db
pnpm --filter @capiro/api run verify:meri-phase4-recovery:db
pnpm --filter @capiro/api run verify:meri-b1-b6-requalification:db
```

Result: all three passed with exit code 0.
- Broker-effect DB: 445 migrations applied, 2 suites / 14 tests passed.
- Recovery DB: 445 migrations applied, 3 suites / 18 tests passed.
- B1/B3/B6 DB: 445 API + 61 intel migrations, 6 suites / 28 tests passed.

The first run exposed stale 444-count invariant checks in all three rehearsal scripts. These were
fixed in commit f336b87d3, which also added ownership and EXECUTE invariant checks for the new
`meri_phase4_propose_memory_effect` function. The successful re-run confirmed all 18 broker-effect
invariant columns, including the new function's ownership and execute-only authority.

`prisma validate` and `git diff --check` passed.

## Remaining boundary

This package is dormant. It is not production authority until a stable API-owned per-tool
operation identity, qualified signing/verifying pipeline, trusted runtime caller, exact key
registry, default-off wiring and deployment qualification exist.

The following items from the resume order remain unimplemented:
- budget-consuming read-effect sagas (item 2, first package done: retryExtraction rejection);
- artifact staging and reconciliation (item 3);
- qualified signing and verification pipeline (item 4);
- stable per-tool operation identity (item 5);
- trusted runtime integration (item 6);
- capability cleanup, JEV and evaluation (item 7).

All live and deployment gates from the handoff remain open. No production deployment, migration,
or browser acceptance was performed.
