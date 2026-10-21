# Raw Meri loop retirement: pre-edit boundary

Source pin: `f3ede4fe8d88ba686a81c59f71e44319c0f45fd1` (accepted draft PR34), tree `1bc72c2b95867d997d4d5063096822fd41892205`. This successor uses its own branch, `cleanup/backend-meri-loop-retirement-20261016`. Frozen `cd3c51e940f14e1b2a1040b0ffa445e85d68b332`, Engagement `016e79b585c14f20d13669e13c987c01e3dd29dd`, Objective `622905839c7a510ab01a512ef8012926b2e1b4ce`, previous cleanup refs and live capirov2 are preserved.

## Exact roots and consumers

| Source | Current reference / disposition |
| --- | --- |
| `apps/api/src/meri/meri.service.ts`, blob `8878d515849c36ce037a9fc8591e46bbb06e65b2` | Raw `streamMessage` lines965–2727 and sole `streamMessageViaMeriV2` lines2742–3250; remove both, including their attached comments. Preserve all other method bodies, particularly archive/history/attachments/memory and maintenance used by V3/research. Remove V2 constructor slot10 only after positional fixture closure. |
| `meriv3-runtime.proxy.ts`, blob `28f02937c824fdbf1f6655f87bd94a52969aa360` | Current stream entry gate already selects V3 or unavailable, never raw. Remove `RawMeriInternals`, raw installer call/body; keep V3 installer, governed KB/client adapters, progress and reconciliation. Replace stream typing from the retired raw method with a current V3-derived contract. |
| `meri.module.ts`, blob `a17e94efba349979236ed1dbada4be4c17cf8f02` | Ordinary `MeriService` token is the current proxy factory. `RAW_MERI_SERVICE` remains internal for nonstream methods and maintenance. Remove unused V2 client provider/import only; preserve factory, maintenance alias, guards and all canonical tools. |
| `meri.controller.ts` | Current stream invokes injected service. Preserve runtime `MeriService` token explicitly with `@Inject(MeriService)` when parameter becomes composed current-runtime type; no route/auth changes. |
| `meriv2-chat.client.ts` | Sole production consumers are raw service/module plus V3's type-only `ResolvedAiForChatHeader` import. Move the exact five-field header to a neutral current type owner, update V3 import, then retire unused client/provider. No credential-policy change. |
| `meriv2-routing.helpers.ts` | Sole production call is inside retired raw method. Its helper/matrix tests are historical after retirement. Orchestrator app, meriv2-core and public orchestrator V2 route remain retained consumers; their names are not retirement proof. |
| `meri-turn-lifecycle.phase4.spec.ts` | Eleven expanded cases: eight raw provider-loop lifecycle cases become pinned historical replay obligations; three archive recovery/owner cases remain current, with exact bodies retained. |
| `meriv3-runtime.proxy.spec.ts`, `meriv3-runtime.coverage.spec.ts` | Five and six current cases retained. Remove obsolete raw-prewarm fixture fields, keep actual V3 routing/refusal/progress/reconciliation controls. |
| `phase-19-meri-context-plane.contract.spec.ts` | Eight current cases retained; replace only obsolete raw prewarm assertion with current V3 governed adapter ownership. |
| `ResearchPortfolioMeriTurnBinding.spec.ts`, blob `7abf804a…` | Twenty-two expanded identities extract actual raw normalization/dispatch. They must land on actual current tool execution before the raw loop is removed; not permission to drop RP protection. Preserve original source/case provenance in replay manifest. |
| `meri-research-portfolio-tool-scope.ts` | Only production caller is retired raw loop. Current canonical analogue is orchestrator `current-turn-tool-scope.ts` through `ApiToolExecutorRepo.execute`, not this raw-only helper. |

Paths without an app prefix in this table are under `apps/api/src/meri/`.

## Current replacement and RP safety landing

Current controller → ordinary `MeriService` provider → `createMeriRuntimeService` → two-key V3 gate → governed `runChatTurn` → `MeriV3ProxyService.streamMessage`; closed gate → `streamUnavailable`. The raw class retains required nonstream behavior and maintenance, with no stream facade or fallback.

Current V3 delegates tools through unchanged orchestrator `ApiToolExecutorRepo.execute`: verified request credential, trusted current-turn scope, `bindCurrentConversationToolInput` before network, service identity for RP, typed RP transport. Core `admitMeriResearchPortfolioToolTransport` and `executeMeriResearchPortfolioToolAtCurrentUse` retain actor, tenant, current conversation, client and grant checks. The twenty-two raw safety identities will be ported to this actual current dispatch seam, including all nineteen canonical RP names; current existing three orchestrator RP cases alone are not nineteen-name parity. No greenfield conversation UUID is treated as a Core conversation ID.

Core owner confirmed no edits/collision on the raw methods, proxy, controller, client or stream types. Core has no current V3 retargeting-test claim and requested this deliberate seam proof. READS confirmed no collision and requires old case provenance plus all current guards preserved. Their new retained-principal/greenfield transport is a separate authority boundary, not a replacement inferred by this cleanup.

## Validation boundary

Use finite Git/source comparisons and bounded built-in Node controls only. Native/framework/type/build/image/DB and integrated qualification remain open, require the shared queue, and will not be represented as passing. Historical replay accepts only the exact pinned source and explicit historical scope, never current backend acceptance. Preserve old failures and receipts. No cloud, migration, deployment or merge operation is allocated.
