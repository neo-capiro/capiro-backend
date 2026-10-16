# Raw Meri loop retirement boundary map

Source: `0483963adc5382202408e8398d8b1601f53d8525`, branch `cleanup/backend-meri-domain-20261016`, own task10/backend-cleanup checkout. Bounded Meri source/module/controller/test reads and named Meri/Phase19 script references only. No application edits, tests, Node/native/compiler/build/install, live flags, cloud, database, feature-branch or unallocated Core-authority source reads.

## Concrete method-level candidate

The old raw full-chat implementation is a separable candidate despite the continued need for the raw service. The registered HTTP route cannot reach its loop at this source pin:

| Entry / owner | Exact reference and behavior |
| --- | --- |
| HTTP full chat | `meri.controller.ts:386-392,447-460` mounts `POST clio/conversations/:id/stream` and calls injected `MeriService.streamMessage`, forwarding context/mode/attachments/bearer/impersonation. |
| Ordinary token | `meri.module.ts:139-155` creates raw `MeriService` under `RAW_MERI_SERVICE`, then provides the ordinary `MeriService` token via `createMeriRuntimeService(raw,V3,visual,governedRuntime)`. The module exports only tools/flags (`:267`), not the raw service token. |
| Current stream decision | `meriv3-runtime.proxy.ts:98-123` intercepts every ordinary-token `streamMessage` access. Closed `meriv3.shouldHandle` calls `streamUnavailable`; open calls governed preparation then V3 `streamMessage`. Neither branch invokes raw `streamMessage`, regardless of bearer/impersonation. `meri-feature-flags.service.ts:85-93` documents and implements this two-key V3/refusal gate. |
| V3 unavailable behavior | `meriv3-proxy.service.ts:156-214` persists the user/assistant unavailable receipt and emits classified error/done without model/tool fallback. V3 missing URL/bearer also returns its own error/done (`:247-279`), never raw fallback. |
| Raw legacy loop | `meri.service.ts:965-2727` is the raw public method. Its only V2 branch calls the private bridge at `:1513-1556`; the provider/model/tool loop follows at `:1559` onward. |
| Raw V2 bridge | `meri.service.ts:2742-3250` is private, with the sole source call at `:1526` inside that raw public method. Its JSDoc begins2729; the next retained artifact method's JSDoc is3252. Removing the legacy stream region must preserve the latter boundary. |

The relevant native proxy tests positively pin no raw call for closed and allowed V3 turns (`meriv3-runtime.proxy.spec.ts:58-86`). This is source reachability evidence, not a live routing or executed test receipt. No global claim about arbitrary reflective/manual consumers is made beyond the finite search scope below.

## Construction-only dependencies to decouple with the loop

`createMeriRuntimeService:93` **always** invokes `installRawPhase19Adapters`, even though ordinary streams never enter the raw method. That installer is not evidence the loop executes: it binds/patches private seams at construction, before any turn.

- `meriv3-runtime.proxy.ts:56-64` declares `RawMeriInternals`; `:136-178` binds `raw.orchestrateContext` and substitutes governed prompt/source metadata; `:180-185` binds/patches `loadRelevantMemories`, proxies raw client-KB prewarm and raw V2 transport.
- If those private methods are later removed without also removing this installer/type/call, factory construction throws at `.bind`. Therefore retire the raw installer seam as part of the same bounded change; do not retain pointless private stubs solely to satisfy it.
- Retain `installV3Phase19Adapters:188-194`, `governedClientKbProxy:196-207`, `governedStreamClientProxy:209-231` and done-frame reconciliation234onward. They actively adapt the current V3 client and preserve signed initial/later-read coverage. `meriv3-runtime.coverage.spec.ts:41-65,69-136` invokes the actual patched **V3 client**; raw mock fields are construction prerequisites, not calls of the legacy loop.
- The public factory/controller types still reference `MeriService['streamMessage']` (`proxy:99,106`) and ordinary-token callers need its signature. Minimal removal can retain the signature as an explicit fail-closed raw-only seam, or introduce a narrow typed chat façade while retaining the nonchat domain owner. Do not route a raw direct call back through DI to V3 and create a maintenance/proxy cycle. Do not leave a silent legacy fallback.

