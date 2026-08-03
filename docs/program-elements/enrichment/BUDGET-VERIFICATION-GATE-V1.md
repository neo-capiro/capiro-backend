# Budget Verification Gate V1

> **STATUS: IMPLEMENTATION INCOMPLETE — REMEDIATION IN PROGRESS**
>
> The Phase 2 verification gate is undergoing remediation. Until the
> remediation is complete on one exact SHA and all definition-of-done items
> pass:
>
> - The gate is **not authorized for production use**.
> - The migration `20260816010000_budget_verification_v1` is **not approved**
>   and has not been applied to any shared environment.
> - `VERIFICATION_PASSED` is **not yet trusted** as a verification decision.
> - No ingestion, scheduler, API controller, Nest module, canonical writer, or
>   operational command consumes Phase 2 results.
>
> This document describes the target architecture. Until remediation completes,
> treat the code as a scaffold under repair, not a trusted verifier.

## Trust boundary

The V1 verification gate answers:

> Does this exact, immutable extraction artifact faithfully and completely represent the supplied official source document according to the approved document-family policy and independent reconciliation evidence?

It does **not** answer:

> May these assertions now be written into canonical Program Element tables?

Canonical promotion remains forbidden in Phase 2. `VERIFICATION_PASSED` contains no canonical implication. No promotion token, canonical eligibility property, or canonical records are produced.

## Byte hashing

The verifier hashes raw bytes, never encoded strings.

- `sha256Bytes()` is used for PDFs, JSON file bytes, parser outputs, and S3 objects.
- `sha256Hex()` is used only for deliberate UTF-8 string hashing.
- Canonical JSON hashing is used only for normalized logical content.

No binary hashing path uses `buffer.toString('binary')` or `buffer.toString('utf8')` unless the hash is explicitly intended to cover that encoded string.

## Source-document proof

The `SourceDocumentProofResolver` independently:

- loads the exact requested `sourceDocumentId` from the database;
- fails closed when the row is missing;
- compares the row SHA with actual PDF bytes;
- compares the artifact source SHA with actual PDF bytes;
- validates source key, fiscal year, component, document type, and budget cycle where represented;
- compares artifact `sourceDocumentId` when present.

A "trusted" SourceDocument proof is never constructed from artifact fields when the database dependency is absent.

## Archive proof

The `ArchiveProofResolver` resolves and verifies:

- bucket;
- key;
- exact VersionId;
- actual bytes or trusted checksum;
- source SHA;
- artifact source SHA;
- SourceDocument SHA;
- object byte size;
- encryption and Object Lock metadata where available.

A nonempty bucket/key/version combination is not proof by itself.

## Parser-run proof

The `ParserRunProofResolver` verifies for each parser method:

- input source SHA;
- parser version;
- parser configuration SHA;
- output artifact bytes;
- output artifact SHA;
- page ranges cover the evidence attributed to the parser run.

For LlamaParse, the real persisted parse-job record is required when one should exist. For manual extraction, source and artifact bytes are proved but a mandatory review trigger is always created.

## Independent reference-artifact proof

Each reference artifact is independently proved via `resolveArtifactProof(locator, sourceDocumentId, context)`. Each has its own:

- artifact byte SHA;
- content SHA;
- SourceDocument lookup;
- source PDF SHA;
- archive proof;
- parser-run proof;
- findings;
- locator.

The candidate's SourceDocument or archive proof is never reused for a reference artifact.

## Policy hashing

Policy JSON is canonicalized using the Phase 1 canonical serializer and `policySha256` is computed. Every run persists the exact policy SHA. The same artifact, manifest, verifier version, and policy must produce the same candidate/run identity inputs.

## Family policy matrix

| Family      | Exhibit                                                             | Required categories                                         | Evidence  | Comparisons                 | Review triggers                                   |
| ----------- | ------------------------------------------------------------------- | ----------------------------------------------------------- | --------- | --------------------------- | ------------------------------------------------- |
| RDTE        | R-1                                                                 | identity, funding                                           | cell_bbox | R-1↔R-2 summary/detail      | manual, OCR, uncorroborated congressional/enacted |
| RDTE        | R-2                                                                 | identity, funding, projects                                 | cell_bbox | R-1↔R-2 summary/detail      | manual, OCR, uncorroborated congressional/enacted |
| RDTE        | R-2A                                                                | identity, funding, project_funding                          | cell_bbox | project rollup              | manual, OCR, uncorroborated congressional/enacted |
| RDTE        | R-3                                                                 | identity, funding, performers                               | cell_bbox | —                           | manual, OCR                                       |
| Committee   | HASC/SASC/HAC-D/SAC-D/NDAA conference/Approps conference/Public law | identity, funding                                           | cell_bbox | committee_request_reference | manual, OCR, uncorroborated congressional/enacted |
| Procurement | P-doc                                                               | identity, funding, procurement_lines, quantities, unit_cost | cell_bbox | procurement rollup          | manual, OCR                                       |

