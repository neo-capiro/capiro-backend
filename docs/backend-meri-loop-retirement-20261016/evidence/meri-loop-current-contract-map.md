# Current Meri contract after raw-loop retirement

Pre-edit source map: sealed PR34 `f3ede4fe8d88ba686a81c59f71e44319c0f45fd1`, branch `cleanup/backend-meri-loop-retirement-20261016`. Ordinary scoped source reads only. No production edit, Node/test/native/compiler/application/build/install or external feature/Core-authority source read. Parent reports no source-claim collision on the listed Meri/stream/client paths. This requested map is the only write.

## Selected design: remove the raw method; preserve the token and current proxy

Use a pure type-only `apps/api/src/meri/meri-runtime.contract.ts`. Derive the chat signature from the actual current V3 method, not the removed raw loop, and compose the current ordinary-token service with its retained nonstream domain:

```ts
import type { MeriService } from './meri.service.js';
import type { MeriV3ProxyService } from './meriv3-proxy.service.js';
import type { MeriV3VisualAnalysisService } from './meri-v3-visual-analysis.service.js';

export type MeriChatStream = MeriV3ProxyService['streamMessage'];
export type MeriStreamArgs = Parameters<MeriChatStream>;
export type MeriRuntimeService = Omit<MeriService, 'getArtifactImage'> & {
  streamMessage: MeriChatStream;
  getArtifactImage: MeriV3VisualAnalysisService['getArtifactImage'];
};

export interface ResolvedAiForChatHeader {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  model: string;
  usedTenantKey: boolean;
  modelOverridden: boolean;
}
```

`Omit` projects public raw-domain members and excludes its image implementation; it does not require any raw stream method, stub, private class fields or new runtime instance. Type-only class imports erase, so this contract introduces no Nest/provider execution cycle. The actual V3 method remains the sole chat signature authority, avoiding a second hand-maintained parameter list or V3 body edit.

Existing current stream positions remain: context, conversationId, body, SSE writer, optional AbortSignal, mode(default`new`), attachment IDs(default`[]`), optional bearer, optional impersonated tenant (`meriv3-proxy.service.ts:225-235`). Writer and rerun aliases are currently local at88-92; no change is needed to their implementation or V3 method bodies for this derived contract.

## Exact controller/provider/proxy seams

| Current source | Required narrow change / preservation |
| --- | --- |
| `meri.controller.ts:1-20,45,316-318` | Add Nest `Inject`, retain the **runtime value** import `MeriService`, type-import `MeriRuntimeService`, and annotate `@Inject(MeriService) private readonly service: MeriRuntimeService`. Merely changing the parameter type would emit Object/lose implicit class-token DI; the explicit injection is essential. |
| Controller stream386-460 and all nonstream calls | Preserve route, argument order, telemetry, AbortController, setup guard and domain calls. Update only stale comments claiming V2/impersonation fallback; the actual registered current gate is V3/refusal. No authorization/persistence/body behavior change. |
| `meri.module.ts:139-155` | Keep raw registration under `RAW_MERI_SERVICE`, maintenance `useExisting: RAW_MERI_SERVICE`, and the existing ordinary `MeriService` **token** provided by `createMeriRuntimeService` with the same four dependencies. No new service token or provider façade is needed. |
| `meriv3-runtime.proxy.ts:87-92,98-106,127` | Return `MeriRuntimeService`; stream arguments/forwarded tuple use `MeriStreamArgs` (or Parameters of the canonical current contract), and image arguments use the current visual member. Convert class imports used only for types to type-only imports so a pure proxy fixture does not load raw/Nest classes. A single documented construction-boundary type assertion is appropriate because Proxy.get provides the new stream member dynamically. |
| Proxy111-123 | Preserve exact current gate/refusal/governed/V3 control flow. Closed gate calls only current `streamUnavailable`; open gate prepares governed context then current `streamMessage`. No raw fallback, reroute or dead stub. |
| Proxy130-131 | Preserve nonstream binding to the original raw owner and scalar passthrough. This retains history, attachment upload/resolve, feedback, memory and maintenance semantics. |
| Raw `meri.service.ts:965-3251` | The raw stream implementation, its sole private V2 bridge and their inter-method documentation are the retirement slice; next retained artifact JSDoc begins3252. No `streamMessage` stub remains in the raw class. Other shared domain/maintenance methods remain. Parent owns raw-loop/helper closure. |

