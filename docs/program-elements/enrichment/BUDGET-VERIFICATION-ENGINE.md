# Budget structural-validation scaffold

> **This scaffold is superseded by the V1 trusted verification gate.**
> See [BUDGET-VERIFICATION-GATE-V1.md](./BUDGET-VERIFICATION-GATE-V1.md) for the
> trusted, audit-persisted verification gate that replaces this scaffold.
>
> The Phase 0 scaffold remains internal/deprecated and explicitly non-trusted.
> It does not prove that extracted values match the official PDF and does
> not authorize canonical Program Element writes.

It is a Phase 0 containment of the original extract-only verification scaffold. Every
public contract and persisted status is honest about what the code can currently prove.

## What it does

- validates supplied source identity fields (document id, exact SHA-256 format)
- checks candidate structure (rows, columns, identifiers, line-kind identity)
- checks units and finite numeric values against explicit source units
- enforces PE-specific ownership tracks (`request`/PB, marks, `ndaaConference` vs
  appropriations `conference`, enacted, etc.)
- detects duplicate natural-key cells, repeated headers, and broken continuation links
- records extraction omissions (dropped money assertions) and parser warnings, and
  fails closed on them
- performs explicit subtotal/total arithmetic only when parent/child relationships are
  supplied by the caller
- optionally evaluates caller-supplied cross-document and historical comparisons;
  controls that were not supplied are marked `skipped` / `NOT RUN`, never passed
- emits a routing recommendation (`automatic`, `targeted_local_reextraction`,
  `paid_page_verifier`, `human_review`, `none`)

## What it does not do

- independently retrieve or re-hash S3 source objects
- independently load `SourceDocument` or `DocumentParseJob` rows — archive and parse
  proofs are caller-supplied claims checked for internal consistency only
- prove extraction payload lineage
- retrieve comparison documents
- persist governed review approval (no authorization, no segregation of duties)
- authorize promotion of any value
- call a canonical writer

## Lifecycle vocabulary

```text
EXTRACTED → VALIDATING → STRUCTURALLY_VALIDATED
                       → NEEDS_REVIEW → REVIEW_ACCEPTED
                       → REJECTED
                       → SUPERSEDED
```

- `STRUCTURALLY_VALIDATED` means only that the supplied candidate passed the checks
  implemented in this scaffold.
- `REVIEW_ACCEPTED` means an in-memory reviewer decision accepted a candidate for later
  governed processing. It is not canonical approval. Review persistence, authorization,
  segregation of duties, and canonical promotion are not implemented.
- `CANONICAL`, `VERIFIED_AUTOMATIC`, and `VERIFIED_REVIEWED` are prohibited in this
  contract.

## Fail-closed extraction rules

- A document with no candidate row, no money cell, no accepted money assertion, or no
  normalizable record is `REJECTED`.
- Any money assertion dropped by the adapter (unsupported field, missing money,
  unsupported unit, non-finite value) is recorded in `ExtractionDiagnostics` and blocks
  structural validation.
- Any parser warning forces `NEEDS_REVIEW` and adds risk above the automatic band.
- A `REJECTED` result exposes no normalized records, so a caller cannot consume staged
  values without checking status.

## Evidence honesty

- Evidence carries `granularity: 'cell_bbox' | 'page_only'`.
- The current extractor provenance has no geometry, so the adapter emits `page_only`
  with **no** bounding box. No placeholder box is presented as cell-level evidence.
- Invalid or missing page numbers fail evidence validation; they are never coerced to
  page 1.
- Extraction method is mapped one-to-one (`llamaparse`, `deterministic_pdfplumber`,
  `manual`, `targeted_local_reextraction`, `paid_page_verifier`) and never relabeled.

## Persistence (draft only)

- `persistVerificationAuditDraft` and `structurallyValidateAndPersistAuditDraft` write
  only draft audit rows through the narrow `BudgetVerificationRepository` interface.
- No concrete production repository exists in Phase 0; a transactional Prisma
  implementation is Phase 2 work gated on approved models.
- The scaffold accepts no approval SHA and returns no promotion properties.

## Phase 0 containment boundary

The following are prohibited integration points for this scaffold:

- importing `ProgramElementWriterService` or any canonical PE-year writer
- importing the scaffold from any operational script under `apps/api/scripts/`
- exposing a verification or promotion command in `entrypoint-dispatcher.inc`
- registering the scaffold in any Nest module
- any status, property, or helper claiming canonical eligibility or promotion readiness

`verification-containment.spec.ts` enforces this boundary statically.

## Migrations

- `20260802050000_budget_verification_audit` — original additive audit tables (unchanged).
- `20260802180000_budget_verification_containment` — additive containment: refuses
  existing `CANONICAL` rows, renames `VERIFIED_AUTOMATIC`→`STRUCTURALLY_VALIDATED` and
  `VERIFIED_REVIEWED`→`REVIEW_ACCEPTED`, replaces the candidate status constraint, adds
  run status/route constraints, and updates table comments. Applied to shared
  environments only by a separate, gated operation.

## Verification commands

```bash
pnpm exec prettier --check apps/api/src/defense-budget/verification apps/api/tsconfig.verification.json
pnpm exec tsc -p apps/api/tsconfig.verification.json --noEmit
pnpm --dir apps/api exec jest --runInBand --forceExit src/defense-budget/verification src/defense-budget/assertion-mapper.spec.ts scripts/lib/defense-budget-commit.spec.ts
```

## Phase 1 contract boundary

- Phase 1 `defense_budget_extraction_v1` artifacts (see
  `BUDGET-EXTRACTION-CONTRACT-V1.md`) are the future verifier input contract.
- The Phase 0 verifier documented here remains contained and is **not** yet
  rewired to consume V1 artifacts in this phase.
- Phase 2 will consume V1 artifacts and implement trusted verification.

The Phase 0 verifier is not complete; nothing above claims otherwise.

## Remaining limitations (later phases)

- trusted source/parse proof resolver
- complete extraction contract
- family-specific completeness rules
- independent comparison retrieval
- governed review persistence
- transactional production repository
- verified canonical promotion service
- integration into annual ingestion
