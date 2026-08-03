# Budget Verification Gate V1

## Trust boundary

The V1 verification gate answers:

> Does this exact, immutable extraction artifact faithfully and completely represent the supplied official source document according to the approved document-family policy and independent reconciliation evidence?

It does **not** answer:

> May these assertions now be written into canonical Program Element tables?

Canonical promotion remains forbidden in Phase 2. `VERIFICATION_PASSED` contains no canonical implication. No promotion token, canonical eligibility property, or canonical records are produced.

## Proof resolver responsibilities

The `TrustedProofResolver` independently resolves:

- **Manifest bytes** — re-hashed from actual file/locator bytes
- **V1 extraction artifact bytes** — byte SHA and content SHA recomputed
- **Source document** — loaded by exact `sourceDocumentId`, SHA compared
- **Archive** — bucket, key, exact VersionId, object SHA, byte size, Object Lock metadata
- **Parser runs** — method-specific proof (LlamaParse job lineage, deterministic parser output SHA, manual review trigger)
- **Reference artifacts** — independently proved with different source SHAs

No rule engine may directly query the database or S3. All external proof access is isolated behind the resolver.

The resolver never accepts caller-provided `archiveProof`, `parseProof`, `approvedSha256`, `promotionReady`, or `canonicalEligible`.

## Check outcomes

| Outcome | Meaning |
|---------|---------|
| `PASS` | The rule executed and passed |
| `FAIL` | The rule executed and failed |
| `NOT_RUN` | Required inputs were unavailable or no provider/reference was supplied |
| `SKIPPED` | Policy explicitly determined the rule is inapplicable |

`NOT_RUN` and `SKIPPED` are never represented as `PASS`. A required `NOT_RUN` forces at least `REVIEW`.

## Policy hashing

Policy JSON is canonicalized using the Phase 1 canonical serializer and `policySha256` is computed. Every run persists the exact policy SHA. The same artifact, manifest, verifier version, and policy must produce the same candidate/run identity inputs.

## Family policy matrix

| Family | Exhibit | Required categories | Evidence | Comparisons | Review triggers |
|--------|---------|--------------------|---------|-------------|-----------------|
| RDTE | R-1 | identity, funding | cell_bbox | R-1↔R-2 summary/detail | manual, OCR, uncorroborated congressional/enacted |
| RDTE | R-2 | identity, funding, projects | cell_bbox | R-1↔R-2 summary/detail | manual, OCR, uncorroborated congressional/enacted |
| RDTE | R-2A | identity, funding, project_funding | cell_bbox | project rollup | manual, OCR, uncorroborated congressional/enacted |
| RDTE | R-3 | identity, funding, performers | cell_bbox | — | manual, OCR |
| Committee | HASC/SASC/HAC-D/SAC-D/NDAA conference/Approps conference/Public law | identity, funding | cell_bbox | committee_request_reference | manual, OCR, uncorroborated congressional/enacted |
| Procurement | P-doc | identity, funding, procurement_lines, quantities, unit_cost | cell_bbox | procurement rollup | manual, OCR |

Unsupported families (O&M, MILCON without complete adapters) return `NEEDS_REVIEW` or `REJECTED` with a `verification_policy_not_implemented` finding.

## Decision precedence

Applied in order:

1. Any blocking `FAIL` → `REJECT`
2. Any required proof failure → `REJECT` (unless policy explicitly marks archival absence reviewable)
3. Any required check `NOT_RUN` → at least `REVIEW`
4. Any review-severity omission/warning/discrepancy → at least `REVIEW`
5. Manual/OCR/congressional/enacted review triggers → at least `REVIEW` (unless required corroboration passes and policy permits machine pass)
6. Only when every required check passes and no review trigger remains → `PASS`

Risk score never overrides a blocking failure or required `NOT_RUN`.

## Review rules

- **M1**: Only a candidate with latest terminal status `NEEDS_REVIEW` may be reviewed
- **M2**: Blocking findings (source SHA mismatch, artifact hash mismatch, manifest mismatch, parser lineage corruption, duplicate conflicting money assertions, field ownership violation, invalid identity, blocking omission, failed required arithmetic reconciliation) cannot be waived
- **M3**: Reviewable findings (page-only evidence with manual inspection, missing optional comparison, manual extraction with exact page evidence, OCR money with independent human page confirmation, uncorroborated congressional/enacted after source-page inspection) may be accepted
- **M4**: Expected hashes are concurrency guards and review binding, not source proof
- **M5**: Segregation of duties required for high-risk extraction methods (manual, PaddleOCR, congressional marks, conference values, enacted values, high-materiality values)
- **M6**: Immutable append-only review decision — accepted → `REVIEW_ACCEPTED`, rejected → `REJECTED`
- **M7**: Concurrent double review prevented via optimistic state checks

A corrected candidate must be a new artifact and a new verification candidate. No canonical promotion property is created.

## Audit persistence

One transaction atomically:

1. Creates or reuses the exact candidate (idempotency by manifest SHA + source SHA + artifact SHA + verifier version + policy SHA)
2. Sets/verifies `VALIDATING` state
3. Inserts completed run
4. Inserts proof snapshots (append-only)
5. Inserts checks
6. Inserts discrepancies
7. Updates final candidate status
8. Commits

Any failure rolls back all of the above. Completed runs, checks, proofs, and reviews are append-only. Candidate status may be updated only through controlled lifecycle transitions.

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

Exit codes: 0 = VERIFICATION_PASSED, 2 = NEEDS_REVIEW, 3 = REJECTED, 1 = execution failure.

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
  [--commit]
```

### Cycle report (read-only)

```bash
pnpm --filter @capiro/api report:defense-budget-verification-cycle-v1 -- \
  --manifest <cycle-manifest.json>
```

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

## Scripts are not ECS entrypoints

Phase 2 CLI commands are local/operator/CI commands. They are not added to `entrypoint-dispatcher.inc` and remain local until later operational integration.
