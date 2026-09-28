# Combined capture qualification

## Disposition

Scoped PASS for the combined server-readonly capture integration at integrated base `be175dc78d2e63199c1a2b8116234345b5d6fc1a` on `codex/meri-foundation-20260928`, with the bounded integration correction committed as:

- Final SHA: `bdf1daf05e0414f1c7267b21756c47591d90423e`
- Commit: `fix(meri): preserve capture policy in discovery`

This is local source/test qualification only. It is not LIVE, deployment, provider, cloud, shared-database, main-branch, routing, feature-flag, or release authorization.

## Combined issue and correction

Before correction, initial `leaseAuthorizedSchemas` excluded `run_analysis` during server-owned capture, and the actual dispatch guard still denied it, but the fresh progressive-discovery `currentCatalog` intersection and current-disclosure authorization callback did not independently retain that capture-only exclusion. That left the fresh-catalog layers dependent on the constructor-time omitted-name set and final dispatch guard.

The correction preserves the capture exclusion at all three schema-disclosure layers:

1. initial lease-authorized schemas;
2. fresh progressive `currentCatalog` intersection;
3. `authorizeCurrentDiscoverySchema` before search/describe/load admission.

The actual dispatch guard remains after the current research-run check in `executeFunctionCalls`; it was not moved or weakened. Governed transport remains read-only and the server-issued bound procedure remains the source of procedure instruction/policy. No caller-controlled procedure or capture authority was introduced.

A combined actual-assistant regression runs under a valid trusted capture scope with enabled progressive discovery and a fresh API catalog containing `run_analysis`. It drives `tool_search`, `tool_describe`, and a direct undeclared invocation attempt. `run_analysis` is absent from every provider schema payload, search returns no available match, describe reports unavailable, the direct attempt is blocked, and the canonical registry handler has zero calls.

The API capture test fixture also gained the missing eleventh `MeriController` constructor dependency placeholder required by the combined current controller signature. This was a test-construction integration repair; production controller behavior was not changed.

## Committed scope

Only these paths are in `bdf1daf05e0414f1c7267b21756c47591d90423e`:

- `apps/api/src/meri/meri-server-readonly-capture.spec.ts`
- `apps/meriv2-orchestrator/src/meri/meriv3/meriv3-assistant.service.ts`
- `apps/meriv2-orchestrator/src/meri/meriv3/meriv3-assistant.service.spec.ts`

No test or gate was weakened.

## Verification

All commands used existing native Node `v22.23.3`, existing private dependencies, `--max-old-space-size=8192`, and `--experimental-vm-modules` where used. No install or relink was performed. Every bounded command reached an exact process exit.

Builds, in required order:

- `packages/shared`: native TypeScript build, exit 0 (`proc_57b2a27ed655`).
- `packages/meriv2-core`: native TypeScript build, exit 0 (`proc_789604088f30`).

API capture/runtime suites:

- `meri-server-readonly-capture.spec.ts`: final exit 0, 1 suite, 13/13 tests (`proc_6401178cbff4`).
- `meriv3-proxy.service.spec.ts`: exit 0, 1 suite, 58/58 tests (`proc_02dbf8d6415c`). This current combined suite is larger than the prior 50-case receipt.
- `meriv3-runtime.proxy.spec.ts`, `meri-tool-request-control.spec.ts`, `meri-strategy-context.integration.spec.ts`: exit 0, 3 suites, 25/25 tests (`proc_da73b92b491e`).

Combined orchestrator regressions:

- Capture dispatch, progressive discovery, semantic gateway, governed selection, procedure guard, current-authority, authenticated context, and full assistant service: exit 0, 8 suites, 182/182 tests (`proc_9aa36d945b54`).
- Final post-Prettier combined capture/progressive regression: exit 0, 1 selected test passed, 108 skipped, 109 collected (`proc_01c431e43495`). The same chained command then completed orchestrator TypeScript with exit 0.

Independent actual-source probe:

