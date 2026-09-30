# Trusted server capture evidence receipt contract

Status: producer contract implemented; collector/verifier binding pending independent review. This contract does not open the `LIVE_CAPTURE` guard and does not authorize a deployment, fixture seed, provider call, write sink, or acceptance PASS.

## Machine-readable TypeScript contract

The executable contract is exported from `@capiro/meriv2-core` at `packages/meriv2-core/src/context/capture-evidence-receipt.ts`:

- `MeriCaptureEvidenceReceipt`
- `SignedMeriCaptureEvidenceReceipt`
- `completeMeriCaptureEvidenceReceipt(...)`
- `signMeriCaptureEvidenceReceipt(...)`
- `verifyMeriCaptureEvidenceReceipt(...)`

`version` is `1`, `kind` is `server_capture_evidence_receipt`, `purpose` is `server_capture_evidence`, and the HMAC audience is `capiro:meri:server-readonly-capture:evidence:v1`. The existing `INTERNAL_SERVICE_SECRET` service-identity domain signs transport; no second secret, public endpoint, authority store, or telemetry system is introduced.

The signed receipt carries this exact tuple:

`purpose / caseId / captureRunId / tenantId / actorUserId / clientId / conversationId / turnId / requestId / traceId / sourceId / API release / orchestrator release / fixture namespace+version+physical-map+reset+seed`

Every source row also joins `sourceId -> toolCallId -> actual tool call`. Every observation that can be absent uses `{ status: 'OBSERVED' | 'UNKNOWN' | 'PENDING_BINDING', value, reason }`; absent data is never encoded as zero, an empty PASS, or a made-up locator. Receipt-level status is derived as `COMPLETE` only when required bindings are observed; otherwise it is `BLOCKED`. `NOT_RUN` is reserved for a producer that never executed.

Signatures authenticate server authorship and detect tampering. They are not independent deployment proof. `releases.*.deploymentProof` remains `PENDING_APPROVED_BUILD_RECEIPT_CROSSCHECK`; the future verifier must cross-check approved GitHub Actions build records, immutable ECR digests, and the served runtime identity. A self-reported SHA, environment variable, HMAC, ECS label, or API/orchestrator agreement cannot satisfy that gate by itself.

## Producer bindings

The API remains the authority for the current actor, tenant, conversation, selected client, memory wall, fixture tenant, user-message turn ID, assistant-message metadata, current-authority readback, and private-output release. Model text, tool text, browser fields, and unsigned collector configuration are never identity inputs.

The orchestrator observes only the actual native V3 execution path:

- provider and effective model returned by the provider adapter;
- provider-returned usage, with unknown fields explicit;
- existing shared pricing estimate only when the effective model has a registered price (no new pricing model);
- actual function call IDs, names, outcomes, read-only classification, and source IDs;
- canonical source IDs/current versions/coverage/locators and passage or byte hashes only where the owning source result supplies them.

No numeric page/slide/section locator may be inferred from prose or expected fixture data. A snippet hash is a bounded observed-passage hash, not a source-byte hash. A document content hash is recorded separately as `byteSha256` only when the existing document owner supplies it.

The API records bounded capture-path write hooks for context evidence, the conversation user message, assistant message, and receipt-metadata persistence. These hooks are authoritative only for those named paths; they are not a generic database audit. Any observed non-read-only tool, unexpected write, unmatched source/tool call, unknown logical effect, expired receipt, failed current-authority readback, or extra sink observation blocks the receipt.

The final receipt is persisted in the existing authorized assistant-message metadata and is returned with the terminal captured-turn frame. Readback uses the existing conversation/message authorization path; no new public unscoped receipt endpoint is permitted. Current actor/tenant/client/conversation authority is required before receipt persistence, exact metadata readback, and private-output release.

Ordinary short chat has no capture policy and remains unchanged. Capture is restricted to the existing synthetic fixture tenants, bounded output fence, static read-only catalog, suppressed incidental writers, no attachments/reruns/artifacts, and the existing signed policy transport.

## Collector-worker binding notes

The next collector worker should consume the authorized conversation-message readback and require the final `serverCaptureEvidenceReceipt` metadata object to structurally equal the terminal frame object. Object key order may change in PostgreSQL JSONB; values and array order must remain exact. HMAC signing and envelope digests use the shared canonical JSON serializer so that key reordering preserves verification. It must then:

1. verify the HMAC purpose/audience, expiry, and exact policy tuple;
2. verify current authenticated actor/tenant/client/conversation authorization at readback;
3. map physical source IDs to frozen IDs using the separately reviewed fixture-owner contract;
4. verify fixture version, physical-map SHA-256, reset receipt, and seed receipt against that owner contract;
5. cross-check API and orchestrator runtime revisions against approved GitHub Actions/ECR build receipts;
6. compare receipt tool/source/write observations with the raw controlled capture artifacts and authoritative source/effect readbacks;
7. reject extra raw tool calls, sources, writes, effects, or usage not represented by the receipt;
8. leave cost `UNKNOWN` when no existing usage owner supplies a trustworthy estimate; and
9. keep `LIVE_CAPTURE` `BLOCKED` until the independently reviewed verifier implements all checks above.

Pending bindings, intentionally not claimed here:

- separately owned canonical fixture namespace/version/physical map/reset/seed contract;
- canonical source-owner adapters for every Appendix F source family, including budget case 20;
- approved build-receipt/ECR/deployed-runtime cross-check;
- exhaustive delayed/non-tool effect audit beyond the bounded capture hooks;
- shared aggregate provider-budget reservation interface from commit `a0821d4f5` (compatibility only; not copied);
- downstream export of joined redacted telemetry; this producer already consumes current task usage observations, while telemetry itself is not authority;
- independently reviewed collector/verifier and any actual deploy/live execution.

The existing live verifier remains deliberately closed. Producer tests establish contract construction, joins, signature/purpose validation, tamper/expiry/current-authority failures, and extra-observation blocking only; they do not prove a deployed service, live source, provider bill, fixture seed, or product PASS.