The raw `MeriService` class remains a legitimate domain/provider token; keeping that class import for DI is not keeping raw streaming authority. Active callers obtain chat typing only through the current contract.

## Remove only the raw Phase19 construction seam

Remove `RawMeriInternals` at `meriv3-runtime.proxy.ts:56-64`, the call `installRawPhase19Adapters(raw)` at93, and its function136-186. It exists only to patch raw private orchestration/recall/KB/V2 seams at construction; it must not keep private legacy stubs alive after retirement.

Keep the shared `PHASE19_PATCHED` symbol because the V3 installer still uses it. Preserve `V3Internals:66-70`, `installV3Phase19Adapters:188-194`, governed KB proxy196-207, stream-client proxy209-231 and completion reconciliation234-261 unchanged. These are current V3 authority: governed context enters the current client, unguided KB prewarm is suppressed during governed turns, and completed-turn tool receipts retain the signed initial coverage.

Maintenance must remain exact: module139-140/179; V3 injection131 and persistence->maintenance1208-1225; research injection345-347 and handoff4490-4496; raw scheduling3305-3325 plus indexing/compaction3334-3521. Do not replace the alias with ordinary `MeriService`, which would introduce a proxy/V3 dependency cycle.

## Decouple current credential header from retired V2 transport

The exact five-field interface currently lives at `meriv2-chat.client.ts:5-11`; current V3 imports it at `meriv3-chat.client.ts:12` and uses it at273. Move that unchanged type into the neutral current contract above and type-import it from there in V3. If V2 transport remains temporarily, it also type-imports/re-exports that neutral definition instead of defining a second one. If V2 is retired, no current import may point to its source.

This is a type ownership move only: no credential resolution, secret value, header bytes, model default or security policy change. V2 class/module/constructor removal and positional native-construction fixtures need their own coordinated source closure; parent owns that boundary and additional RP dependency handling.

## Current native test and source-contract changes

| Test / reference | Narrow handling |
| --- | --- |
| `meriv3-runtime.proxy.spec.ts:16-29,58-123` | Remove raw private-adapter/V2/KB mock requirements. Raw fixture should genuinely have **no** stream method; existing allowed/closed-gate cases must prove current V3/refusal works without it. Replace raw.streamMessage assertions with an independent access/call trap or absence check, not a mock typed as a deleted raw API. Retain regenerate, writer progress, image override and bound-nonstream tests. |
| `meriv3-runtime.coverage.spec.ts:41-65,69-136` | Remove raw constructor-only adapter mock fields. Preserve actual current V3-client input/coverage/reconciliation fixture execution and every existing malformed/fallback/non-done case. It never executes raw chat. |
| `phase-19-meri-context-plane.contract.spec.ts:24-31` | Deliberately replace the obsolete raw `loadRelevantMemories` suppression grep with current V3 governed-KB/client suppression and explicit no-raw-adapter ownership. Preserve its governed-context/no-bypass intent and all other Phase19 cases; do not retain dead text or weaken V3 assertions. |
| `meri-turn-maintenance.spec.ts:10-36` | Provider/alias contract remains valid and should remain unchanged. Its scheduler cases39-66 remain current. |
| `meri-turn-lifecycle.phase4.spec.ts:33-50,102-164` | Eight expanded cases directly run raw loop/native provider parsing, unlike the proxy mocks. Parent must map/retain these semantics or explicit historical cases before removing their implementation; do not count raw-method absence as their behavioral pass. Three independent archived-history cases63-100 remain current. |
| Current `meriv3-proxy.service.spec.ts` | Preserve current V3 service tests, including provider failure742, incomplete985, interrupted1016, deadline1036/1141, Stop1063, maintenance1168/1201, history/attachment1558/1879/1915/1945/1978/2006/2016 and unavailable2053/2092. Current types need not cause body/assertion edits. |

