# Independent Hermes review — Case14 run 5f4312a2-6aa9-4ec8-820d-5717a88402df

## Scope and disposition

READ-ONLY review of the saved manifest/evidence and the exact code snapshots listed by `evidence/manifest.json`. No live systems, APIs, databases, sessions, or implementation lane were accessed. No source code was changed. The manifest identifies the reviewed snapshots by SHA-256; these findings apply to those snapshots.

**NOT APPROVED.** This was one approved capture, with terminal projection and provider-budget setup completed, followed by one recall. The existing capture failed collector acceptance and must remain failed. `observed-*` files are authenticated diagnostics of existing rows, not capture authority. Do not replay, reapprove, reseed, reconstruct capabilities, or promote this run. The summary itself says `acceptanceStatus: NOT_RUN`, `captureAuthority: false`, `applicationWrites: 0`, `providerCalls: 0`, and `newTurns: 0` for the diagnostic read. The original prompt/human rubric remains NOT_RUN; `fullcase` and `fullFile01` are false.

## Findings

### 1. Case14 collector conflates distinct source representations — confirmed collector defect

`evidence/evals/meri/live-v1/case01-receipt-joins.mjs` applies the Case01 join in `assertMemoryReceiptJoins` to Case14. In particular, it requires the receipt source current version to equal either the fixture source version or `content:${fixture DB contentSha256}`, and also requires the SHA-256 of the full API readback text to equal that DB content hash (lines 202–234). That is not a valid equality contract for this Case14 fixture: it has several legitimate, distinct representations.

The saved evidence agrees on the exact physical record (`a740d74f-2c61-4888-bb59-5c9eea502e3f`) and its canonical owner:

- Fixture source version: `candidate:6f4545a1-dcd5-5eba-8606-db2043b238ac`.
- Fixture/DB provenance `contentSha256` / `contentHash`: `e398859f2cda473be80da00d8e849a958646f9b105292823f005c848938af8cc`.
- Exact source text: `Synthetic Aster candidate for approval`; its text/passage SHA-256 is `cda1a974afa696537646a4b057bc83964ac0185a4d962a12f200bd17a59ce9be`.
- Citation and authenticated source endpoint `currentVersion`: `content:663dadd36e2a7a58c434215a3f19fdec12b07f7d1152a90a0f4a5b53fd8ca50b`, with `versionStatus: matches_cited_version`.

These are not interchangeable hashes or version aliases. The observed source endpoint reports the exact record, offset 0, `totalCharacters: 38`, no next cursor, and the full approved text. The observed fixture authority supplies the approved decision/audit, `approvedText`, source owner/tenant/client, source version, and DB provenance hash.

**Safe correction:** leave `assertCase01ReceiptJoins` and Case01 rules unchanged. Implement a separate Case14-specific source join (or an explicit case-specific branch) that preserves all common authenticated envelope/admission/policy/fixture/tool/citation joins, and then requires:

1. The authenticated Case14 fixture authority is still canonical and internally consistent: exactly the expected logical/physical source, tenant/client, candidate ID, approved decision by the expected actor, transition audit ID, `sourceVersion === candidate:${candidateId}`, exact fixture DB `contentSha256`, and exact `approvedText`.
2. The authenticated actual source readback is for that exact physical `recordId`, is available, starts at offset 0, has the complete expected character count, has no continuation cursor (or, if paging is required, all pages are fetched/verified as one complete source), and its entire text is byte-for-byte equal to `fixture.approvedText`. Do not validate only a prefix, citation snippet, or partial first page.
3. The receipt source joins to the actual tool call and source ID, and citation joins to that source. Its observed `currentVersion` must equal the citation/receipt source version, and the readback must report `versionStatus === matches_cited_version`. Require the fixture source version and provenance DB hash from the canonical fixture/readback authority; do not pretend either equals the endpoint’s `content:` hash or the passage hash.
4. Reject contradictory/missing/UNKNOWN authority rather than weakening checks. Do not “fix” this by ignoring hashes, accepting arbitrary aliases, or treating the diagnostics as the original run’s authority.

**Negative tests required:** preserve a passing Case14 fixture for the above exact conditions; reject wrong physical source/owner, tenant or client; wrong candidate/source version/provenance hash; wrong or unapproved actor/audit/decision; any changed character in approved text; text that is truncated, paginated incompletely, wrong offset/count, or has a non-null continuation; wrong citation source or tool-call join; wrong/UNKNOWN currentVersion; citation/currentVersion mismatch; `changed_since_citation`; and a hash/value contradiction between canonical fixture, actual full readback, and receipt. Also keep the existing strict Case01 tests proving Case01 still rejects a mismatching full-byte hash/version and has no Case14 exception.

### 2. Tool endpoint returns 201 for success while clock evidence requires 200 — confirmed live API receipt defect

The saved actual receipt records the one `search_memory` tool call as `returned`, `httpAttempts: 1`, `httpStatus: 201`, with one response hash and one persisted compiler packet. `packages/meriv2-core/src/context/capture-evidence-receipt.ts` treats any invocation whose HTTP status is not exactly 200 as `semantic_clock_invocation_join_unproved` (lines 275–289). This strict behavior is correct: the saved run cannot be accepted by loosening the producer/receipt protocol.

In the reviewed controller snapshot, `apps/api/src/meri/meri.controller.ts` declares `@Post('tools/:name')` at line 501 without `@HttpCode(200)`. Nest’s default POST success status is 201. Thus the actual tool route response conflicts with the clock evidence contract for this successful read endpoint.

