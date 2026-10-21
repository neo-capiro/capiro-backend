# Meri raw-loop retirement: test ownership map

Read-only preparation at sealed PR34 `f3ede4fe8d88ba686a81c59f71e44319c0f45fd1`, tree `1bc72c2b95867d997d4d5063096822fd41892205`. No application/test edits, checkout, install, Node, framework, parser, compiler, service or historical replay was performed. Original source remains recoverable from this complete immutable Git tree; the proposal does not copy an obsolete runtime implementation into a new active fixture.

## Exact counts and owners

| Existing file under `apps/api/src/meri` | Test declarations | Expanded cases | Proposed owner |
| --- | ---: | ---: | --- |
| `meri-turn-lifecycle.phase4.spec.ts` | 6 | **11 = 8 raw + 3 archive** | Split the two describes by actual implementation ownership |
| `meriv3-runtime.proxy.spec.ts` | 5 | **5** | Current V3 routing/refusal/nonstream delegation; retain every case |
| `meriv3-runtime.coverage.spec.ts` | 3 | **6 = 1+4+1** | Current governed V3 coverage; retain every case |
| `phase-19-meri-context-plane.contract.spec.ts` | 8 | **8** | Current Context Plane contracts; deliberately update one raw-adapter assertion |
| `meriv2-chat.client.spec.ts` | 4 | **4** | Historical API V2 bridge transport if that client is separately retired |
| `meriv2-routing.helpers.spec.ts` | 2 | **5 = 1+4** | Historical raw-loop routing decision if helper is retired |
| `meriv2-routing.matrix.spec.ts` | 9 | **32** | Historical raw-loop decision truth table if helper is retired |
| `ResearchPortfolioMeriTurnBinding.spec.ts` | 4 | **22 = 19+1+1+1** | Raw-fragment evidence plus **current RP protection that must migrate**, not security retirement |

Counts distinguish generated Jest cases from assertions and internal loops. Optional V2 retirement affects **41 cases**, not 41 declarations. Raw lifecycle plus optional V2 has **49 historical identities**. Original RP fragment evidence adds 22 more historical identities if migrated, but its security obligations require a deliberate current 22-case landing rather than removal or refusal-as-pass.

## Eight genuine raw lifecycle identities

All eight belong to describe **`native Meri lifecycle persistence matches the final stream receipt`**. The fixture at lines 12–51 creates `Object.create(MeriService.prototype)` and `run` calls the **actual raw** `streamMessage` at line 50. Global fetch supplies Anthropic provider SSE, so these are not current V3 routing tests.

| Original line | Exact expanded case title | Existing current V3 semantic landing / qualification gap |
| --- | --- | --- |
| 105 | `records an in-band provider error as failed even after text and before a later completion frame` | `meriv3-proxy.service.spec.ts:742` **`emits a provider failure as accepted work followed by canonical completion metadata`** checks error/done ordering and saved tool details. It does not feed private provider details after partial text followed by later completion/text, so the old raw-parser suppression/redaction assertion is **not equivalent current coverage**. Keep original historical identity; add a current event-order/redaction case only against an agreed current transport contract. |
| 127 | `retains a Stop racing the final provider round instead of persisting success` | Current `:1063` **`marks cancellation after a completed provider round as a partial aborted turn`** checks saved aborted/partial metadata. Current `:1095` has two empty-Stop cases after 0/1 tools. The old nonempty race's final SSE + persisted receipt agreement is not fully asserted by `:1063`; record that gap rather than claiming one-to-one parity. |
| 140/143 | `records provider finish end_turn faithfully` | Current `:1201` **`main completion path: done frame includes the real persisted assistant message id`** proves real message identity and maintenance order, not the exact raw `end_turn → stop, partial:false` parser mapping. Raw mapping becomes historical. |
| 140/143 | `records provider finish max_tokens faithfully` | Current `:985` **`preserves provider incomplete status in the saved message and completion event`** checks saved/SSE `max_output_tokens, partial:true`. This preserves incomplete-result intent with a different current vocabulary, not old raw-provider parser equivalence. |
| 140/143 | `records provider finish null faithfully` | Current `:1016` **`records a stream ending without a done frame as partial, with unknown effective effort`** checks saved and SSE `stream_interrupted, partial:true`. The current upstream event stream is different from the old Anthropic SSE parser. |
| 151 | `keeps provider_failure distinct on stream and reload` | Current `:742` covers an in-band error event; transport failure classification at `:2125` is pure classification. Neither is the exact raw fetch-thrown failure/persisted+done test. Historical identity remains; do not manufacture equivalence. |
| 151 | `keeps user_stop distinct on stream and reload` | Current `:1063` and expanded `:1095 [0,1]` cover aborted persistence and honest empty Stop receipts. Preserve their own names/semantics; they are current landings, not execution of this historical case. |
| 151 | `keeps provider_timeout distinct on stream and reload` | Old fixture throws `AbortError` while the caller is not aborted, expecting error/partial. Current `:1036` **`preserves an internal deadline finish reason instead of relabeling it as user Stop`** and `:1141` **`persists a deadline receipt without inventing a provider failure or user Stop`** deliberately classify deadline differently. Do not relabel those passes as the old provider-timeout result. |