Unsupported families (O&M, MILCON without complete adapters) return `NEEDS_REVIEW` or `REJECTED` with a `verification_policy_not_implemented` finding.

## Check outcomes

| Outcome   | Meaning                                                                |
| --------- | ---------------------------------------------------------------------- |
| `PASS`    | The rule executed and passed                                           |
| `FAIL`    | The rule executed and failed                                           |
| `NOT_RUN` | Required inputs were unavailable or no provider/reference was supplied |
| `SKIPPED` | Policy explicitly determined the rule is inapplicable                  |

`NOT_RUN` and `SKIPPED` are never represented as `PASS`. A required `NOT_RUN` forces at least `REVIEW`.

## Decision precedence

Applied in order:

1. Any blocking `FAIL` → `REJECT`
2. Any required proof failure → `REJECT` (unless policy explicitly marks archival absence reviewable)
3. Any required check `NOT_RUN` → at least `REVIEW`
4. Any review-severity omission/warning/discrepancy → at least `REVIEW`
5. Manual/OCR/congressional/enacted review triggers → at least `REVIEW` (unless required corroboration passes and policy permits machine pass)
6. Only when every required check passes and no review trigger remains → `PASS`

Risk score never overrides a blocking failure or required `NOT_RUN`.

## Arithmetic and comparison evidence

- Exact-decimal arithmetic: `addDecimals`, `subtractDecimals`, `multiplyByInteger`, `absDifference`, `compareWithTolerance`, `sumDecimals`. No binary floating-point comparison.
- RDTE summary/detail, project rollup, procurement rollup, and committee-adjustment rules produce discrepancies with severity `blocking` or `review`.
- Cross-document comparison rules (summary-detail, committee-request-reference, historical-consistency) produce `NOT_RUN` truthfully when no reference artifact is supplied. Missing comparison evidence is never converted to `PASS`.
- Reference artifacts are indexed by `ReferenceArtifactIndexV1` and matched by identity natural key.

## Persistence

One transaction atomically:

1. Creates or reuses the exact candidate (idempotency by cycle ID + manifest SHA + document key + source document ID + source SHA + artifact ID + artifact SHA + verifier version + policy version + policy SHA)
2. Sets/verifies `VALIDATING` state
3. Inserts completed run (deterministic UUID)
4. Inserts proof snapshots (append-only)
5. Inserts checks
6. Inserts discrepancies
7. Updates final candidate status
8. Commits

Any failure rolls back all of the above. Completed runs, checks, proofs, and reviews are append-only. Candidate status may be updated only through controlled lifecycle transitions.

### Deterministic IDs

- Candidate ID: deterministic UUID from the complete 10-field candidate identity.
- Run ID: deterministic UUID from candidate identity + startedAt timestamp.
- Inspect and persist modes produce the same IDs.
- IDs are explicitly inserted, not left to database random defaults.

### Idempotent replay

Before persisting, the repository checks for an existing terminal candidate with the same identity. If one exists, the existing immutable result is returned — no duplicate evidence is inserted.

### Transaction integrity

All database writes (candidate, run, proof snapshots, checks, discrepancies, final status) are inside one `$transaction`. Proof resolution happens before the transaction. Unsupported-policy decisions are also persisted — `persist_audit` must not return before recording the unsupported policy outcome. `mode='persist_audit'` fails loudly when no repository is configured.

## Review workflow

### Non-waivable findings

An acceptance decision is rejected when any of these exist:

- source SHA mismatch
- artifact byte/content mismatch
- manifest mismatch
- parser lineage corruption
- conflicting duplicate money assertions
- funding-field ownership violation
- invalid identity
- blocking omission
- failed required arithmetic reconciliation
- required comparison failure classified as blocking
- reference-artifact proof failure classified as blocking

These require: correct/re-extract → new artifact → new candidate → new verification run.

### Reviewable uncertainty

Examples that may be accepted with evidence and notes:

- page-only evidence manually inspected
- optional comparison unavailable
- manual extraction with exact page evidence
- OCR money confirmed against the source page
- nonblocking historical anomaly
- uncorroborated congressional or enacted values manually confirmed

