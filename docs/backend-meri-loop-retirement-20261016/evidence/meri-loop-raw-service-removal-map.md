# Pre-edit raw Meri loop / V2 bridge removal map

Source: sealed PR34 `f3ede4fe8d88ba686a81c59f71e44319c0f45fd1`, isolated branch `cleanup/backend-meri-loop-retirement-20261016`, task10/backend-cleanup. Bounded source/Git reads and finite in-memory lexical reference analysis only. No Node, test, TypeScript parser, compiler, application, provider, install or deployment executed. No application source edited. This map is the only file written by this analysis.

## Exact two-region candidate

`apps/api/src/meri/meri.service.ts`: mode100644, Git blob `8878d515849c36ce037a9fc8591e46bbb06e65b2`, 293,118 Git bytes. This is unchanged from the earlier 048 source map, but the conclusions below are checked against sealed PR34.

| Owner | Method span inclusive | Complete proposed owned region | Boundary to preserve |
| --- | ---: | ---: | --- |
| Raw `streamMessage` | 965–2727, 1,763 lines | 963–2727, 1,765 lines, including its SSE section heading and following blank | Retained `currentProfile` closes961; blank962 remains |
| Sole raw `streamMessageViaMeriV2` bridge | 2742–3250, 509 lines | 2729–3250, 522 lines, including its own JSDoc | Blank3251 and artifact-image documentation3252 remain |

The complete two-region proposal is **2,287 physical lines**, retaining the separator at2728. Do not extend through the retained artifact method. The prior map's bare method ranges omitted the raw section heading and bridge documentation; both method and owned-region counts are explicit here.

Retire both methods entirely. Do not retain a raw refusal stub, dead compatibility facade, copied active loop fixture, or a DI redirect back into V3. The shared stream signature belongs to the current runtime contract after this removal.

The sole bridge call is inside the removed raw method at1526. `this.meriV2Chat` is used only by the raw route gate1514/1520 and bridge2987, plus its constructor declaration358. `shouldRouteMeriV2FullChat` is called only at1518 in admitted Core production source. Its helper/tests are not evidence that current HTTP routes reach the raw loop.

## Current routing, signature and construction adapter prerequisites

Current `meriv3-runtime.proxy.ts` is blob `28f02937c824fdbf1f6655f87bd94a52969aa360`. Its ordinary-token property interceptor at98 returns the V3-only/refusal stream. Closed V3 gate refuses via `streamUnavailable`; open gate enters `governedRuntime.runChatTurn` then V3. Neither path invokes raw `streamMessage`. Every other property still binds to the raw instance at130–131. This is finite source reachability, not live adoption evidence.

Removing the raw method requires replacing both `Parameters<MeriService['streamMessage']>` references at99/106 and the factory's ordinary-runtime return contract, not leaving the old type as a reason for a stub. Preserve this current signature in a narrow runtime contract:

`(ctx: TenantContext, conversationId: string, body: string, sse: { write: (data: string) => void }, clientSignal?: AbortSignal, mode?: 'new' | 'regenerate' | 'resend', attachmentIds?: string[], bearerToken?: string, impersonateTenantId?: string) => Promise<void>`.

`meri.controller.ts` blob `598e9146e5568349f213cbd548de0213113dc924` injects `private readonly service: MeriService` at317 and invokes its stream from the existing route. If the field becomes an interface/intersection runtime type, preserve the Nest token explicitly with `@Inject(MeriService)`; otherwise emitted metadata can become `Object`. This is a type/injection seam, not an authority or route redesign. Retain the class token for domain methods and current providers.

The current factory always invokes `installRawPhase19Adapters(raw)` at93. Remove that call, `RawMeriInternals` at56–64 and the raw installer at136–186 coherently. The installer binds `orchestrateContext`/`loadRelevantMemories` and patches raw V2/client-KB members; it is construction coupling, not a live raw-loop caller. Do not retain meaningless raw members solely for these binds.