## Raw domain and maintenance that remain active

This is not a whole-file/provider retirement:

- Proxy `get:130-131` binds all other methods to raw. Controller current calls are `listConversations:337`, `createConversation:342`, `searchConversations:354`, `getConversation:359`, `updateConversation:368`, archive/restore:373/378 and `listMessages:383`; artifact edits:719, feedback:730, upload:750, attachment text:764 and memory methods914/934/943 remain current.
- Preserve raw history/message/authorization prefix `meri.service.ts:405-964` and its existing retained domain helpers. Stream-specific code currently reuses these; removing the stream must not remove the shared definitions.
- `MERI_TURN_MAINTENANCE` is `useExisting: RAW_MERI_SERVICE` (`meri.module.ts:139-140`), avoiding a proxy cycle. Current V3 injects this token (`meriv3-proxy.service.ts:131`) and calls it after assistant persistence (`:1208-1225`). Research injects the same token (`meri-research.service.ts:345-347`, module179) and schedules after saved conversation handoff (`:4490-4496`).
- Preserve `meri.service.ts:3305-3325` scheduling and parallel maintenance, `indexRecentMessagesForSearch:3334-3397`, and protocol-safe compaction3404-3521. Those are active current V3/research dependencies. Compaction's tenant/actor/client/boundary/revision fence stays untouched (`:3493-3515`). `meri-turn-maintenance.spec.ts:10-36` pins the raw alias; scheduling/failure cases39-66 remain. `meri-protocol-compaction.service.spec.ts:51,82-83,94,110` directly exercises the retained private compactor.
- Preserve search3570onward, artifact edit5392onward, feedback5575onward, upload5809onward, attachment-row creation5987onward and public memory/alerts methods. Keep the existing tests and authority boundaries; this map does not allocate their redesign.

The residual private legacy helpers (`orchestrateContext`, intent/verification/prompt/suggestions/recall/autolearn) are a second call-graph slice. Their continued definitions do not by themselves preserve the raw loop, but remove them only after separate local/shared/dynamic-test consumer proof. The minimal first slice can leave them and constructor/provider shape intact.

## Native direct callers and test/source-contract prerequisites

| Consumer | Classification / required treatment |
| --- | --- |
| `meri-turn-lifecycle.phase4.spec.ts:33-50,102-164` | **Genuine direct raw-loop execution.** Prototype-based harness invokes raw `streamMessage`, with actual native provider-SSE parsing. Expanded cases cover in-band error1, final-round Stop1, provider finish3 and failure/Stop/timeout3. Before retirement, map these8semantic cases to current transport/runtime coverage or explicit pinned historical replay; do not drop them, count a new raw refusal as their pass, or copy the obsolete implementation into a new active test fixture. |
| Same file `:63-100` | Three archived history/restore cases are independent of raw streaming. Preserve current tests and methods; no reason to archive/remove this whole file. |
| `meriv3-proxy.service.spec.ts` | Actual direct current V3 calls, not raw calls. Existing current behavior includes provider failure742, incomplete985, interrupted1016, deadline1036/1141, post-round Stop1063, after-turn failure1168 and persisted id/maintenance1201; protocol/history/attachment cases1558,1879,1915,1945,1978,2006,2016 and unavailable2053/2092 remain. They are relevant landing points for semantic case mapping, not automatic equivalence to the old Anthropic parser. |
| `meriv3-runtime.proxy.spec.ts:16-29,58-123` | Raw is a mock. Assertions explicitly require raw stream/image nonuse and nonstream delegation. Update only obsolete raw private mock construction fields when removing the installer; preserve all routing/refusal/progress/delegation cases. |
| `meriv3-runtime.coverage.spec.ts:41-65` | Raw mock exists to satisfy construction; execution is V3 client adaptation. Remove obsolete mock requirements while retaining every current reconciliation case. |
| `phase-19-meri-context-plane.contract.spec.ts:24-31` | Source-contract dependency: existing case requires raw `loadRelevantMemories` suppression text. This assertion becomes obsolete with removal of that code. Deliberately replace/qualify its raw-prewarm ownership expectation while retaining current V3 governed KB/client suppression, signed context and no-bypass intent. Preserve other Phase19 cases. Do not keep dead raw adapter text just to satisfy this source grep. |
| `meriv2-routing.helpers.spec.ts` and `.matrix.spec.ts:7-35` | Pure legacy helper tests, not raw dispatch or production routing evidence. Matrix comment saying V3 declines into raw is stale against current proxy111-120. Keep their historical/semantic/provenance accounting if helper retirement is later allocated; they need not block removal of its sole raw call. |
| `meri-turn-maintenance.spec.ts:10-36` | Active source registration contract. Retain alias/provider as-is for the minimal loop slice; a later maintenance/domain extraction must deliberately update this exact contract. |

