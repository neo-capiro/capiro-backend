# Candidate repair analysis — governed-memory source authority

Status: NOT IMPLEMENTED. No tests were run. The source changes required for a safe end-to-end repair were not small enough to complete and review within the requested five-minute window. This note is a narrow implementation proposal and records the exact trust and join boundaries; it is not a claim that Case14 is repaired. The existing live Case14 capture remains failed. Its old failed capture, completeness findings, and semantic-date findings stay open.

Scope is only `search_memory` results backed by the canonical `memory_items` retrieval path. Do not change Case20's controlled-read owner, broaden tenant inference to other tools, replay a turn, or claim/grading/cloud/provider actions.

## Observed path in this evidence copy

1. `apps/api/src/retrieval/adapters/institutional-knowledge-retrieval.adapter.ts`, `retrieveGovernedMemory`, selects canonical `mi.id`, `mi.tenant_id`, `mi.client_id`, `mi.owner_user_id`, `mi.source_version`, the governed status and the section-derived `value` from `memory_items`. Its eligibility query is tenant/user/wall scoped. `memoryRecord` currently emits the memory record ID and source provenance but omits the canonical row's tenant ID and owner/client scope from the returned `RetrievalRecord`.
2. `apps/api/src/meri/meri-memory-content.helpers.ts`, `projectMemoryContent`, projects a bounded slice of the canonical `payload.value` and carries only a whitelist of provenance fields. It has the canonical record ID, returned text, offsets, and the stored `sourceVersion`; it currently drops any row tenant ownership.
3. `apps/api/src/meri/meri-tools.service.ts`, `searchMemory`, calls `searchCapiroData` as `search_memory`, projects those records, then returns `records` plus `results` and coverage through the authenticated tool endpoint. This is the place to conditionally expose a production-owned capture proof only for admitted Case01/14 capture scope; do not use caller input or policy tenant as row provenance.
4. `apps/meriv2-orchestrator/src/meri/api-tool-executor.repo.ts` receives the actual HTTP response after forwarding the user's bearer and internal service identity. It already calls `observeControlledReadHttpResponse` at the response boundary, before returning the payload. The `withControlledReadInvocation` AsyncLocalStorage scope has the actual call ID and tool name. Existing controlled-read validation is specific to its controlled-read owner and must not be relaxed or reused as generic tenant inference.
5. `apps/meriv2-orchestrator/src/meri/meriv3/meriv3-assistant.service.ts` calls `observeMeriV3CaptureExecution` with the actual call ID, raw tool result, citations, and coverage. `meriv3-capture-evidence.ts` currently leaves tenant authority UNKNOWN for ordinary citations and has a separate Case20 branch. The core receipt blocker `source_tenant_authority_unproved:<id>` is correctly enforced in `packages/meriv2-core/src/context/capture-evidence-receipt.ts` and should remain strict.

## Narrow design

A. Carry minimal row-owned data through the canonical adapter and projection, only for this memory path: canonical row `tenant_id`, `client_id` (including null), canonical record ID, stored source version (including explicit absence), projected content offset/end/truncated flag, and a SHA-256 of the exact projected UTF-8 `payload.value`. The row tenant/client must be taken from the SQL row; never copy the request caller, capture policy, fixture marker, or client selection into these fields. Keep owner_user_id out of the receipt unless a separately reviewed requirement needs it.

B. Have the API produce an explicitly named, versioned capture authority object on each returned governed-memory record, only when the current trusted server-readonly capture policy is Case01/14 and tool `search_memory`. It must be constructed after canonical retrieval/projection from the returned canonical row fields. Bind the proof to record ID, row tenant/client, source version, content offset/end/truncation, and exact passage hash. A shared-secret HMAC over a canonical representation is preferable to trusting a boolean/marker or arbitrary JSON fields; use only the existing internal service secret and fail closed if unavailable. Keep the HMAC input schema/version fixed and do not include user-controlled values as authority. Do not emit it for other tools/cases.