Keep current `installV3Phase19Adapters` at188–194, governed client-KB/stream proxies196–231, packet normalization and done reconciliation. `PHASE19_PATCHED`, `StreamClient`, `ClientKbLike`, `currentMeriGovernedRuntime` and `MeriGovernedTurnContext` still serve current V3 adaptation; removing the raw adapter is not their retirement proof.

## V2 provider / constructor closure

`meri.module.ts` blob `a17e94efba349979236ed1dbada4be4c17cf8f02` imports `MeriV2ChatClient` at73 and registers it at199. Raw `MeriService` constructor is347–383. Its zero-based parameter order is:

| Index | Parameter |
| ---: | --- |
| 0–3 | prisma, config, tools, clientKb |
| 4–6 | mcp, firmSkills, aiCredentials |
| 7–9 | memoryIngest, memoryCandidates, meriFlags |
| 10 | **meriV2Chat** |
| 11–12 | claimWriter, contextCompiler |
| 13–15 | cleanupOutbox, learningSignals, qualityTelemetry |
| 16–18 | bizdevScope, researchPortfolioScope, contextPlane |

Retiring only slot10 changes every later position by minus one. The admitted literal `new MeriService` search over tracked `apps packages scripts tests infra` found five Core constructions in four files, plus an unrelated Strategy service constructor. The five Core sites are:

| File | Construction | Exact collaborator constraint | Blob |
| --- | ---: | --- | --- |
| `meri-feedback-learning-signal-resilience.spec.ts` | 44 | Remove only old slot10 dummy; retain cleanupOutbox `undefined` old13→12 and `learningSignals` old14→13 | `7f11cfb1234fdd634000866bc44e12c22481b59e` |
| `meri-memory-legal-hold.spec.ts` | 54 | Remove old slot10 dummy; memoryIngest remains7; later dummies shift, legal-hold/audit assertions remain unchanged | `cec6e2fef5da8fa26148a75501752d78a69edc9a` |
| `meri.service.create-conversation.spec.ts` | 62 | Remove old slot10 dummy; final supplied bizdevScope old16→15; preserve actual authorization/assertions | `5f6ba044f4124f8f2ee9b73ce25dfe6882c1d718` |
| same file | 207 | Same one-dummy removal; real scope resolver old16→15 | same blob |
| `meri.service.upload-attachment.spec.ts` | 49 | Remove old slot10 dummy; actual aiCredentials stays6; preserve all byte/extraction/authority cases | `39b8b54269730b0d685d58d69598ef47c32eda32` |

No `Reflect.construct(MeriService,...)` or `ConstructorParameters<...MeriService...>` Core fixture was found in the admitted searches. The Reflect construction at `meri-remaining-source-families.spec.ts:39` constructs **MeriToolsService**, a different constructor; do not shift its array. Prototype fixtures do not shift: lifecycle, feedback, compaction, debrief authority, report reads, workspace, artifact image/version and external RP artifact retrieval/edit tests call retained methods on fake receivers. The RP artifact specs outside this directory use prototypes rather than positional construction.

Once those five inert argument changes are allocated and preserved, the raw V2 constructor parameter and module import/provider can retire. Keep `RAW_MERI_SERVICE` useClass, `MERI_TURN_MAINTENANCE useExisting: RAW_MERI_SERVICE` and current ordinary proxy registration at139–155. No other provider is proven dead by V2 removal.

`meriv2-chat.client.ts` blob `326a4dccf53d71e68260d6d5bbb4c065e274235f` is 8,255 bytes. After raw bridge/provider removal, its remaining Core runtime dependency is **type-only**: `meriv3-chat.client.ts:12/273` imports/uses `ResolvedAiForChatHeader` (V3 client blob `85df4ed79b4c05cb35eb5dca3f8c7f15d86c4bca`). Rehome that shared type before any whole-client-file retirement; otherwise retain the file. The V2 client has four native transport cases at31/80/99/115. Its independent test/provenance treatment, the routing helper tests/matrix, and orchestrator/in-editor V2 roots require explicit separate accounting; this map does not allocate their deletion.

