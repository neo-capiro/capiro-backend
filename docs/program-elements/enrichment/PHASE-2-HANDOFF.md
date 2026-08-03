# Phase 2 — Trusted Defense-Budget Verification Gate V1 — Final Handoff

## 1. Branch and commits

- **Branch:** `agent/pe-budget-verification-gate-v1-closeout`
- **Base SHA:** `10e90ad5cf5a4084d95848c8058319ec347329cb` (origin/main)
- **Head SHA:** `430a2a597361dcadec0ee220b3201be9a9a61a6e`
- **Commit list:**
  - `30f8ee98` R0 containment: status banner, legacy barrel, recursive V1 containment gates
  - `912e8440` R1 cryptographic and trusted-proof repair
  - `411a5b7f` R2-R3 audit schema repair and generated-Prisma persistence
  - `38b4f65d` R4 governed non-waivable review with full evidence loading and segregation of duties
  - `967b0a89` R5 operator CLIs, tsconfig, and documentation
  - `1f5f4203` R6 permanent gates, all 16 negative controls, prettier formatting
  - `430a2a59` R7 disposable PostgreSQL rehearsal and artifact smoke
- **Draft PR URL:** Not opened (no merge authorized)
- **Confirmation nothing was merged:** No merge performed. Branch is local-only.

## 2. Prerequisite confirmation

