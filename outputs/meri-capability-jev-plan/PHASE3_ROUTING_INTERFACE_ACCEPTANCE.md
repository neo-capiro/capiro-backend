# Phase 3 capability-routing interface acceptance

## Scope and disposition

Implemented on a new isolated worktree from accepted dormant-routing contract `dbc69e0083a00430d6532f3fdef1418d01828992`. This is a provider-neutral API seam and JEV adapter only. It is **not an operational JEV route**: the live `planMeriTurn` call path remains unchanged, the proposal wrapper is not wired into request handling, and `capability_routing` remains `lifecycle: inactive` / `maxRolloutMode: off`. The factory checks those registry gates before constructing a client. A test using a test-only key and enforcing-looking environment confirms no provider fetch occurs.

The wrapper always returns the existing deterministic plan. JEV can only return a validated advisory proposal or a fallback; the adapter has no execution interface. Candidate IDs are copied from the explicit server-supplied eligible-ID list and checked against canonical IDs from `MERI_CAPABILITY_REGISTRY`. Task/source text does not add candidates. Canonical descriptors preserve write/read-only metadata (including `send_email` as write), but neither write descriptors nor read-only descriptors are executed here. Only public `@capiro/meriv2-core` exports are imported. An API-source import-boundary regression checks that no API TypeScript source imports JEV internals.

## Verification

- `pnpm install --offline --frozen-lockfile --filter @capiro/api...` — passed; no packages downloaded.
- Workspace builds: `@capiro/shared`, `@capiro/meriv2-core`, `@capiro/defense-contracts`, `@capiro/defense-domain` — passed.
- `pnpm --filter @capiro/api prisma:generate` — passed (Prisma Client v5.22.0).
- `pnpm --filter @capiro/api exec jest src/meri/jev-capability-routing.adapter.spec.ts --runInBand --silent` — passed, 1 suite / 9 tests.
- `pnpm --filter @capiro/api exec jest src/meri/meri-context-plane.service.spec.ts --runInBand --silent` — passed, 1 suite / 75 tests.
- `pnpm --filter @capiro/meriv2-core exec jest src/jev/capability-routing-contract.spec.ts --runInBand --silent` — passed, 1 suite / 17 tests.
- `pnpm --filter @capiro/api build` — passed after workspace dependency builds.
- `pnpm --filter @capiro/api typecheck` — passed, including its sequential TypeScript checks and `PE_PHASE_A_B_SAFETY_OK` safety script.
- No production credentials, external provider requests, rollout changes, or deployment actions were used.

## Fallback, cancellation, and budget semantics

The injected provider path uses the task registry timeout bounded by any caller deadline and resolves timeout/abort without waiting for a hung provider. Late provider settlement is observed but ignored. Fallbacks are explicit for off/missing credential/invalid config/inactive task/no eligible candidates/invalid candidate set/unknown candidate/version mismatch/malformed result/timeout/cancellation/provider unavailable. A caller that aborts before invocation receives `cancelled`; an in-flight abort also resolves as `cancelled`.

The JEV client construction path caps retries/calls at the registration's `costBudget.maxCalls` (currently one) and applies the registration timeout. This package does not claim a measured spend budget, a calibrated model, a validated decision threshold, or a production call-count/cost ledger. Since the current registry state prevents client construction, no provider attempt is made by the factory. Provider timeouts and cancellations are fallback-only; the adapter does not await eventual provider completion or report it as a completed claim.

## Residuals / acceptance limits

- No server eligibility derivation was added; any future caller must supply IDs from an independently reviewed server-side eligibility computation. The adapter validates that supplied subset but cannot prove its provenance.
- No current request path invokes the wrapper or adapter. A separate reviewed package is required before even dark per-request telemetry is wired.
- `capability_routing` remains inactive/off; the factory intentionally cannot create the JEV client under the current registry contract.
- There are no calibration, threshold, routing-quality, or operational availability claims. No claim-support routing was added or changed.

## Follow-up review: early timer cleanup

Review identified a temporal-dead-zone risk when the bounded assessment received an already-aborted signal or an elapsed caller deadline before timer initialization. The timeout handle is now optional until initialized, and cleanup clears it only when present. The regression test exercises both pre-abort and elapsed-deadline exits and asserts the provider is not invoked in either case. Reverification after this correction: adapter suite passed (1 suite / 9 tests) and `pnpm --filter @capiro/api typecheck` passed, including `PE_PHASE_A_B_SAFETY_OK`.