## Residual imports and fields after exactly those two regions

A finite lexical pass constructed the residual source in memory by omitting only963–2727 and2729–3250, excluded import declarations, and checked named bindings. This is not AST parsing, compile qualification or global reachability proof. These original import bindings have **no remaining lexical use** in the residual declarations:

```
bindResearchPortfolioToolConversation
assertAttachmentConversation authorizedAttachmentSources compactedAttachmentContext
recordAiUsageEvent
runAuditor ledgerToToolResultMap LedgerEntry AuditorMode
prospectTurnScopeReceipt authorizeMeriProspectScope researchPortfolioTurnScopeReceipt
addUsage applyRoundUsageEvent applyToolCacheControl emptyUsage
runToolsConcurrently
extractCitationsFromToolResult formatCitationsForPrompt validateCitationMarkers MeriCitation
CLIO_SKILLS matchFirmSkillForTurn parseBridgedToolName
summarizeTurnTrace traceLogLine MeriRoundTrace buildPlanSteps
CircuitOpenError loopBudgetExceeded LoopStopReason
screenComplianceRisk screenComplianceBlock complianceRefusalBody
confidenceLevel classifyToolAction isSideEffectingTool detectDeliverableReportRequest
meriProviderConfigurationError buildMeriGroundingStatement MERIV2_FLAGS MeriV2ChatStreamEvent
applyThinkingStreamEvent createThinkingState thinkingReplayBlocks thinkingRequestParams ThinkingSettings
allocateBoundedReplayHistory MAX_REPLAY_HISTORY_CHARS MAX_REPLAY_MESSAGES planTurnRerun
```

The `shouldRouteMeriV2FullChat` import at241 likewise loses its only call. Remove only individual unused bindings from mixed imports; do not delete their helper files or shared exports. In particular, preserve shared authority, RP, memory, Florida, and canonical tool owners. The raw-only RP-binding import is an application cleanup candidate only when the protected contract prerequisite below is resolved; helper/test retirement remains unallocated.

Residual `this.` reference counts are zero for `toolBreaker`, `meriV2Chat`, `mcp`, `firmSkills`, and `claimWriter`. `toolBreaker` is initialized at343–345; its initializer retains `ToolCircuitBreaker` until that exact field is explicitly retired. The other four fields remain constructor declarations until separately allocated; do not use this lexical count to remove their modules or shift more fixture parameters casually. `MeriMcpService`, firm skills and claim writer have independent application consumers/module responsibilities.

Residual fields definitely still referenced include clientKb1, contextCompiler1, contextPlane2, aiCredentials7, memoryIngest2, memoryCandidates2 and meriFlags1. Their continued references can be in retained helpers as well as public methods; a count alone does not prove production reachability. Keep those source owners and their existing authority.

Residual private helpers form a later call-graph slice: `completeWithIntentModel:3524`, `orchestrateContext:3693`, `classifyIntent:4138`, `verifyDeliverable:4183`, `enrichDeliverableStructural:4240`, prompt composition4297/4401, stream control4425, intent policy4439, skills/suggestions4466–4524 and autolearn4551–4606/5177. Some become uncalled roots after loop/raw-adapter removal; others call one another. Do not automatically delete this whole subtree. In particular `loadUserVoiceContext:4619` is source-pinned by `memory-private-fail-closed.spec.ts:89`; recall/memory policy and native consumer closure remain protected.

## Preserved canonical raw domains and maintenance

Keep status385–403 and the complete history/message/authorization prefix405–962, including current prospect/RP artifact/read boundaries; artifact image3252onward; maintenance3305–3521; search3570onward; artifacts5392onward; feedback5575onward; uploads5809onward; public alerts/memory methods5326/5373/6031onward. Regional removal must not reinterpret these shared bodies as dead loop code. The earlier map's405–964 shorthand included the removable stream heading963–964; this map explicitly excludes that heading from the retained prefix.