**Safe correction:** explicitly return HTTP 200 on this specific successful tool-execution route (e.g. import/use Nest `@HttpCode(HttpStatus.OK)` or `@HttpCode(200)` on `executeTool`). Do not change global POST defaults, core receipt status validation, or invocation retry/malformed-response validation. Do not rewrite the saved 201 observation.

**Focused tests required:** assert the `executeTool` route has explicit 200 metadata or exercise a successful request through the actual Nest HTTP adapter and assert status 200; separately assert thrown/guard/validation errors retain their established error statuses and are not converted to 200. Keep producer/core tests rejecting 201, non-200, missing/malformed response hashes, multiple attempts/retries, and malformed invocations. A fabricated 200 in a collector-only fixture is not proof of the route correction.

### 3. Clock packet owner joins remain a separate blocking proof — not cured by the two fixes above

The diagnostic summary lists both `semantic_clock_api_tool_join_pending` and `semantic_clock_invocation_join_unproved`. The saved clock invocation for the single search call is explicitly HTTP 201, so the exact-200 protocol is a concrete reason the signed orchestrator receipt cannot currently join. The API join implementation in `apps/api/src/meri/meri-capture-clock-packets.ts` additionally requires actual persisted packet rows and validates tenant/effective tenant, user, actor (for v2), client, surface, conversation, operation, scope, packet identity, stored compiler clock metadata, and tool capture references. Its tests cover many foreign/missing/extra packet cases. Keep that strict owner join and require a new independently authorized run to establish it after code changes; no such run is authorized here.

Further review blocker: observed `initialPacket` packet `c24b6d6a-6fc7-4d7d-89fe-31aa2082d579` is marked `truncated: true` even though `sourceRecordCount` and `projectedRecordCount` are both 4. The packet/evidence summary reports `initialContext.complete: false`, `truncated: true`, `stopReason: model_context_projection_truncated`. The broader turn coverage is also `complete: false` / `truncated: true` / `turn_coverage_partial`. A successful later memory recall and a correct clock packet owner join do not establish completeness of what was present in initial model context. Retain this as a separate unresolved completeness finding; do not infer that every matched record’s complete content was projected merely from record counts.

The saved `semanticClock` prompt date/instant is observed as `2026-09-26` / `2026-09-26T16:00:00.000Z`; the reviewed code pins this qualified fixture clock. This review does not endorse changing or relaxing the fixed semantic-clock authority. Ensure any relevant date/comment mismatch remains visible and is resolved against the qualified fixture source, not the machine clock or a collector assumption.

### 4. Source tenant authority is still UNKNOWN — separate receipt blocker

The saved source receipt has an observed source ID and client ID, passage hash and current version, but `tenantId` is explicitly `UNKNOWN` (`canonical_source_tenant_not_reported`) and `byteSha256` is explicitly `UNKNOWN`. The summary retains `source_tenant_authority_unproved:a740d74f-2c61-4888-bb59-5c9eea502e3f`. Although the separate authenticated source readback exposes tenant/record/provenance and is useful for the Case14 full-text join, it does not retroactively change the signed invocation receipt fields into observed values. Do not erase the blocker or declare source ownership complete solely because a diagnostic source lookup shows a tenant. Any future acceptance path must obtain canonical source-tenant authority from the actual owning API/receipt path and join it to the actual source/tool invocation, while preserving fail-closed handling of UNKNOWN.

## Review conclusion

The two proposed code corrections are narrowly justified: Case14 needs a case-specific exact-full-text/canonical-authority join because its legitimate hash representations differ, and the successful read-only tool route needs HTTP 200 because the core clock protocol deliberately requires it. Neither correction repairs this failed capture, establishes clock packet ownership, resolves initial-context truncation, fills UNKNOWN tenant/byte provenance, or completes the original prompt/human rubric. Keep this run failed and all those blockers visible; any future capture must be independently authorized and judged under unchanged strict protocol checks.

## Evidence / code locations

- `evidence/manifest.json` — hashes for the reviewed source snapshot and diagnostics.
- `evidence/observed-source.json` — full 38-character source response, canonical record/provenance, current version and version status.
- `evidence/observed-messages.json` — failed receipt/source joins, 201 tool response, clock invocation/packet, initial-context and turn-coverage truncation, explicit UNKNOWN tenant/byte hash, and persisted Case14 fixture authority.
- `evidence/observed-summary.json` — NOT_RUN status and retained blockers.
- `evidence/evals/meri/live-v1/case01-receipt-joins.mjs` — common Case01 hash/version requirements and Case14 delegation.
- `evidence/evals/meri/live-v1/tests/case14-capture.test.mjs` — existing Case14 join and negative-test suite to extend without weakening.
- `evidence/packages/meriv2-core/src/context/capture-evidence-receipt.ts` — exact HTTP 200 and clock invocation checks.
- `evidence/apps/api/src/meri/meri.controller.ts` — tool route lacking explicit success status.
- `evidence/apps/api/src/meri/meri-capture-clock-packets.ts` and `.spec.ts` — persisted packet owner join and fail-closed tests.
- `evidence/apps/meriv2-orchestrator/src/meri/meriv3/meriv3-capture-evidence.ts` — generic source observer records tenant and source bytes as UNKNOWN when the actual citation/tool observer does not report them.
- `evidence/apps/api/src/meri/meri-context-plane.tools.spec.ts` — clocked memory tool/context-plane behavior; does not establish initial projection completeness for this saved run.

This review artifact is advisory and is not an acceptance receipt, capture authority, or deployment approval.