## Proposed builtin actual-source/fake-port controls

Use native `stripTypeScriptTypes` only on the small undecorated **actual current proxy** and, if progress behavior is included, the actual `meri-turn-progress.ts`. Do not import/evaluate the decorated raw service, V3 service, controller, module, Nest, Prisma, compiler or database. Resolve only explicit finite imports. Type-only current-contract imports erase. Substitute the Context Plane runtime getter with an explicit fake governed-context port and use the real small progress helper with controlled stage/timer/UUID ports; do not read or execute unrelated Core-authority source.

The progress helper has real timeout/interval/abort cleanup at `meri-turn-progress.ts:54-61,103-123`; fake timer ports must record creation and cleanup, with no sleeping/live interval. Current context-stage observer is a fixture port, not native Context Plane acceptance. A small runtime fixture supplies V3 client/KB fields for its preserved construction adapter, plus public stream/refusal/image/domain/maintenance fake ports.

Suggested18top-level controls (draft count only, no cases run):

1. Contract imports current types and neutral AI header; raw source has no stream declaration and active proxy has no raw stream Parameters/private installer.
2. Construct actual proxy over raw with no stream/private seams; trap getters for retired raw orchestration/recall/V2 fields and require zero touches.
3. Gate off: one flag check, current unavailable dispatch, no governed preparation or V3 turn, no raw access.
4. Gate on: one governed preparation before one current V3 stream, original effective context preserved.
5. Omitted optional args: governed mode is `new`; preserve existing forwarded argument arity and V3 defaults rather than appending synthetic values.
6. Regenerate/resend, attachment IDs, bearer, impersonated tenant and signal retain exact positions/identities; no bearer-driven raw fallback.
7. Already-aborted input refuses before flag/model/refusal dispatch; no timer/stage residue.
8. Abort while gate resolves: preserve exact current behavior, assert no V3/provider execution. Existing open-gate code enters runChatTurn before its callback's second abort check; do not claim zero governed preparation where source does not promise it.
9. Progress wrapper forwards canonical frames through its observed writer and does not invent acceptance/tool work; fake timer/stage observations exercise progress only.
10. Abort, done, error and thrown execution clean fake timers/listeners; progress-write failure does not replace the canonical result.
11. Flag/governed/V3 thrown errors propagate unchanged and never trigger fallback or false completion.
12. Image dispatch exclusively calls the current visual port with exact args/result; raw image getter/call trap remains untouched.
13. Other methods bind `this` to the original domain; scalar properties pass through and current history methods remain usable.
14. Maintenance method stays bound to raw; no extra maintenance instance/proxy cycle is constructed.
15. Preserved V3 client adapter attaches governed context and suppresses KB snapshot only in an active governed turn; unguided behavior stays unchanged.
16. Preserved done reconciliation retains signed initial context plus later-read receipts; malformed/no-receipt fallback and non-done pass-through remain exact.
17. Finite provider/controller source graph requires ordinary class token->factory, raw class token->maintenance alias, four factory dependencies and `@Inject(MeriService)` with the current parameter type. Negative mutations to raw injection/Object inference/ordinary-token maintenance alias fail. No whole module/service hash.
18. Current credential-header import has no V2 path dependency; contract field shape remains exact and constructor/provider retirement is named separately. No credential values used.

These controls qualify actual small proxy/helper logic against explicit fake ports and current source ownership only. Native Nest DI/typing, V3/application behavior, transport integration, histories/attachments/maintenance persistence and release/runtime acceptance remain shared-queue checkpoints. No test or source acceptance is claimed by this design map.