Current histories/attachments already have their own V3 implementation: `meriv3-proxy.service.ts:282-347` authorizes conversation, persists current user/attachments and rerun plan; assistant persistence and current maintenance are separate at1208-1225. These existing paths should be preserved byte-for-byte by raw-loop removal, with native qualification queued by the parent.

## V2 client/provider follow-up boundary

`this.meriV2Chat` occurs only at constructor358, the raw routing branch1514/1520 and bridge2987 in the admitted raw class. The module still registers the client199. These are construction and legacy transport dependencies, not ordinary HTTP stream ownership. First remove the loop/adapter without blindly changing positional constructors used by existing domain tests. A later narrow constructor/provider cleanup must update those tests coherently.

Do **not** delete `meriv2-chat.client.ts` wholesale with the bridge: current `meriv3-chat.client.ts:12` imports its `ResolvedAiForChatHeader` **type**. Extract/rehome that shared type or retain the file before client retirement. Keep independent V2 client tests/provenance until that follow-up is admitted. Orchestrator V2/V3 roots, shared meriv2-core and other surfaces are not allocated for deletion by this loop map.

## Minimal concrete sequence

1. Freeze source/case manifest for these exact loop/adapter/test boundaries and coordinate current Meri/history owner claims. Keep protected current authority/history/attachment/maintenance source outside the edit claim.
2. Retire only the raw public-loop implementation plus its sole private V2 bridge; retain signature/refusal compatibility or add a narrow façade. Remove the raw Phase19 installer/type/call in the same focused slice, leaving current V3 adaptation and raw nonstream/provider/maintenance registration intact.
3. Preserve/map the8direct raw lifecycle cases and3independent archived-history cases. Update the specific obsolete Phase19 source assertion and construction mock fields without weakening current V3 refusal/context/coverage/delegation controls. Leave unrelated helper/provider/client cleanup for proven follow-ups.
4. Run focused native/type/source checks only through the parent/shared queue, followed by integration checkpoint coverage for histories, attachment reload/regenerate, unavailable/gate/refusal, after-turn maintenance and scope persistence. This analysis itself runs none and makes no deployment/live-retirement claim.

## Exact baseline Git objects

All entries mode100644 at0483963:

| Path under `apps/api/src/meri/` | Blob |
| --- | --- |
| `meri.service.ts` | `8878d515849c36ce037a9fc8591e46bbb06e65b2` |
| `meriv3-runtime.proxy.ts` | `28f02937c824fdbf1f6655f87bd94a52969aa360` |
| `meri.module.ts` | `a17e94efba349979236ed1dbada4be4c17cf8f02` |
| `meriv3-proxy.service.ts` | `87b8d9b925fd76e48f3acd6970da9dfb22278713` |
| `meri-turn-lifecycle.phase4.spec.ts` | `88a482005990d910c9dbaa7bbff3836f51b6dad6` |
| `meri-turn-maintenance.spec.ts` | `29e084dbe253e4b566a14bdf0a6cb06f84bce876` |
| `phase-19-meri-context-plane.contract.spec.ts` | `933e4424d586d85dba888c7a35c6d75d5f0b0779` |

Search scope: finite targeted symbols in `apps/api/src/meri`, `scripts/ci`/Meri-or-Phase19-named `scripts` files and Meri-named `apps/api/scripts` files. The latter found only a durable-controls test provider mock (`meri-durable-controls.http.integration.spec.ts:181`), not another raw stream call. No complete repository/dynamic/live consumer closure is implied; this is a concrete local retirement boundary with explicit prerequisites.
