# Core client document source preparation — 2026-10-18

This dedicated branch is stacked on Core draft PR87 at
`8130f4404d770db396b6732aac436d6e9ac93b82`. It completes the retained document
output validator and prepares a current, selected-client owner read with all
provider extraction disabled. **The document receiver remains 503.** This is
source preparation, not a runtime, pricing, allocation or deployment receipt.

The additive [receiver source gate](CORE-CLIENT-DOCUMENTS-RECEIVER-20261018.md)
now receives Meri PR162's immutable text-only tariff from the original locked
allocation. It remains unavailable by default because no independent current
runtime image/configuration identity reader is registered.

## Exact contract

`read_client_documents@0.2.0` remains unchanged. The complete document schema
is mirrored byte for byte from Meri PR158; its content is unchanged between
`052f9865879a983a348d5903b2b52c2675287a04` and observed head
`cdc1c04342da022117401284b4e6bbac032ef84d`:

- `client-documents.schema.json` SHA-256:
  `71dd53119af2c0226372916e3645765687e8653da2f48b60d55c1a7a75c05247`.
- The semantic port preserves Meri `client-documents-validation.mjs` at SHA-256
  `a545d51cda2e8d430ebb66f739524f55fc243ac87a923ea96dc140bab50c10e9`.
- Referenced RunBinding and ResolvedSubject schemas use the existing full
  `mail-base.schema.json` and `mail-common.schema.json` mirrors.

Core checks the full nested list/read result, UTF-16 ranges, source and section
hashes, exact record references, list and content continuations, readability,
missing-content disclosure, completeness and binding/subject lineage. It
renormalizes the translated legacy selector and compares all normalized input
fields before a source read. Document metadata is null; the trusted signed
normalization context must equal exactly `{binding,subject}`. Neither the
output DTO nor its lineage wrapper contains an actualCost or deadline field.

## Real owner boundary

`MeriToolsService.readRetainedDocumentSourceV02` calls the canonical
`readClientDocuments` owner with a server-owned `allowPaidExtraction:false`
option. That option never comes from tool arguments. The actual
`EngagementService.extractAttachmentText` implementation rejects audio/video
before reaching Whisper, skips PDF vision, and rejects context import under
this option. A blank PDF text layer returns its truthful text readability and
missing-content disclosure; it does not report an attempted visual read.

The source method checks the selected-client wall before and after the read,
checks the task deadline/cancellation between owner stages, compares the
current visible attachment inventory before and after extraction, checks list
coverage/metadata against that inventory and validates the complete output
before returning. The existing attachment owner still applies viewer ACL,
client/meeting parent, hearing, readiness and current file-version checks
before reading bytes. Output stays bounded to 16 MiB. Provider-derived read
records/readability/extraction metadata are refused in this prepared mode.

The paid pricing evidence parser now accepts a Git SHA40 source commit,
matching Meri's manifest, with integer nonnegative prices, at most 2,000,000
vision input tokens and at most 86,400 audio seconds. This parser checks the
evidence shape; no measured evidence is created and the prepared owner method
does not enable any paid branch.

## Exact remaining dependencies

Observed Meri `general-read-tariffs.mjs` has
`read_client_documents@0.2.0` chargeMicrousd null and
`GENERAL_READ_DOCUMENT_BOUNDS.transcription.maxAudioSeconds` null.
`general-read-allocation.mjs` excludes the operation without documentPricing;
`general-read-manifest.mjs` requires the full paid vision/transcription evidence
regardless of list/read selection. Meri's retained-read owner is preparing an
explicit source-enforced text-only allocation variant in a separate branch.
Its immutable manifest/selection/config contract and matching measured Core
source/image/config pins must be received before mounting this source mode.

For paid extraction, the absent fields remain actual resolved vision model,
input/output microusd per million tokens, maxInputTokens, whisper-1
microusdPerMinute, maxAudioSeconds and matching measured coreSourceCommit,
coreImageDigest and configurationSha256. The current model table is labeled
an estimate and has no Whisper price. Tenant modelOverride and model upgrade
logic affect the actual vision model/output cap. There is no adopted reliable
media-duration decoder or derived bounded audio stream in the API runtime;
the 25 MiB upload bound cannot establish audio duration. A duration label or
file size must not be used as a pre-call cost cap.

The existing signed relay, runtime key/facts grants, listener/deployment and
readback gates from PR87 still apply. No live AWS/SQL, credential or grant
creation, deployment, paid build or paid provider/source call was performed.

## Verification

Focused canonical extraction, owner wrapper, full document contract,
current-source and Monday/document projection tests pass: **5 suites, 51 tests**. The pure document
contract and projector pass a narrow TypeScript check. The receiver test proves
the prepared owner is not invoked by the still-closed document route. Tests
exercise malformed nested output, changed hashes/cursors, current metadata,
wall revocation, deadline expiry, provider-call spies and blocked blank PDFs.