Current V3 and research use `MERI_TURN_MAINTENANCE`; retain scheduling, indexing and protocol-safe compaction, especially the tenant/actor/client/boundary/revision fence3493–3515. Preserve `meri-turn-maintenance.spec.ts` registration/cases and `meri-protocol-compaction.service.spec.ts` direct helper cases. Preserve RP artifact tests outside Meri, current retained-read/auth/RP/memory authority, Florida/Intel source, and the canonical federal tools already extracted by PR34.

## Concrete test-contract prerequisites and holds

1. **Protected RP raw-fragment contract, newly explicit.** `ResearchPortfolioMeriTurnBinding.spec.ts` blob `7abf804a8d4b4b8fbd98abdefcadbc10eab627fe` reads the actual raw service at28–80, AST-extracts `orderedTools.entries()` normalization and the `runToolsConcurrently` native callback, then executes those fragments. Raw method removal makes `fragments()` throw. It owns **22 expanded cases**:19 RP-name retargeting cases plus omitted/exact current conversation, ordinary-native behavior, and malformed scope attempts. Parent has sent Core coordination. **Do not edit, archive, weaken or delete this helper/test dependency until that ownership decision arrives.** No generic lifecycle mapping is a substitute for current-turn retargeting refusal assertions.
2. **Raw direct lifecycle.** `meri-turn-lifecycle.phase4.spec.ts` blob `88a482005990d910c9dbaa7bbff3836f51b6dad6`, harness33–50 and cases102–164, directly invokes raw stream and its native provider-SSE parser:8 expanded lifecycle cases. Preserve their semantic identities via an explicit reviewed current-runtime landing or pinned historical replay. Do not count a raw refusal as the old parser's pass. Keep the separate3 archived-history/restore cases63–100 active.
3. **Current runtime mock construction.** `meriv3-runtime.proxy.spec.ts` blob `1f5cd3b0a01c79fa1ed8b0ea34002ff0394b873c`: raw adapter scaffolding23–28 can retire with the raw installer, while actual V3/refusal/progress/delegation assertions58–123 stay. A poison/mock raw stream property can still serve a meaningful no-fallback negative control; it must not become a production raw method. `meriv3-runtime.coverage.spec.ts` blob `dbb4e689dac687d4365bff1b33a8d06d181d388f` uses raw42–45 only for construction and executes the patched V3 client; preserve every reconciliation assertion.
4. **Phase19 source contract.** `phase-19-meri-context-plane.contract.spec.ts` blob `933e4424d586d85dba888c7a35c6d75d5f0b0779`:24–31 pins obsolete raw `loadRelevantMemories` adapter text. Deliberately update only that ownership assertion to current V3 governed prewarm suppression while preserving its no-bypass goal and other cases. Raw text must not survive merely to keep this grep green.
5. **Constructor fixture migration.** The five argument changes above must preserve existing feedback, legal-hold, prospect creation and attachment semantics and exact case identities; they are not permission to alter protected authority implementations.

## Scope / remaining decisions

This map is design preparation, not an edit claim. The coherent application slice requires the exact two raw regions, their unused imports/explicitly allocated fields, current runtime signature/type injection seam, raw construction-adapter decoupling, and deliberate native/source-contract migration. Optional V2 slot/provider retirement is closed only with the five fixture changes; whole V2 file retirement additionally needs the shared-type and historical-test decisions.

The protected22-case RP source-fragment contract is the concrete outstanding ownership prerequisite. The map also cannot establish arbitrary reflective/external/dynamically constructed callers or live routing. No deployment, merge, current flag/security change, data operation or broader service retirement is authorized. All execution/typing/native/build qualification remains for the parent's coordinated queue after source allocation.
