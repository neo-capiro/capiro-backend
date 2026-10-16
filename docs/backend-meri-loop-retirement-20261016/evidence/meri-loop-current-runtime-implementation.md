# Current Meri runtime implementation review

Status: **SourceReviewClearPendingExecution**. Baseline premap commit `bca4368306defae1495ab69f088171a3fccfaf56`, derived from sealed PR34 `f3ede4fe8d88ba686a81c59f71e44319c0f45fd1`. No test, Node, compiler, framework, database or provider execution was performed by this lane. No commit or Git ref was changed.

The nine allocated source paths are listed with exact working-byte SHA256 values in `meri-loop-current-runtime-implementation.json`. The runtime contract derives its stream argument tuple from the current V3 service and its image port from the current visual service; all contract imports are type-only. The controller retains the `MeriService` DI token explicitly through `@Inject(MeriService)`. Its bearer/impersonation comment now describes the actual current V3 forwarding behavior without changing extraction or authorization code. The current V3 client's five-field resolved-AI type now lives in a neutral type-only file.

The proxy no longer declares, installs or calls the raw Phase-19 adapter. It still exposes retained raw non-stream operations, current V3 stream/refusal routing, progress and current visual image routing. A bounded one-time textual comparison against the baseline proved the entire `installV3Phase19Adapters` through end-of-file helper region unchanged after CRLF normalization. SHA256 of that LF-normalized region is `8e44ea843ebd3c36efceff4ca7753a2c69b884a6235b42863a150f4548d7b363`. A second comparison proved the entire `return new Proxy(raw, ...)` routing region unchanged after reversing only tuple/image type operands and the return type assertion. That region's normalized SHA256 is `00c8278ca04b899dc6b9d5ecb862d63e3aca86e13745e9447960178d5b931e11`. These hashes are evidence, not permanent test assertions.

Native proxy fixtures no longer require raw streaming or private raw prewarm/V2 fields; the two former no-fallback spy checks now assert the raw fixture lacks `streamMessage`. Native coverage fixture has no raw private fields. Existing V3 behavior and coverage assertions remain. The one Phase-19 prewarm source case now asserts current V3 installation/suppression and absence of the retired raw adapter; other Phase-19 cases are unchanged.

## Focused builtin controls

`scripts/ci/meri-loop-current-runtime.contract.spec.mjs` contains exactly **18 top-level cases**. It loads the entire actual small proxy and actual progress helper using `stripTypeScriptTypes`, with complete finite named-import substitution and fail-closed negative binding controls. There is no copied runtime implementation, legacy fallback loader, full god-service extraction, framework bootstrap, dynamic dependency import, old-body snapshot or whole-service hash freeze.

The explicit fake ports are Context Plane current context/observe, deterministic UUID, timers and raw/V3/visual/runtime dependencies. The timer binding locally shadows timers in the loaded actual progress helper; no real heartbeat is scheduled. Abort behavior uses a real `AbortController` behind a listener-tracking facade. Decorated services, controller and module are read only as source data. Native DI, TypeScript application compilation, Context Plane ALS, credential/security decisions, authorization, provider calls, persistence and attachment behavior are outside this qualification.

Cases cover current derived ownership/neutral fields, finite-import negative controls, constructor without raw seams and one-time V3 patching, closed/open gates, preparation order, exact optional argument identities/arity, abort before/during gate, error identity propagation, actual progress stages/frames/cleanup, current images, raw history/maintenance binding, provider alias/controller DI source ownership with negative mutations, current V3 KB/stream adaptation, signed initial coverage plus later-read receipts and malformed receipt fallback, and updated Phase-19 source intent.

Suggested parent-controlled invocation, not run here:

```text
node --max-old-space-size=128 --test --test-isolation=none scripts/ci/meri-loop-current-runtime.contract.spec.mjs
```

Parent owns the root single-process stage and any combined catalog updates. These 18 cases are source/fake-port controls, not native application acceptance. Root/other owners' raw service/module/V2 removal, lifecycle historical harness and RP work were not edited by this lane.
