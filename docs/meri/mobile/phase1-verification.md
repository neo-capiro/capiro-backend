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
- Post-rebase focused verification against `origin/main` `39eb596d50efd56aa9812b654604bf5860237521`: Prisma validate passed; mobile flags, upstream Quick Action flags, mobile service/contract, and queued-disconnect integration passed, 5 suites / 23 tests.
- Guarded staging-proof unit suite: `pnpm --filter @capiro/api exec jest --runInBand --forceExit scripts/lib/meri-hermes-staging-proof-guard.spec.ts` — passed, 1 suite / 3 tests. This covers exact staging/opt-in/pilot guards, the evidence allowlist, and rejection of content-bearing fields.
- Guarded staging-proof typecheck: `pnpm --filter @capiro/api exec tsc -p tsconfig.meri-hermes-staging-proof.json --noEmit` — passed.
- Staging-only infrastructure assertions: `pnpm --filter @capiro/infra-cdk exec jest -c jest.jest-style.config.cjs --runInBand test/data-stack.engine-version.spec.ts` — passed, 1 suite / 3 tests. Staging synthesizes Aurora PostgreSQL 16.8 and the recovered rotation-network parity; development and production remain unchanged.
- Patch hygiene: `git diff --check` — passed after the proof-driver and evidence changes.

## Aggregate typecheck baseline

`pnpm --filter @capiro/api run typecheck` reached the repository's existing Defense Budget workspace dependency gap and exited 2. It reported 29 diagnostics, all under `src/defense-budget*`: missing built `@capiro/defense-domain` and `@capiro/defense-contracts`, followed by downstream implicit-`any` diagnostics. It reported no diagnostic in the Phase 1 files. This is an environment/workspace-build result, not a green aggregate typecheck claim.

## Staging deployment evidence

All AWS changes were issued directly through the AWS CLI in account `967807252336`, region `us-east-1`; GitHub Actions, the AWS console, SDKs, and production were not used. `Capiro-staging-Network` and `Capiro-staging-Compute` are `UPDATE_COMPLETE`. `Capiro-staging-Data` is `UPDATE_ROLLBACK_COMPLETE` after its missing resources were restored; the live Aurora PostgreSQL 16.8 cluster is available, encrypted, private, deletion-protected, and has distinct available writer and reader instances. The residual Data stack drift is recorded rather than hidden.

- Migration one-off task: suffix `8cf9c14c23e846ebb7fd8276bbcd81f2`, ran `2026-09-23T10:05:45Z`–`10:06:51Z`, exit 0. It applied the additive Phase 1 migration including `20280923010000_meri_mobile_device_tokens`.
- Role bootstrap retry: suffix `eb1be036b14349f9abf75e78f2a00ad9`, ran `2026-09-23T10:07:45Z`–`10:08:42Z`, exit 0.
- ECS services `capiro-staging-api`, `capiro-staging-web`, and `capiro-staging-marketing` are active at desired/running `1/1`; staging app and marketing root/health checks return HTTP 200 with successful TLS verification. Unauthenticated `/api/mobile/v1/bootstrap` returns 401.
- No `capiro-staging` EventBridge or Scheduler expansion exists. Mobile/Hermes environment and secret overrides are absent from the persistent API service, so all new gates remain default-off globally.
- The final proof image is `capiro/staging/api@sha256:028a0b8e1ed8f5792c575d004dfb48840f64608c88b3a9e8efe9893ce7c2816f`, tagged with commit `311587315c1cc029e6bd1c5e2ff3e4b3bfc738f9`. It is staging-only and must not be promoted.

## Queued and active continuity acceptance proof

The accepted proof used task `arn:aws:ecs:us-east-1:967807252336:task/capiro-staging/c2bcae78594f4a91af082b27702e855a`, task definition `capiro-staging-meri-hermes-continuity-proof:4`, created `2026-09-23T11:28:42.420Z`, started `11:29:13.946Z`, and stopped `11:29:54.946Z` with exit 0. The guarded driver itself ran from `11:29:18.377Z` to `11:29:31.267Z` against only synthetic tenant `f17a0000-0000-4000-8000-000000000001`; cleanup asserted `syntheticTenantDeleted=true`. The model-generation boundary alone was replaced with deterministic delayed output. Admission, tenant flags, durable repository, event replay, authorization, idempotency, and Stop used production code paths.

| Gate | Opaque run ID | Result |
| --- | --- | --- |
| Disconnect while queued; reconnect from a fresh process | `5f03014e-f1a3-4ad1-8ce5-c47cdbb9c3ed` | Completed; detached; duplicate retry reattached to one run and one user message; terminal output persisted; event sequences were unique and monotonic. |
| Disconnect while active; reconnect and replay | `b70f1cad-4ea9-4943-8888-e66a402e78a9` | Completed; detached; fresh-process reconnect and `outputSnapshot` replay passed; terminal output persisted; event sequences were unique and monotonic. |
| Stop after rollback gate closure | `80f6bbb5-46d0-421b-8974-f9b808725cdd` | Cancelled; Stop requested; no success followed Stop. |
| Authorization | — | Cross-owner and cross-tenant reads were denied. |
| Disabled/rollback paths | — | Wrong-tenant and tenant-flag-off admission were denied. Closing the pilot gate while the active run was in flight refused new work while the admitted run drained to completion; Stop remained available after closure. |

Event payloads and content were never logged. The proof emitted only schema version, environment, the synthetic tenant ID, timestamps, opaque run IDs, terminal statuses, and boolean/count assertions; individual transient event IDs were intentionally not retained after synthetic-tenant cleanup. The CloudWatch stream is `/capiro/staging/api` / `meri-hermes-proof/proof/c2bcae78594f4a91af082b27702e855a`.

## Remaining gates and blockers

- ECR enhanced-scan findings block release promotion: the earlier full API image reported 6 critical, 41 high, 32 medium, and 5 low findings; web/marketing reported 3 critical, 35 high, 27 medium, and 6 low. These staging digests were not promoted to production.
- No Secrets Manager names matching APNs, Apple, or iOS were present, and the staging API task definition has no APNs/Apple configuration. The repository implements token lifecycle but no push sender. An APNs key, Apple team ID, bundle/topic, physical device token, and sender implementation are required before a generic-payload device send can be proven.
- Signing, physical-device UX, TestFlight, App Store, and the product/Figma decisions recorded in `phase1-decisions.md` remain explicitly deferred.
- GitHub Actions jobs fail immediately by intentional repository/account configuration and were declared non-blocking by the user. This record does not represent them as green.

The Phase 1 backend continuity acceptance gate is met by the task above. Apple distribution and deferred product work are not claimed complete.
