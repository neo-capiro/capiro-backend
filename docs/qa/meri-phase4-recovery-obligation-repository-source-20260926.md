# Phase 4 recovery-obligation repository source receipt

Date: 2026-09-26 (America/New_York)

Status: source-qualified, dormant, not registered, not deployed, and not activation acceptance.
The previously missing stored routines were added and disposable-database-qualified by the later
[database authority package](./meri-phase4-recovery-obligation-database-source-20260926.md).

## Scope

This package adds the TypeScript adapter between the dormant Phase 4 recovery coordinator and a
future separately owned PostgreSQL recovery authority. It does not add the database table or the
two stored routines, create a caller credential, register a scheduler, or make a network request.

The adapter:

- uses only the injected recovery-caller transaction boundary;
- calls fixed SQL for `meri_phase4_claim_recovery_obligations` and
  `meri_phase4_record_recovery_outcome`;
- accepts only bounded batches, canonical UUIDs/nonces, exact operation identity, and unique rows;
- permits only an empty status body or the exact Stop body `{}` and copies returned bytes;
- validates exact receipt tenant/run/operation/nonce/action identity before recording a verified
  outcome;
- maps a verified `bound_worker` result to the signed reservation receipt outcome `reserved`;
- records only fixed UNKNOWN/boundary categories and never forwards raw exception, provider, key,
  token, or caller-selected detail text;
- fails closed on malformed authority output or an outcome/receipt conflict.

## Verification

The following completed successfully on the package working tree based on `b4e9f77c6`:

```text
pnpm --filter @capiro/api exec jest --runInBand --forceExit \
  src/meri/hermes/meri-hermes-phase4-recovery-obligation.repository.spec.ts
pnpm --filter @capiro/api exec tsc -p tsconfig.meri-phase4-recovery.json --noEmit
git diff --check
```

Result: 1 suite / 6 tests passed; targeted TypeScript compilation and whitespace checks passed.
The complete `verify:meri-phase4-recovery` command was then rerun on the final package and passed
13 suites / 89 tests plus the targeted TypeScript compilation.

## Explicit non-claims and next boundary

The stored routines named above were not part of this repository-adapter package. The later database
authority package added them with an additional UUID lease-fencing argument and qualification. The
remaining boundary is outcome application and effect authority; registration and scheduling remain
later, separately reviewed work.

No production environment, browser, provider, Meri prompt, deployment, migration, or live QA was
used for this receipt.
