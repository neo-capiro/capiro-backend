# Independent current-turn RP migration review

Read-only source review on 2026-10-16 against sealed PR34 `f3ede4fe8d88ba686a81c59f71e44319c0f45fd1`. Reviewed the root-written native `apps/meriv2-orchestrator/src/meri/research-portfolio-current-turn-dispatch.spec.ts`, builtin `scripts/ci/meri-current-turn-dispatch.contract.spec.mjs`, actual current executor/stores/binder/transport/execution-control/classifier, current controller/Core guard chain, old pinned RP test, capture receipts and case ownership data. No test, Node, TypeScript parser, compiler, native framework, application or Git/ref mutation executed by this reviewer. Ordinary source/Git reads and in-memory source-text comparisons only; this review file is the sole write.

**No concrete source or obvious native-fixture/type blocker found for the22-case current RP landing.** This is source-level acceptance; native execution and authentication/resource qualification remain distinct.

## Exact old-to-current identities

Independent source comparison found19 names in the original pinned `ResearchPortfolioMeriTurnBinding.spec.ts`,19 in the new native suite and19 in the builtin suite. Both new arrays match the old array **in exact order and spelling**, with19 unique names. Each new suite retains all22 expanded security identities:19 retarget refusals; omitted/exact current conversation; ordinary-native conversation compatibility; and null/empty/non-string retarget refusal. The native `beforeAll` and builtin setup also compare that finite list to the actual current canonical binder's list.

The new native cases instantiate the actual `ApiToolExecutorRepo`, use actual `RequestCredentialsStore` and `withTrustedCurrentTurnScope`, and spy on fetch. Every retarget case asserts rejection before fetch, rather than invoking an extracted raw-loop fragment. Positive RP cases assert the complete version1 envelope, current conversation and actor/client scope, bearer forwarding and service identity header. The ordinary-memory case asserts its supplied conversation remains ordinary unwrapped input. Malformed target cases retain rejection and zero-network assertions. No dead raw loop or copied raw execution implementation is needed for this coverage.

The native fixture uses the existing orchestrator test import conventions and the actual constructor/store signatures. The fake Config get function supplies only the fixture service identity; existing defaults supply URL/timeout. The fetch replacement returns an actual Response and is restored after each case. The ordinary search-memory response has the real shared classifier's finite empty-result/coverage fields. No obvious fixture/type error was found by source inspection; this is not a compiler result.

## What the builtin execution actually exercises

The builtin suite strips and imports the actual current executor, both AsyncLocalStorage stores, current conversation binder, RP envelope builder, execution-control adapter and canonical shared result classifier. Its finite import inventory refuses unknown ports and dynamic imports/require. Explicit fixture ports are Nest Injectable/Logger/Config tokens and telemetry; the empty meriv2-core module accounts only for erased inline type bindings, not substituted runtime logic. Fetch is a local spy, not a network call. The Core-facing classifier adapter currently reexports the same reviewed shared classifier; production classification was not changed to make the fixture pass.

Additional executed source controls cover absent trusted scope, malformed actor UUID, absent service identity, absent request credentials, immutable/nonleaking trusted scope and retention of the native22-case landing. Thus28 top-level builtin cases include the22 migrated identities plus6 additional controls; they are not50 independent security cases when combined with the unrun native suite.

Captured parent receipt `meri-loop-rp-current-pass.json` records exit0, PID28256, max-old-space-size128, test-isolation none,120-second hard wall and observed peak65,773,568 bytes. Its stdout reports28 passes, zero failures/skips. This reviewer read that result, not executed it.

Both earlier author failures remain recorded: the first rejected an unowned empty inline-type import from `@capiro/meriv2-core`; the second ran27/28 and rejected an invalid fake `search_memory` owner result through the actual classifier. The explicit empty-type port and corrected canonical empty-memory fixture resolve those author defects without changing production guards, weakening classification, skipping a case or replacing assertions with pass-through behavior. The native22 remain **UNRUN**.

## Production provenance / authority trace

The source chain is intact:

1. Both current V3 controller entry paths resolve identity and call `authenticateGovernedContext` before establishing trusted turn scope; streaming authenticates before opening SSE. That function calls `verifyMeriGovernedContext` with the governed bundle, DTO, resolved actor and configured service identity. `trustedCurrentTurnScope` derives tenant/user from that resolved identity and conversation/client from the authenticated DTO.
2. `withTrustedCurrentTurnScope` freezes a copied finite scope in AsyncLocalStorage. Actual `ApiToolExecutorRepo.execute` requires request credentials, binds the canonical RP input before request construction, requires service identity, and builds the typed finite envelope before fetch. Cross-conversation and malformed scope cannot reach the test's fetch spy. Deadline/cancellation controls remain actual code and are disposed in finally.
3. Core's guarded tool controller still calls `admitMeriResearchPortfolioToolTransport`, which independently checks configured service identity, envelope shape/UUIDs and tenant/user equality against the authenticated TenantContext, then sets the Core request-local RP scope around canonical dispatch.
4. `MeriToolsService.executeScoped` still delegates canonical RP names through `executeMeriResearchPortfolioToolAtCurrentUse`. That guard binds actor/conversation, reloads the owned unarchived conversation, checks selected client, resolves current RP grant, rereads conversation and rejects client/metadata drift before calling the canonical RP owner.

Bounded diffs against f3 show no changes to the actual current executor, binder, typed transport, request stores, V3 controller, Core RP transport/current-use guard, canonical MeriTools or shared result classifier. The new tests do not modify those implementations.

The suites deliberately inject a trusted scope and fixture credential. They do **not** authenticate a caller, verify an issued signature through HTTP, grant RP access, exercise Core database/RLS/grant drift, qualify Nest DI or replace existing actual HTTP/current-owner tests. Their value is the actual current pre-network dispatch behavior under an admitted trusted-turn premise, with the production provenance chain reviewed separately. No source-coverage result is presented as authentication qualification.

## Retirement, historical provenance and quick preservation checks

The old helper's sole production import/calls were inside the removed raw loop; the old spec extracted that raw implementation. The current finite tracked exact-name pass now finds no remaining `bindResearchPortfolioToolConversation` reference in admitted application/package/script/test/infra source. With the22 safety obligations landing on the actual current executor, the old raw-only helper/spec can retire from active discovery. Their original source pin/blob and22 expanded identities must remain in the final historical manifest, with an explicit old-ID/new-current-ID mapping. The original helper/spec need not stay as dead current runtime code.

The pending historical ledger arithmetic is correct: **71 = 8 raw lifecycle +4 V2 client +5 V2 helper +32 V2 matrix +22 raw RP fragment identities**. Those are original historical provenance, not executed passes; the final manifest must retain their immutable f3 source/tree/blobs and separate **UNRUN** qualification. The new native22 and builtin28 results do not qualify historical native replay. Final manifest/receipt publication remains pending the parent's integration work.

Quick source preservation reads also confirm:

- All four positional fixture diffs still contain only the five former V2-slot dummy deletions. Existing feedback, legal-hold, creation, attachment assertions and collaborator expressions remain unchanged.
- The archived-history describe from original lifecycle lines63–100 is exactly current lines12–49. Independent UTF-8 source comparison matches every character/byte and SHA256 `07ae19acb94399f7c2bf847429a0f604e0c08010e1d2b99e769eda5c3e371bd4`, consistent with `meri-loop-native-split.json`. All3 expanded archive cases remain current; the8 raw-loop lifecycle cases remain separately historical/unrun.

No broader RP/auth/tenant/memory/Florida authority redesign, historical PASS, native/build/platform/runtime or deployment acceptance is asserted.
