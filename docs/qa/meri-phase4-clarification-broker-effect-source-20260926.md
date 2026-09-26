# Phase 4 clarification broker-effect source receipt

Date: 2026-09-26 (America/New_York)

Implementation commit: `ea644b15f66f16f9c1c8be2ae7192633fc3384aa`

This package adds a dormant, transactionally local effect authority for
`meri_request_clarification`. It does not register a runtime caller, install a signer or key,
enable a scheduler, deploy a migration, or change production traffic.

## Implemented boundary

Migration `20280928120000_meri_phase4_clarification_effect` extends the one global broker-effect
operation namespace. A single operation UUID cannot commit once for `meri_record_turn` and again
for clarification.

The package adds:

- canonical clarification request normalization and length-framed request digests;
- deterministic public request IDs of the form `clar_<operationId>`;
- one atomic committed transaction containing exactly one broker-call increment, run status
  transition to `waiting_for_clarification`, pending interaction, public
  `clarification.requested` event, operation and signed receipt;
- exact replay before current authority checks;
- unsigned `effect_unknown` tombstones, with caller disposition excluded from core replay identity;
- current tenant/user/membership, client-access, mailbox, conversation, dispatch-intent, route,
  binding, Stop, terminal-state, tool-policy and budget revalidation for attempted effects;
- run-local use on both `readOnly:false` and `readOnly:true` envelopes;
- an enforced `0..40` tool-call cap matching the declared runtime envelope;
- FORCE-RLS owner-only interaction insertion and execute-only broker-operator authority;
- public-key Ed25519 receipt verification in the TypeScript boundary.

The same migration replaces the existing `meri_record_turn` routine without changing its
signature and corrects four invariants:

1. `readOnly:true` permits the run-local tool.
2. Core operation replay excludes `effect_disposition`.
3. Caller-reported uncertainty is recorded before current Stop/authority/tool classification.
4. `maxToolCalls` above 40 is rejected.

Signed uncertainty is no longer accepted. Only fully unsigned `effect_unknown` evidence is a
valid uncertainty receipt.

## Qualification

Final source gate:

```text
pnpm --filter @capiro/api run verify:meri-phase4-broker-effects
```

Result: 4 suites / 43 tests passed, followed by the focused TypeScript compilation.

Disposable PostgreSQL gate:

```text
pnpm --filter @capiro/api run verify:meri-phase4-broker-effects:db
```

Result: all 444 API migrations applied and 2 database suites / 14 tests passed. The first run
found a missing closing parenthesis in the new table constraint. That defect was fixed before the
successful clean rerun and before commit.

Recovery requalification:

```text
pnpm --filter @capiro/api run verify:meri-phase4-recovery
pnpm --filter @capiro/api run verify:meri-phase4-recovery:db
```

Result: 15 suites / 116 source tests and 3 suites / 18 database tests passed on the 444-migration
head.

B1/B3/B6 database requalification:

```text
pnpm --filter @capiro/api run verify:meri-b1-b6-requalification:db
```

Result: all 444 API migrations, all 61 intel migrations, and 6 suites / 28 tests passed.

`prisma validate` and `git diff --check` also passed. All disposable containers were removed.

## Hermes audit and control failure

A read-only Hermes review used `openai/gpt-5.6-luna` through OpenRouter with low reasoning. The
prompt authorized no edits, tests, network calls, artifacts or child agents and requested a hard
stop before 70,000 aggregate/cache/reasoning tokens. Hermes ignored that requested stop and made
5 model calls reporting 161,700 aggregate/cache/reasoning tokens, with estimated cost USD
0.01943546. Aggregate per-call tokens do not prove peak context occupancy, but this exceeded the
explicit audit budget and the conservative usage proxy. No further Hermes session was run.

The review's P0 claim that two `END IF` statements were unmatched was disproved by direct
PostgreSQL application: each closes the enclosing `p_effect_disposition <> 'effect_unknown'`
guard, and migration 444 plus all 14 broker-effect database tests passed. Its remaining concerns
were either already exercised by the separate `:db` gate (concurrency, cross-tenant drift,
read-only operation, Stop/authority/budget denial, signed-unknown rejection, TypeScript/PostgreSQL
digest parity, RLS) or accurately described the intentional split between fast source verification
and disposable-database verification.

## Remaining boundary

This package is dormant. It is not production authority until a stable API-owned per-tool
operation identity, qualified signing/verifying pipeline, trusted runtime caller, exact key
registry, default-off wiring and deployment qualification exist. Memory proposal, read-effect
sagas, artifact staging/reconciliation and the signer/verifier writer remain unimplemented.