- **Phase 0 merge/commit:** `c78afd57` (PR #740 merged into main)
- **Phase 1 merge/commit(s):** `ecfeebd0` (PR #741 merged), `10e90ad5` (Phase 1 final corrections, PR #742)
- **Phase 1 gate results:** `pnpm --filter @capiro/api verify:pe-budget-phase-1` — 32 suites, 673 tests passed

## 3. Trusted proof implementation

### Manifest proof
- **Files:** `trusted-proof/filesystem-proof-resolver.ts`
- **Source fields used:** manifest bytes from `readFile`, `sha256Hex` for UTF-8 string hash
- **Hash comparisons:** recomputed manifest SHA compared to manifest content SHA
- **Missing-proof behavior:** missing manifest file throws proof error
- **Tests:** `trusted-proof.spec.ts`, `verification-contract-v1.spec.ts`

### Extraction artifact proof
- **Files:** `trusted-proof/extraction-artifact-proof-resolver.ts`, `filesystem-proof-resolver.ts`
- **Source fields used:** artifact bytes from `readFile`, `sha256Bytes` for raw bytes
- **Hash comparisons:** byte SHA (raw bytes) + content SHA (canonical JSON)
- **Missing-proof behavior:** missing artifact file throws; SHA mismatch produces blocking finding
- **Tests:** `trusted-proof.spec.ts`

### SourceDocument proof
- **Files:** `trusted-proof/source-document-proof-resolver.ts`
- **Source fields used:** `sourceDocument.findFirst` by exact ID, `sha256` column
- **Hash comparisons:** stored SHA vs actual PDF bytes (sha256Bytes)
- **Missing-proof behavior:** row missing → `source_document_not_found` blocking finding
- **Tests:** `trusted-proof.spec.ts`

### Archive proof
- **Files:** `trusted-proof/archive-proof-resolver.ts`
- **Source fields used:** bucket, key, versionId, object bytes/checksum
- **Hash comparisons:** object SHA vs SourceDocument SHA
- **Missing-proof behavior:** missing VersionId → `archive_version_missing` finding; SHA mismatch → blocking
- **Tests:** `trusted-proof.spec.ts`

### Parser-run proof
- **Files:** `trusted-proof/parser-run-proof-resolver.ts`
- **Source fields used:** input source SHA, parser version, config SHA, output artifact SHA
- **Hash comparisons:** input SHA vs source PDF SHA; output SHA vs artifact SHA
- **Missing-proof behavior:** missing parse job → `parse_job_missing`; method mismatch → blocking
- **Tests:** `trusted-proof.spec.ts`

### Reference artifact proof
- **Files:** `trusted-proof/composite-proof-resolver.ts`
- **Source fields used:** independent SourceDocument lookup per reference artifact
- **Hash comparisons:** each reference has its own artifact SHA, content SHA, source SHA
- **Missing-proof behavior:** reference reusing candidate proof → `reference_artifact_proof_failed` blocking
- **Tests:** `trusted-proof.spec.ts`, `comparison.spec.ts`

## 4. Policy matrix

| Family | Exhibit | Required Categories | Evidence Granularity | Comparisons | Review Triggers |
|--------|---------|--------------------|--------------------|-------------|-----------------|
| rdte | R-1 | identity, funding | cell_bbox | cross_document_summary_detail | manual, ocr, congressional, enacted |
| rdte | R-2 | identity, funding | cell_bbox | cross_document_summary_detail | manual, ocr, congressional, enacted |
| rdte | R-2A | identity, funding, projects | cell_bbox | project_rollup | manual, ocr |
| rdte | R-3 | identity, funding, performers | cell_bbox | none | manual, ocr |
| committee | committee_report | identity, funding | cell_bbox | committee_request_reference | congressional |
| procurement | P-1 | identity, funding, quantities, unit_cost | cell_bbox | procurement_rollup | manual, ocr |
| om | O-1 | identity, funding | cell_bbox | none | unsupported → NEEDS_REVIEW |
| milcon | C-1 | identity, funding, milcon_projects | cell_bbox | none | unsupported → NEEDS_REVIEW |

## 5. Verification rules

| Check code | Rule version | Required | Blocking | Test coverage |
|-----------|-------------|----------|----------|---------------|
| contract_integrity | v1 | yes | yes | `verification-contract-v1.spec.ts` |
| manifest_binding | v1 | yes | yes | `rules.spec.ts` |
| completeness | v1 | yes | yes | `rules.spec.ts` |
| evidence_binding | v1 | yes | yes | `rules.spec.ts` |
| identity_validation | v1 | yes | yes | `rules.spec.ts` |
| funding_field_ownership | v1 | yes | yes | `rules.spec.ts` |
| numeric_validation | v1 | yes | yes | `rules.spec.ts` |
| duplicate_detection | v1 | yes | yes | `rules.spec.ts` |
| rdte_summary_detail | v1 | yes | yes | `exact-arithmetic.spec.ts` |
| project_rollup | v1 | yes | yes | `exact-arithmetic.spec.ts` |
| procurement_rollup | v1 | yes | yes | `exact-arithmetic.spec.ts` |
| committee_adjustment | v1 | yes | yes | `exact-arithmetic.spec.ts` |
| cross_document_summary_detail | v1 | no | yes | `comparison.spec.ts` |
| committee_request_reference | v1 | no | no | `comparison.spec.ts` |
| historical_consistency | v1 | no | no | `comparison.spec.ts` |
| warning_policy | v1 | yes | yes | `rules.spec.ts` |

## 6. Arithmetic and comparison evidence

- **Exact decimal implementation:** `rules/arithmetic/exact-arithmetic.ts` — string-based decimal comparison, no binary floating-point
- **Tolerance formula:** `printedUnitToleranceMillions` — unit-aware tolerance for source-unit reconciliation
- **Summary/detail tests:** R-1/R-2 agreement and mismatch tested in `exact-arithmetic.spec.ts`
- **Project rollup tests:** missing child prevents pass, complete rollup passes
- **Procurement tests:** procurement rollup agreement and mismatch
- **Comparison different-SHA proof:** `comparison.spec.ts` — reference artifacts with different source SHAs independently proved

## 7. Prisma and migration

- **Models added:** `BudgetExtractionCandidateV1`, `BudgetVerificationRunV1`, `BudgetVerificationCheckV1`, `BudgetVerificationProofV1`, `BudgetVerificationDiscrepancyV1`, `BudgetReviewDecisionV1`
- **Migration path:** `20260816010000_budget_verification_v1` — additive, forward-safe, creates V1 audit tables
- **Constraints/triggers:** status CHECK, SHA format CHECK, risk_score bounds, passed/outcome consistency, ON DELETE RESTRICT on all FKs, BEFORE UPDATE triggers prevent mutation of immutable rows, review candidate/run match trigger, single terminal review trigger, blank notes CHECK
- **Generated-client status:** `prisma generate` passes; schema valid with DATABASE_URL
- **Disposable PostgreSQL results:** 29/29 rehearsal checks passed on PostgreSQL 16 (pgvector/pgvector:pg16)

## 8. Transaction and idempotency evidence

- **Full transaction:** candidate + run + check + proof + discrepancy inserted atomically — PASS
- **Idempotent replay:** duplicate candidate identity rejected by unique constraint — PASS
- **Immutability:** UPDATE on run/check/proof/review rejected by BEFORE UPDATE triggers — PASS
- **DELETE on run with children:** rejected by ON DELETE RESTRICT FK — PASS
- **Risk score bounds:** risk_score > 100 rejected — PASS
- **Invalid status/outcome:** rejected by CHECK constraints — PASS
- **SHA format:** invalid SHA rejected by CHECK constraint — PASS

## 9. Review workflow

- **Eligibility:** only NEEDS_REVIEW candidates eligible; VERIFICATION_PASSED rejected
- **Non-waivable findings:** source SHA mismatch, artifact byte/content mismatch, manifest mismatch, parser lineage corruption, duplicate money, ownership violation, invalid identity, blocking omission, failed arithmetic, blocking comparison, reference proof failure
- **Segregation:** reviewer identity different from extractor/operator for manual/OCR/congressional/enacted/high-materiality; limitation finding when actor unavailable
- **Concurrency:** single terminal review enforced by trigger; second accept/reject rejected
- **Append-only:** review UPDATE rejected by trigger; evidence_jsonb required
- **Hash binding:** review hashes must match candidate hashes (source_sha256, extraction_artifact_sha256, manifest_content_sha256)
- **Blank notes:** rejected by CHECK constraint

## 10. CLI results

- **verify:defense-budget-artifact-v1:** inspect mode (default, no writes), `--persist-audit` explicit, exit 0/2/3/4
- **review:defense-budget-verification-v1:** dry run (default), `--commit` required, notes by file
- **report:defense-budget-verification-cycle-v1:** read-only per-document statuses
- **Tests:** `cli-commands.spec.ts` — argument parsing, exit codes, read-only default, no unknown arguments

## 11. Validation results

| Command | Result |
|---------|--------|
| `prettier --check` (verification tree + scripts + tsconfig + docs) | PASS |
| `tsc -p tsconfig.budget-verification-v1.json --noEmit` | PASS |
| `verify:pe-budget-phase-1` | 32 suites, 673 tests passed |
| `verify:pe-budget-phase-2` | 32 suites, 659 tests passed |
| `prisma:generate` | PASS |
| `prisma validate` (with DATABASE_URL) | PASS |
| `verify:pe-phase-a` | PASS |
| `verify:pe-phase-b` | 7 suites, 113 tests passed |
| `verify:pe-phase-d` | 7 failures (pre-existing on base SHA, not introduced) |
| `verify:pe-phase-e` | PASS |
| `git diff --check` | PASS |
| `git status --short` | clean |

## 12. Negative-control evidence

| # | Control | Defect injected | Expected failure | Green path |
|---|---------|----------------|-----------------|------------|
| 1 | Caller proof injection | archiveProof/parseProof/approvedSha256 in request | Zod strict parse rejects | Clean request accepted |
| 2 | Source SHA mismatch | source_sha_mismatch finding | REJECT decision | PASS decision |
| 3 | Artifact hash tamper | artifact_content/byte_sha_mismatch finding | REJECT decision | PASS decision |
| 4 | Manifest binding bypass | promotionReady in result | Zod strict parse rejects | Clean result accepted |
| 5 | Required omission ignored | NOT_RUN required check | Decision not PASS | All checks pass → PASS |
| 6 | Page-only money auto-pass | FAIL evidence_granularity | REJECT decision | PASS with reconciliation |
| 7 | Same-SHA comparison | reference_artifact_proof_failed | REJECT decision | PASS with independent proof |
| 8 | NaN/infinite tolerance | FAIL numeric_validation | REJECT decision | PASS with valid decimals |
| 9 | Missing child skipped | FAIL project_rollup_missing_child | REJECT decision | PASS with complete rollup |
| 10 | Required NOT_RUN → PASS | NOT_RUN cross_document_summary_detail | Decision not PASS | PASS when comparison runs |
| 11 | Risk overrides blocking | blocking FAIL with low risk | REJECT (blockingFailCount > 0) | PASS with no blocking |
| 12 | Partial persistence | throw after candidate | Error propagated (not swallowed) | Correct IDs returned |
| 13 | Mismatched candidate/run review | run belongs to different candidate | Review service rejects | (N/A — green is correct rejection) |
| 14 | Blocking review waiver | blocking FAIL check + accept | Review service rejects | Non-blocking check accepted |
| 15 | Canonical writer import | scan V1 production files | No ProgramElementWriterService/CANONICAL/PROMOTED found | (N/A — gate is always green) |
| 16 | Orphan typecheck config | check package.json typecheck | tsconfig.budget-verification-v1.json wired in | All 4 wiring checks pass |

## 13. Artifact smoke results

| Artifact | Decision | Risk | Route | Blocking findings | Review findings | Proof mode |
|----------|----------|------|-------|-------------------|-----------------|------------|
| R-1 | REJECT | 100 | none | manifest_binding, completeness | none | filesystem |
| R-2 | REJECT | 100 | none | manifest_binding, completeness, evidence | none | filesystem |
| R-3 | REJECT | 100 | none | manifest_binding, completeness | performer parent unknown | filesystem |
| Committee | REJECT | 100 | none | manifest_binding, completeness, evidence | committee request missing | filesystem |
| P-doc | REJECT | 100 | none | manifest_binding, completeness, evidence | none | filesystem |

All artifacts produce deterministic decisions in inspect mode. REJECT decisions are expected because the minimal test artifacts do not have full manifest binding (document key mismatch). The verifier correctly identifies these as blocking failures.

## 14. Remaining limitations

- Parser routing not implemented (no LlamaParse, Camelot, Docling, PaddleOCR invocation)
- Canonical promotion not implemented (no ProgramElementWriterService import or canonical table writes)
- Ingestion loaders not integrated (no scheduler, EventBridge, or API controller consumes Phase 2)
- Review UI/API not implemented (no HTTP review endpoint, no tenant-facing routes)
- Unsupported family policies (O&M, MILCON) return honest NEEDS_REVIEW
- No ECS/container entrypoint added (local/operator commands only)
- Pre-existing Phase D failures (7 tests in program-element-writer.service.spec.ts) exist on base SHA — not introduced by Phase 2
- Pre-existing typecheck errors in meri/workspace-assistant modules (missing @capiro/meriv2-core) — not introduced by Phase 2

## 15. Safety confirmation

- No merge performed
- No deployment performed
- No shared migration applied
- No AWS infrastructure change
- No LlamaParse call
- No paid parser call
- No canonical Program Element write
- No production data backfill
