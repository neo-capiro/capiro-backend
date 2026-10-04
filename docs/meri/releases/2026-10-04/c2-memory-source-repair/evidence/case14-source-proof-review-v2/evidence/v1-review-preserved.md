# Case 01/14 canonical memory proof — narrow source review

**Result: FAIL** — one actionable acceptance/trust failure: the proof is bound to a capture policy, but not to an individual tool call/request, so a valid response can be replayed within the same policy and attributed to a different call.

## Frozen snapshot reviewed

Reviewed only files listed in `evidence/manifest.json` and present in the evidence bundle:

- `evidence/manifest.json`
- `evidence/changes.diff`
- `evidence/packages/meriv2-core/src/context/memory-capture-source.ts`
- `evidence/packages/meriv2-core/src/context/memory-capture-source.spec.ts`
- `evidence/apps/api/src/meri/meri-memory-content.helpers.ts`
- `evidence/apps/api/src/meri/meri-tools.service.ts.excerpt.txt`
- `evidence/apps/api/src/retrieval/adapters/institutional-knowledge-retrieval.adapter.ts.excerpt.txt`
- `evidence/apps/meriv2-orchestrator/src/meri/api-tool-executor.repo.ts.boundary.txt`
- `evidence/apps/meriv2-orchestrator/src/meri/api-tool-executor.repo.ts.excerpt.txt`
- `evidence/apps/meriv2-orchestrator/src/request/trusted-current-turn-scope.ts.excerpt.txt`
- `evidence/apps/meriv2-orchestrator/src/meri/controlled-read-observations.ts`
- `evidence/apps/meriv2-orchestrator/src/meri/meriv3/meriv3-capture-evidence.ts`
- `evidence/packages/meriv2-core/src/context/capture-evidence-receipt.ts.excerpt.txt`

## Actionable finding — exploitable acceptance/trust failure

**Same-policy replay is not prevented.** `evidence/packages/meriv2-core/src/context/memory-capture-source.ts:39-44, 69-93` binds the HMAC to policy/turn/capture scope and exact returned records, but has no per-invocation nonce, call ID, or request-argument binding. `evidence/apps/meriv2-orchestrator/src/meri/controlled-read-observations.ts:126-135` verifies that proof against the received records, then attaches the *current* invocation's `row.callId`; `:178-184` later selects observations by that attached call ID. `evidence/apps/meriv2-orchestrator/src/meri/meriv3/meriv3-capture-evidence.ts:110-124` joins a citation to that call ID and the signed source fields. The receipt checks unique call IDs and successful HTTP outcomes, but cannot establish that the signed response was minted for that particular call (`evidence/packages/meriv2-core/src/context/capture-evidence-receipt.ts.excerpt.txt:267-288`).

**Reproduction reasoning:** during one still-valid Case 01/14 policy, capture a successful `search_memory` response and its signed `memoryCaptureSources` from call A. Replay that exact response body as call B's HTTP response, and have B cite the same returned record/version/client/snippet. The policy binding and HMAC still verify; the observer records the proof under B's call ID; B's citation matches; and the final receipt sees distinct, returned call identities. Thus call-ID uniqueness does not stop cross-call replay inside a policy. This violates the requested same-policy replay resistance. Bind a unique API-issued invocation/request nonce (and relevant request identity) into the signed proof and verify it against the active orchestrator invocation; do not merely relabel a valid proof with the current call ID.

Cross-policy replay is addressed: the binding includes policy ID, case, capture run, request/trace/turn, tenant, actor, client, conversation, times, physical-map hash, and semantic clock (`memory-capture-source.ts:39-44`), and exact record correspondence is verified (`:86-93`).

## Checks that pass in the supplied source

- **Canonical row scope:** the retrieval excerpt filters DB rows by caller tenant and authorization/client walls and selects the actual row tenant/client (`institutional-knowledge-retrieval.adapter.ts.excerpt.txt:142-209, 228-240`). The mapper carries the row tenant into provenance (`:655-728`); projection only exposes it in capture mode (`meri-memory-content.helpers.ts:88-105`). The signer requires row provenance and rejects tenant/client disagreement with policy rather than filling it from caller input (`memory-capture-source.ts:46-75`).
- **Exact projected content/version:** a full page's content hash is checked against the projected value plus source version; proof records a UTF-8 SHA-256 of the exact projected passage and offsets (`memory-capture-source.ts:48-66`). Verification recomputes source entries from the actual response records and compares them to the proof (`:84-93`). Citation equality checks source ID, memory kind/record ID, version, client, and exact snippet hash (`meriv3-capture-evidence.ts:110-124`).
- **Paging is not mislabeled as a full read:** projection cursors are rebound to user/tenant/client and current content (`meri-memory-content.helpers.ts:37-63`); source proof marks full read only for offset zero through total length and validates truncation/cursor consistency (`memory-capture-source.ts:55-66`). Partial pages cannot claim a full-byte hash (`meriv3-capture-evidence.ts:117-125`).
- **Policy gating and ordinary caller arguments:** the proof helper is enabled only for the named fixture version and cases 01/14 (`memory-capture-source.ts:34-36`); current-turn policy validation binds tenant/actor/conversation/client and disallows mismatches (`trusted-current-turn-scope.ts.excerpt.txt:57-97`). The supplied transport uses forwarded credentials and current trusted scope, rather than treating caller JSON as proof (`api-tool-executor.repo.ts.excerpt.txt:91-95, 112-155`). The proof is produced server-side from projected DB records (`meri-tools.service.ts.excerpt.txt:3505-3516, 3539-3545`).
- **Failed/non-200 and duplicate-call controls:** supplied final semantic-clock validation rejects duplicate logical call IDs, repeated invocation IDs, non-200 or multiple HTTP attempts, and non-returned outcomes except the explicitly qualified unavailable case (`capture-evidence-receipt.ts.excerpt.txt:267-288`). The HTTP observer also rejects duplicate source responses for one call ID (`controlled-read-observations.ts:132-135`).

## Missing tests (not additional demonstrated failures)

The included core spec tests signature/record/text/version/tenant/client/policy/trace/turn drift, duplicate/missing records, and partial-page classification (`memory-capture-source.spec.ts:19-53`), but has no same-policy replay test, no API-to-orchestrator call-binding test, and no end-to-end citation/receipt replay test. Add tests that replay a valid response across two distinct call IDs under one policy and prove rejection, plus continuation-page and exact-citation joins at the HTTP boundary.

## Limitations

Source-only review of the frozen bundle; no live capture, execution, deployment, external-file access, or code changes. Manifest hashes identify full upstream sources, while some supplied files are excerpts, so conclusions are limited to included lines and their stated ranges. This review does not validate runtime secret configuration or prove the actual API/database deployment. The known separate root stripping of internal proof/tenant metadata from model projection is intentionally not reported as a new finding.

## Optional hardening

After adding call binding, consider requiring and validating a bounded nonce format/expiry at both ends and explicitly checking the source observation's stored response hash against the completed invocation hash. These are defense-in-depth; the missing call-specific binding above is the acceptance blocker.

No model/provider overrides, cost changes, or provider actions were made.