### Review rules

- **M1**: Only a candidate with latest terminal status `NEEDS_REVIEW` may be reviewed
- **M2**: Blocking findings cannot be waived
- **M3**: Reviewable findings may be accepted
- **M4**: Expected hashes are concurrency guards and review binding, not source proof. Run hashes must match candidate hashes.
- **M5**: Segregation of duties required for high-risk extraction methods (manual, PaddleOCR, congressional marks, conference values, enacted values, high-materiality values). When actor data is unavailable, an explicit limitation finding is created rather than pretending independence was established.
- **M6**: Immutable append-only review decision — accepted → `REVIEW_ACCEPTED`, rejected → `REJECTED`. Prior terminal review decisions prevent new reviews.
- **M7**: Concurrent double review prevented via optimistic state checks (candidate must still be `NEEDS_REVIEW` at persist time)

### Evidence ID verification

All evidence IDs supplied in the review input must exist in the run's checks or discrepancies.

A corrected candidate must be a new artifact and a new verification candidate. No canonical promotion property is created.

## CLI commands

### Verify (inspect by default)

```bash
pnpm --filter @capiro/api verify:defense-budget-artifact-v1 -- \
  --manifest <cycle-manifest.json> \
  --document <document-key> \
  --artifact <artifact.extraction-v1.json> \
  --source-document-id <uuid> \
  [--reference-artifact <path>]... \
  [--expected-source-sha256 <sha>] \
  [--expected-artifact-sha256 <sha>] \
  [--persist-audit]
```

Exit codes: 0 = VERIFICATION_PASSED, 2 = NEEDS_REVIEW, 3 = REJECTED, 4 = execution/configuration failure. Default is inspect/read-only. `--persist-audit` must be explicit.

### Review (dry-run by default)

```bash
pnpm --filter @capiro/api review:defense-budget-verification-v1 -- \
  --candidate-id <uuid> \
  --run-id <uuid> \
  --reviewer-id <id> \
  --decision accept|reject \
  --notes-file <path> \
  --expected-source-sha256 <sha> \
  --expected-artifact-sha256 <sha> \
  --expected-manifest-sha256 <sha> \
  [--extractor-actor-id <id>] \
  [--extraction-method <method>] \
  [--commit]
```

Default is dry-run. `--commit` is required for a write. Notes supplied by file only (no sensitive notes in process arguments). Prints candidate ID, run ID, hashes, prior status, final decision, and limitation findings.

### Cycle report (read-only)

```bash
pnpm --filter @capiro/api report:defense-budget-verification-cycle-v1 -- \
  --manifest <cycle-manifest.json>
```

Read-only per-document statuses:

```text
not_present
not_verified
verification_passed
needs_review
review_accepted
rejected
superseded
```

Includes required and optional document counts, missing required documents, unresolved required comparisons, blocking discrepancy counts, and exact source and artifact identities.

## Package scripts

```json
{
  "verify:defense-budget-artifact-v1": "tsx scripts/verify-defense-budget-extraction-v1.ts",
  "review:defense-budget-verification-v1": "tsx scripts/review-defense-budget-verification-v1.ts",
  "report:defense-budget-verification-cycle-v1": "tsx scripts/report-defense-budget-verification-cycle-v1.ts",
  "verify:pe-budget-phase-2": "jest --runInBand --forceExit src/defense-budget/verification src/defense-budget/contracts"
}
```

All scripts are included in `tsconfig.budget-verification-v1.json`.

## Scripts are not ECS entrypoints

Phase 2 CLI commands are local/operator/CI commands. They are not added to `entrypoint-dispatcher.inc` and remain local until later operational integration.

## Explicit absence of canonical promotion

The V1 verification gate:

- Imports no `ProgramElementWriterService`
- Provides no promotion token, canonical eligibility property, or canonical records
- Performs no canonical Program Element write
- Produces no `CANONICAL`, `PROMOTED`, `promotionReady`, or `canonicalEligible` status

`VERIFICATION_PASSED` means "passed verification checks," not "approved for canonical write."

`REVIEW_ACCEPTED` means "human review accepted a reviewable finding," not "canonical promotion authorized."

## Reusability

The gate is reusable for FY2027, FY2028, and later fiscal years. Policy, manifest, and artifact contracts are versioned (`defense_budget_verifier_v1`, `defense_budget_verification_policy_v1`, `defense_budget_extraction_v1`).