These eight are four declarations expanded **1+1+3+3**, with no new raw refusal counting as their success. The existing `:1168` **`a summary provider failure stays off the completed V3 response`** and `:1201` maintenance-order assertions remain current independent protections, not reasons to retain the raw stream loop.

## Three independent archive/history cases stay current

Describe **`archived Meri thread deep-link recovery`**, lines 63–100, only uses actual current `getConversation`, `listMessages`, `restoreConversation` and an owned tenant/user fixture. Those source methods remain at `meri.service.ts:545,651,664`; the runtime proxy binds other methods to raw at `meriv3-runtime.proxy.ts:130–131`.

1. Line 82: **`discovers the owned archived row without restoring or reading its messages, then restores the saved conversation`**.
2. Line 93: **`rejects archive discovery and restore outside the owner ({"tenantId":"other-tenant"})`**.
3. Line 93: **`rejects archive discovery and restore outside the owner ({"userId":"other-user"})`**.

Preferred bounded file split: keep the original native path and this describe/three expanded identities, shared `ctx`, `MeriService` import, and only required import-isolation mocks. Remove its now historical raw harness (12–51), provider helper (55–61) and raw describe (102–164) from current test discovery. Record the original whole test blob/case IDs in an inert historical catalog; replay them from the existing pinned full source, not a copied active implementation. This avoids unrelated filename/selectors changes. No current archive case is skipped, renamed or replaced by a raw-stub refusal.

## Phase 19 assertion and raw fixture prerequisites

`phase-19-meri-context-plane.contract.spec.ts:24–31`, **`legacy chat prewarms are suppressed on governed turns`**, currently requires raw-only `loadRelevantMemories` and `currentMeriGovernedRuntime() ? []` text. It will fail for a legitimate removal of the raw installer. Replace this specific raw ownership expectation deliberately with a current V3 adapter ownership case; preserve the seven other Phase19 cases unchanged. Record the original case ID and the new title/owner explicitly.

Retain these actual current guarantees: `installV3Phase19Adapters:188–194` wraps V3's `clientKb` and `client`; `governedClientKbProxy:196–207` suppresses snapshot prewarm only with active governed context; `governedStreamClientProxy:209–231` injects `governedContext` and normalizes signed completion coverage. Suggested current behavioral additions (not executed here): governed V3 KB snapshot suppression without touching its original port, and ordinary V3 KB snapshot delegation outside a governed turn. They are current obligations, not replay of the raw suppression assertion.

`meriv3-runtime.proxy.spec.ts` lines 23–28 carry six obsolete **raw** fixture fields: `orchestrateContext`, `loadRelevantMemories`, `policyForIntent`, `templateForIntent`, `meriV2Chat`, `clientKb`. `meriv3-runtime.coverage.spec.ts:42–47` carries four: `orchestrateContext`, `loadRelevantMemories`, `meriV2Chat`, `clientKb`. They satisfy `installRawPhase19Adapters` construction-time `.bind`/proxy operations, not actual raw execution. Remove these prerequisites with the installer; retain all five proxy cases and all six coverage cases.