C. At `observeControlledReadHttpResponse` (or a separate tightly scoped memory observer called there), accept this proof only for the active `withControlledReadInvocation` entry where `tool === 'search_memory'`, `callId` is nonempty, capture policy is exactly Case01/14, HTTP status is 200, and the API tool outcome is a non-error usable read. Verify the HMAC, response record ID equals the canonical `memoryItemId`/`recordId`, projected value hash equals the proof hash, and version/scope fields are well-typed. Reject duplicate or ambiguous IDs, missing/extra proof records, mismatched result/record IDs, blocked/error/unavailable results, or coverage contradictions. Do not treat a response hash alone as authority: it only fingerprints transport bytes and is not a proof that caller-supplied ownership claims are true.

D. Retain the verified observation in an independent, typed, call-scoped collection (not by fabricating a Case20 `MeriControlledReadAttempt`). Include call ID, tool, source ID, actual source tenant/client, version, exact passage hash, content-read/truncation fact, and response hash. Return cloned observations only from the current trusted policy scope. Feed them into `observeMeriV3CaptureExecution` and join each source only on all of: `search_memory`, actual call ID, citation/source ID, canonical version, and exact UTF-8 citation snippet hash. If the citation excerpt is not byte-identical to the observed projected passage, leave authority UNKNOWN; do not broaden the join to substring/title/fixture ID. Set `fullRead` only from the observed content truncation/coverage facts, not from general search coverage or a policy assertion. Case20 stays on its current dedicated code path.

E. Keep `MeriCaptureSourceObservation` and receipt blocker semantics strict. A verified tenant/client should be sourced solely from the call-scoped API proof. Do not change policy tenant into a fallback. Do not change `qualifiedCase20PublicSource`, generic receipt validation, or Case20 ownership logic to make this pass.

## Meaningful tests required before accepting the candidate

API adapter/projection tests:
- A canonical governed row with tenant A/client B produces only those row-owned values, exact ID/version/offsets and the hash of the actual projected UTF-8 text; changing caller tenant/client does not change the row provenance.
- Null client and absent source version are represented explicitly and are not filled from caller/policy values.
- Projection continuation reports the exact page's passage hash and offsets; a truncated page is not marked full-read.
- No capture authority metadata outside admitted Case01/14 `search_memory`; do not alter ordinary tool output beyond any deliberately reviewed non-capture fields.

Transport observation tests:
- Positive actual local authenticated HTTP response for Case14 joins only the actual call ID/tool/record ID and preserves the verified canonical row tenant/client/version and passage hash.
- Reject a forged JSON ownership object with no valid API HMAC; reject validly signed but mismatching record ID, altered passage, version, tenant/client, malformed hash, duplicate IDs, extra proof, and source/result ID disagreement.
- Reject non-200, blocked/error/unavailable logical outcomes, wrong tool/case, missing call identity, duplicate response, and mismatched call scope. Ensure none can later produce observed source ownership.
- Confirm Case20's controlled-read observation and existing positive/negative tests remain unchanged.

Capture/receipt tests:
- Positive memory citation exact-join emits observed canonical tenant/client/version and passage hash and is accepted by the existing strict receipt checks when all other required evidence is supplied.
- Citation ID mismatch, call ID mismatch, version mismatch, snippet-hash mismatch, citation excerpt differing from returned passage, absent proof, failed/blocked read, or policy-tenant-only data all leave ownership UNKNOWN and retain the expected source authority blocker.
- A fixture marker/caller JSON/policy tenant alone never changes UNKNOWN into OBSERVED. Confirm Case20 public-source exception behavior is unchanged.

## Limitations / review gates

- No implementation or tests were run here; no positive authority claim is established.
- HMAC plumbing and the precise API capture-policy guard need inspection in the owning services before coding. In particular, verify the API has the trusted current-turn policy at `searchMemory`, and ensure an HTTP caller cannot cause this metadata to be emitted by merely posting a policy-shaped JSON body.
- Citation snippet construction must be inspected in the actual shared `extractCitationsFromToolResult` implementation before choosing exact passage joins. If snippets are intentionally shortened, do not weaken to substring matching; define a production-owned exact excerpt/hash pair at the API boundary and join that exact pair instead.
- Receipt `fullRead` semantics must be checked end-to-end before assigning it. Search coverage completeness does not establish complete content bytes for each memory source.
- Root review must inspect the final diff and run positive/negative tests. Do not replay or replace the old failed capture as part of this candidate.
- No repository files outside this isolated evidence-copy directory were modified.