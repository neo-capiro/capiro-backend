# Raw Meri service removal implementation note

Implemented only the six allocated existing files against sealed PR34 `f3ede4fe8d88ba686a81c59f71e44319c0f45fd1`, after premap commit `bca4368306defae1495ab69f088171a3fccfaf56`. Source editing, finite source/diff reads, edit-safety operand checks and hash/line bookkeeping only. No Node, native test, parser, compiler, application, provider, Git commit or ref mutation executed.

## Exact source edits

- `apps/api/src/meri/meri.service.ts`: removed exactly original inclusive regions **963–2727** and **2729–3250**, including their owned heading/documentation. The separator at2728 and artifact documentation at3252 remain. No replacement raw stream method or stub was added. Removed the sole former constructor slot10 (`meriV2Chat`) and its exact three-line raw-only tool-breaker comment/initializer block343–345. All other constructor parameters and all other private/public method bodies remain unchanged.
- `apps/api/src/meri/meri.module.ts`: removed only the original V2 client import at73 and provider at199. Raw service registration, raw maintenance alias, current proxy factory and all other providers remain unchanged.
- Four positional fixture files: removed only the former slot10 inert `{} as never,` argument at five constructor sites, described below. All case identities, assertions, collaborator expressions and remaining argument order are retained.

The service changes from293,118 bytes /6,898 physical lines to187,035 bytes /4,554 physical lines. Final SHA256 is `127aa2b5eb65265e2190b4cdcc1ecd4c77ad12fabf4d94bd241876425ef41c92`. The module changes from12,288 bytes /269 lines to12,206 bytes /267 lines, SHA256 `eb5c8654a63a82f526c3b6b6c862de2a56572741bb407c54ea6f0ac4173e5e0b`.

The machine-readable companion `meri-loop-raw-service-implementation.json` records every file before/after hash/size/line count, both removed-region hashes, all exact import before/after operands, constructor/field removal and five constructor hashes/inverse instructions. Original loop bodies remain recoverable from the pinned Git blob `8878d515849c36ce037a9fc8591e46bbb06e65b2`; no whole-body evidence copy was saved. Git's diff may anchor the one retained blank separator differently between its displayed hunks; the edit and manifest use the exact sealed source ranges above.

## Exact removed import bindings

54 bindings were removed individually. Mixed imports retain their remaining operands and formatting; imports with no surviving binding were removed entirely. The raw V2 parameter's class import and the tool-breaker initializer's class import are included explicitly:

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
shouldRouteMeriV2FullChat ToolCircuitBreaker MeriV2ChatClient
```

## Fixture identity and inverse

| File under `apps/api/src/meri/` | Original constructor site(s) | Preserved collaborator bindings |
| --- | ---: | --- |
| `meri-feedback-learning-signal-resilience.spec.ts` |44| cleanupOutbox `undefined` old13→12; learningSignals old14→13 |
| `meri-memory-legal-hold.spec.ts` |54| actual memoryIngest remains7; legal-hold/audit logic and assertions unchanged |
| `meri.service.create-conversation.spec.ts` |62,207| actual bizdevScope/resolver old16→15; prospect authorization logic and assertions unchanged |
| `meri.service.upload-attachment.spec.ts` |49| actual aiCredentials remains6; extraction, source-byte and authority cases unchanged |

Each edit removes exactly argument index10 from a constructor whose one-argument-per-line operands were checked before writing. Reinsert the recorded exact indentation/dummy line at index10 to invert each constructor; its complete before/after constructor hashes are in the JSON manifest. No Reflect array was shifted: the mapped Reflect constructor belongs to MeriToolsService and is outside this write claim.

## Verification and boundaries

Scoped `git diff --check` is clean. Bounded source reads show no raw stream/bridge declaration, V2 field or tool-breaker/routing symbol remaining in the two application files. This is source correctness bookkeeping, not syntax/native/type/build qualification.

This task did not edit the RP binding helper or22-case source-fragment spec; raw lifecycle suite; current proxy/controller/runtime contract; V2 client/routing helper or their tests; V3 header types; docs/catalog; canonical MeriTools; Core producer/auth/RP/Florida owners. The source remains an integration candidate until the parent's current-runtime signature/adapter changes and protected RP test transplant close those known prerequisites. Other mapped raw constructor fields/private helper bodies intentionally remain for their separately reviewed slice. All tests, native parsing, typing/builds and integration acceptance remain with the coordinated parent queue.