Keep V3 `client`/`clientKb` fixture fields: coverage `receive` really invokes the patched **V3** client at lines 54–65. Preserve reconciliation identity, initial failure retention, malformed/missing coverage cases `[undefined,null,{coverage:{complete:true}},{coverage:{phase:'turn',complete:true,toolReads:'malformed'}}]`, and tool/progress identity. A raw `streamMessage` trap may remain solely as a **test probe** proving fallback is never touched; production must not retain a dead facade to satisfy that probe, and test typing can retain the separate spy rather than requiring that member on the raw production class.

## Optional V2 client and helper retirement

Finite tracked exact-name pass: `meri-loop-v2-consumers-f3ede4.{stdout,stderr,receipt.json}`, Git exit 0, stdout SHA256 `4067aee3f9f6a2b1ffbf48874a1c9659fd614d2dc1d31403050b1f968566ae21`.

Production V2 client consumers are the raw `meri.service.ts` import/constructor/bridge and `meri.module.ts:73,199` provider; **current `meriv3-chat.client.ts:12,273` still imports/uses `ResolvedAiForChatHeader` as a type**. Rehome that exact shared credential shape before deleting the old client file. Do not retire the orchestrator app merely because the API V2 client is no longer needed. The routing helper's only production invocation is raw `meri.service.ts:1518`; the controller's reference at 415 is a historical comment, not invocation. The matrix description that V3 declines into raw is stale against current runtime proxy 111–120.

Client four historical titles (`MeriV2ChatClient.streamChat`):

- 31: `POSTs to /meri-api/chat/stream with bearer + BYOK header and parses frames across chunk boundaries`.
- 80: `omits the BYOK header when no credential resolved (global-key fallback downstream)`.
- 99: `throws on a non-2xx response (no silent fallback — rollback is the flag)`.
- 115: `requires the caller bearer and a configured orchestrator URL`.

Current `meriv3-chat.client.spec.ts:28` tests the V3 route/reasoning/coverage and bearer/tracing, `:131` missing bearer, `:144` refusal of Anthropic credentials, and `:165` actual exported span identity. These are current independent tests, not four equivalent old transport cases. The V2 chunk-split/garbage-frame and no-BYOK/HTTP503 assertions are not all present in those V3 cases; leave that qualification distinction explicit.

Routing helper five identities: `routes a normal enabled turn`; template **`keeps the turn on the contained path for $label`** expanded for `missing bearer`, `unconfigured orchestrator`, `disabled tenant flag`, `impersonation`.

Routing matrix **32 cases** (preserve templates plus literal parameter vectors in the historical ledger):

- `CORE_TABLE` lines 79–94: 16 rows in literal order, boolean key `bearer,configured,enabled,impersonated`: `TTTF, TTTT, TTFF, TTFT, TFTF, TFTT, TFFF, TFFT, FTTF, FTTT, FTFF, FTFT, FFTF, FFTT, FFFF, FFFT`. Only `TTTF` expects `meriv2-orchestrator`; every other row expects `contained-legacy`. Template at 106 retains those four boolean labels and expected route.
- Two table invariants at 112/120: unique exhaustive 16 combinations and exactly one ready/nonimpersonated V2 cell.
- Missing-bearer template at 145: three labels `undefined (header missing)`, `null`, `empty string`.
- Not-impersonated template at 160: four labels `undefined (header missing)`, `null`, `empty string`, `whitespace only`.
- Contained impersonation template at 172: four labels `tenant uuid`, `padded tenant uuid`, `non-uuid string`, `single character`.
- One case at 178 iterates 8 combinations internally; this is **one case, not eight**.
- Two edge cases at 200/204: whitespace-only bearer remains truthy at the helper boundary; return is a strict boolean.

## Additional RP raw-fragment dependency: 22 identities, current security hold

`ResearchPortfolioMeriTurnBinding.spec.ts` imports TypeScript and extracts the **actual raw** `orderedTools.entries()` normalization and `runToolsConcurrently` callback from `meri.service.ts` (30–85), then transpiles/invokes those fragments. Removing the raw loop makes it fail **`Actual Meri normalization/dispatch fragment unavailable`**. This is genuine implementation coupling; retaining dead loop text or treating a new refusal as its pass is unacceptable.

Its describe is **`Current-turn Research Portfolio tool binding`**. The parameterized identity at 113, **`actual normalization refuses model retargeting for %s before actual native dispatch`**, expands over these **19** exact names:

`get_research_portfolio`, `get_research_portfolio_analytics`, `get_research_portfolio_changes`, `create_research_portfolio_snapshot`, `request_research_portfolio_output`, `save_research_portfolio_output_to_client`, `watch_research_portfolio`, `update_research_portfolio_change_state`, `get_research_portfolio_bookmarks`, `create_research_portfolio_bookmark`, `get_research_portfolio_fit`, `get_research_portfolio_reviews`, `add_research_portfolio_review_note`, `get_research_portfolio_rules`, `get_research_portfolio_imports`, `get_research_portfolio_operations`, `prepare_research_portfolio_brief`, `prepare_research_portfolio_meeting`, `manage_research_portfolio`.

The other **three** exact titles:

- 123: `injects omitted current conversation and retains exact current conversation` — `{}`/equal inner loop is one case.
- 131: `ordinary native tools preserve their existing supplied conversation treatment`.
- 139: `rejects null/empty/non-string scope attempts without rewriting them as a successful current request` — `[null,'',23]` inner loop is one case.

The raw helper `meri-research-portfolio-tool-scope.ts` binds RP tools to current conversation and leaves ordinary input unchanged; its actual production call is raw line 2086. **The security requirement remains current** even when that specific helper/loop retires.

Current canonical analogue is orchestrator `current-turn-tool-scope.ts:37–53`; `api-tool-executor.repo.ts:124–125` calls it **before request construction/network**, then `180–182` uses `buildResearchPortfolioToolTransport` for RP. Its declared list contains the same 19 names (with manage first), and the API typed RP transport still performs its independent current-use/actor/client authority checks. Existing repo native titles at 213,236,272 cover finite envelope/omitted conversation, missing scope/cross-target/invalid context/missing secret before network, and ordinary compatibility. The latter group exercises `get_research_portfolio`, not all 19 tool-name identities.

**Concrete hold:** root/Core must review and preserve a deliberate 22-case current landing at the actual orchestrator binder/executor + API transport seams before removing this active raw-fragment test from discovery. Map old IDs to the new current seam (with explicit title changes if needed); preserve original raw-fragment identities in the pinned historical ledger too. Extend the actual pre-network executor coverage across all 19 names and retain omitted/equal, ordinary and invalid-scope assertions. Do not simply archive current RP protection. A reported `current-turn-tool-scope.spec.ts` is **not tracked anywhere under the sealed orchestrator tree** in a finite filename read; it cannot be cited as existing acceptance without a separate supplied source. No current authority source is allocated for change by this map.

## Strict nonexecuting historical replay proposal

Proposed support paths, subject to root allocation: `tests/support/legacy-meri/CASE-OWNERSHIP.json` (source/tree/blobs, exact expanded IDs, current/historical owners and coverage gaps); `tests/support/legacy-meri/replay-plan.mjs` (plan/data preflight only, never a test runner); and a historical receipt schema/example with **UNRUN** status. None is implemented here.

The planner should require explicit `--plan --source-root <existing-pinned-full-source> --suite <raw-lifecycle|v2-client|v2-routing|raw-rp|all>`; no default input/current-checkout fallback. Missing/mismatched source operands fail nonzero. Validate necessary pinned file bytes from the supplied existing root against recorded source hashes, declare the immutable full-tree pin, and emit manual Git HEAD/clean-source verification requirements for the queue owner. It must not checkout, extract Git objects to application paths, install, resolve packages, import legacy TS, spawn Jest/Node/Git/services, or offer an executable `--run`; reject unknown/run arguments. A data plan/preflight success is never a native pass.

Only the shared local queue/shipping owner may later execute the explicit printed native argv against that existing pinned full source with its original lock/config and already available dependencies. Example manual stage, **not executed**, from that source root's `apps/api`:

`node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.cjs --runInBand --runTestsByPath src/meri/meri-turn-lifecycle.phase4.spec.ts --testNamePattern '^native Meri lifecycle persistence matches the final stream receipt '`

Expected selected count is **8**, with three archive cases excluded by this historical selector and separately qualified against current source. Optional V2 historical stages select the original client file (**4**) and both routing files (**37**); original RP historical fragment file selects **22**. No `--passWithNoTests`, test skips, automatic extraction/install or broad suite. Queue-approved resource/time limits and platform/native prerequisites remain explicit inputs; this document does not guess them or change environment/credentials.