- Adapted the prior independent 11-case actual-function harness in this profile's scratch directory to import this exact combined checkout and supply the current `MeriResearchService.authorizeModelContext` constructor dependency.
- Final exit 0, 1 suite, 11/11 tests (`proc_abc609ec406f`). It exercised actual V3/V2/raw service methods, after-microtask membership/wall/client withdrawal, cancellation plus revocation, keepalive/private-frame separation, authorized receipt release, both V2 withdrawal timings, both raw-loop withdrawal timings, ordered/idempotent release, and byte/chunk overflow denial.
- Scratch paths: `C:/ProgramData/Hermes/profiles/meri-foundation-memory-ui/cache/scratch/capture-combined-actual-functions.spec.ts` and `capture-combined-jest.config.cjs`. Product source was not changed for this harness.

Typechecks and formatting:

- API native `tsc --noEmit --rootDir .`: final exit 0 (`proc_491432390313`).
- Orchestrator native `tsc --noEmit -p tsconfig.json`: final exit 0 (`proc_01c431e43495`; earlier standalone final-source run `proc_e0427a578cea` also exited 0).
- Repository Prettier `--write` followed by `--check` on only the three committed source/test paths: exit 0; all matched files use Prettier style (`proc_b2400c92f3b4`).
- Final `git diff --check` and cached diff check: exit 0 (`proc_fc2eb527d066`).
- Assigned test paths were checked and all exist (`proc_34f80f3ced5c`).
- ESLint: NOT_RUN. The executable existence check reported `ESLINT_EXECUTABLE_MISSING`; no wrapper retry or install was attempted.

Diagnostics not used as passing evidence:

- The first independent harness run exited 1 with 5/11 passing because the old frozen harness lacked the current required research-context dependency. The scratch-only harness was adapted; final 11/11 passed.
- The first API typecheck exited 2 because the integrated capture spec constructed `MeriController` with 10 arguments while the current combined constructor requires 11. The bounded test fixture was corrected; final API typecheck and 13-case capture suite passed.
- Preliminary focused combined-test runs found one fixture type mismatch and two assertion-shape mismatches. Only the new test was corrected; the final selected regression, 182-test combined orchestrator run, and typechecks passed.

## Protected lead-owned documents

The five preexisting lead-owned modifications remain byte-identical to their starting hashes, unstaged, and are the only remaining worktree modifications:

- `THIRD_PARTY_NOTICES`: `43b9eed98820a9d66c867af0d9fcbeb3da4f1bd2b46d90989a84e323c1364d6d`
- `docs/meri/implementation/01-requirements.md`: `0af15aed8c2c1bed051db6ef3fe05935a385a310a0265518b995d7eb066e70e5`
- `docs/meri/implementation/01-source-acquisition.md`: `b2a289bc98ba0c5e4a9d09df23bdf18fc70ecccd39c0ac2a4700b9b72ff0d253`
- `docs/meri/implementation/01-source-inventory.json`: `8c3e5eaeddcde38f8e1d874c4543cfc2a1036347c00ebef7626f93ea8c76f058`
- `docs/meri/implementation/STATUS.md`: `a783bede178b28bac8668c189fe38f3b0d64efdcda28c51972aed5d447cfa8d5`

Final `git status --short` lists exactly those five paths as unstaged. None was edited, staged, or committed by this qualification.

## Preserved boundaries and limitations

The selected combined suites retain current research-plan/lease checks, current procedure validation, signed procedure instruction ownership, report-context authorization, progressive current-catalog checks, unknown-tool redaction, run-budget controls, current-owner replay checks, read-only transport, output fencing, and actual dispatch denial. No source evidence was found of a capture path replacing those checks.

The output fence remains a point-in-time current-authority check followed by synchronous buffered release, not an atomic cross-process revocation transaction. Controlled mocks and sinks are not live-provider, shared-database, browser, cloud, or deployment evidence. No root monorepo sweep, full CD7/live75, provider call, shared DB, main operation, push, deploy, flag/routing change, or delegation was performed.
