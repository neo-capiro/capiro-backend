# Meri iOS Phase 1 verification record

Date: 2026-09-23

## Local automated evidence

- Prisma client generation: `pnpm --filter @capiro/api exec prisma generate` — passed.
- Queued-disconnect integration: `DATABASE_URL=<local fixture> pnpm --filter @capiro/api exec jest --runInBand --forceExit src/meri/hermes/meri-hermes-scaling-adapter-wiring.integration.spec.ts` — passed, 1 suite / 6 tests. The focused explicit-key variant also passed after proving the same key reattaches while queued and after terminal completion.
- Mobile service/flag security suite: `pnpm --filter @capiro/api exec jest --runInBand --forceExit src/common/meri-mobile-flags.spec.ts src/mobile/meri-mobile.service.spec.ts` — passed, 2 suites / 7 tests.
- Published contract suite: `pnpm --filter @capiro/api exec jest --runInBand --forceExit src/mobile/meri-mobile-contract.spec.ts` — passed, 1 suite / 3 tests.
- Prisma schema validation with the local fixture URL: `pnpm --filter @capiro/api exec prisma validate` — passed.
- Conditional-write/upload retry regression: `DATABASE_URL=<local fixture> pnpm --filter @capiro/api exec jest --runInBand --forceExit src/engagement/meeting-client-reassignment.spec.ts src/meri/hermes/meri-hermes-scaling-adapter-wiring.integration.spec.ts --testNamePattern='stale conditional|exact attachment|disconnect while queued'` — passed, 2 suites / 3 selected tests (24 unrelated tests skipped by the filter).
- Full relevant web/mobile regression: `pnpm --filter @capiro/api exec jest --runInBand --forceExit src/engagement/meeting-client-reassignment.spec.ts src/mobile/meri-mobile.service.spec.ts` — passed, 2 suites / 25 tests.

## Aggregate typecheck baseline

`pnpm --filter @capiro/api run typecheck` reached the repository's existing Defense Budget workspace dependency gap and exited 2. It reported 29 diagnostics, all under `src/defense-budget*`: missing built `@capiro/defense-domain` and `@capiro/defense-contracts`, followed by downstream implicit-`any` diagnostics. It reported no diagnostic in the Phase 1 files. This is an environment/workspace-build result, not a green aggregate typecheck claim.

## External gates

Staging disconnect/reconnect, staging deployment, Apple/APNs, signing, physical-device, TestFlight, and App Store evidence are not available in this local pass and are not claimed. The required queued and active staging proof remains a named completion gate.