Manual receipt must record source HEAD/tree + clean/input identities, node/native/platform identity, exact cwd/argv, queue reservation/owner, start/end/PID/peak resource use, exit/timeout/stop status, selected expanded case IDs/counts, stdout/stderr hashes, and each scope as PASS/FAIL/UNRUN independently. Refusal/missing inputs/collection errors/zero selection cannot be reported as successful historical replay. Current V3 tests and historical tests get separate receipts; no historical result qualifies current router, auth, SQL, startup, deployment or live runtime.

## Pinned source objects

All mode 100644 at f3ede4; root must preserve these source references, not remove Git history or evidence.

| Path | Blob |
| --- | --- |
| `apps/api/src/meri/meri.service.ts` | `8878d515849c36ce037a9fc8591e46bbb06e65b2` |
| `apps/api/src/meri/meri-turn-lifecycle.phase4.spec.ts` | `88a482005990d910c9dbaa7bbff3836f51b6dad6` |
| `apps/api/src/meri/meriv3-runtime.proxy.ts` | `28f02937c824fdbf1f6655f87bd94a52969aa360` |
| `apps/api/src/meri/meriv3-runtime.proxy.spec.ts` | `1f5cd3b0a01c79fa1ed8b0ea34002ff0394b873c` |
| `apps/api/src/meri/meriv3-runtime.coverage.spec.ts` | `dbb4e689dac687d4365bff1b33a8d06d181d388f` |
| `apps/api/src/meri/phase-19-meri-context-plane.contract.spec.ts` | `933e4424d586d85dba888c7a35c6d75d5f0b0779` |
| `apps/api/src/meri/meriv3-proxy.service.spec.ts` | `761aa99b18749406bd72eb4655b7c1a2ed028148` |
| `apps/api/src/meri/meriv2-chat.client.ts` | `326a4dccf53d71e68260d6d5bbb4c065e274235f` |
| `apps/api/src/meri/meriv2-chat.client.spec.ts` | `2e781b64cdf9b593e12d1c4a42a1107682fa6598` |
| `apps/api/src/meri/meriv2-routing.helpers.ts` | `505dfa5bfc5cc4a8e9c852916e6f90edc51366aa` |
| `apps/api/src/meri/meriv2-routing.helpers.spec.ts` | `6456b9ba255094a1141641e5005661403d778a03` |
| `apps/api/src/meri/meriv2-routing.matrix.spec.ts` | `5e578a6b60add25d054610efb68b8f109476d202` |
| `apps/api/src/meri/ResearchPortfolioMeriTurnBinding.spec.ts` | `7abf804a8d4b4b8fbd98abdefcadbc10eab627fe` |
| `apps/api/src/meri/meri-research-portfolio-tool-scope.ts` | `a437f3539cf982b32dfe0b4798cd211ec93327f5` |
| `apps/meriv2-orchestrator/src/meri/current-turn-tool-scope.ts` | `9d7ad357b2bfd4391eb42da77a9fb68c4682c361` |
| `apps/meriv2-orchestrator/src/meri/api-tool-executor.repo.ts` | `74e97630367936881dd5d4ff5227579791ee1207` |
| `apps/meriv2-orchestrator/src/meri/api-tool-executor.repo.spec.ts` | `5a7e5e47f0873ba9cbd6bdc5eb5f4fa5b65cbac4` |
| `apps/api/src/meri/meriv3-chat.client.ts` | `85df4ed79b4c05cb35eb5dca3f8c7f15d86c4bca` |
| `apps/api/src/meri/meriv3-chat.client.spec.ts` | `013033ac00815507a8fda76f40fad6173a739eea` |
| `apps/api/jest.config.cjs` | `00998e78899becc7dc52818f3f81c2cb88f46f39` |
| `apps/api/package.json` | `7fa0f785eaa48abdf361eb7a82fcea934c6ae3fe` |
| `pnpm-lock.yaml` | `88d3bff652c22a7d9139a1a46bafd68411b3d4fe` |

No operation was denied or attempted with uncertain outcome. Application retirement remains pending explicit path allocation, preservation of the current RP seam, current native case updates and root-coordinated qualification.
