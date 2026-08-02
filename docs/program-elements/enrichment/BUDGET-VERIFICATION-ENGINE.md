# Official budget verification engine

## Purpose

This engine stages and verifies official budget-document extracts without promoting PE-year dollars. It keeps the existing LlamaParse-only money path, exact source SHA checks, immutable archive proof, and parse-job proof separate from any canonical writer.

The primary API is the pure `verifyBudgetDocument` function in:

`apps/api/src/defense-budget/verification/budget-verification.ts`

It accepts normalized cells from the existing parser/extractor layer and emits a reviewable result. It performs no database writes, no LlamaParse calls, no S3 calls, and no canonical PE-year mutations.

Parser wiring (still audit-only; no canonical promotion):

`apps/api/src/defense-budget/verification/budget-document-adapter.ts`

- `buildBudgetDocumentFromExtraction` / `buildBudgetDocumentFromMappedExtraction` map `ExtractionResult` + classification + archive/parse proof into `BudgetDocument`.
- Extractor field aliases (`hacdMark` / `sacdMark`) normalize to PE keys (`hacDMark` / `sacDMark`).
- Bounding boxes are page-level placeholders until extractor provenance carries geometry.
- Non-money / non-finite values are dropped; identity mixing (e.g. PE + procurement in one document) is left for the verifier to block.

## Flow

```text
official PDF
  -> existing LlamaParse extract-only path
  -> SourceDocument + DocumentParseJob evidence
  -> normalized BudgetDocument
  -> verifyBudgetDocument
  -> audit persistence (candidate/cells/run/checks)
  -> optional targeted re-extraction / paid page verification / human review
  -> exact-SHA approval gate
  -> future canonical writer (not implemented here)
```

## Deterministic checks

The verifier records every check with page/bounding-box evidence tied to the candidate's exact SHA:

- source SHA format
- source-page evidence identity, page, bounding box, and allowed extraction method
- immutable S3 archive bucket/key/VersionId/SHA proof
- succeeded LlamaParse `DocumentParseJob` proof with matching input SHA
- PE/line identifiers and line-kind identity
- fiscal year/field columns, column units, and cell-column agreement
- source-authority ownership (`request`/PB, `ndaaConference`, appropriations `conference`, enacted, etc.)
- finite values and explicit money units
- duplicate PE/FY/field cells
- repeated headers
- continuation-row links
- explicit subtotal/total arithmetic, normalized to USD millions
- optional cross-document and historical controls

`dollars`, `thousands`, and `millions` are normalized through `@capiro/shared/money`; original value and unit remain adjacent to the canonical USD-millions value.

## Risk routing

Default policy:

- `0..10`: `VERIFIED_AUTOMATIC`
- `11..30`: `NEEDS_REVIEW`, route `targeted_local_reextraction`
- `31..60`: `NEEDS_REVIEW`, route `paid_page_verifier`
- `61..100`: `NEEDS_REVIEW`, route `human_review`
- any failed blocking check: `REJECTED`, route `none`

No route invokes a provider automatically. The route is a recommendation for the next governed step.

Only `VERIFIED_AUTOMATIC` and `VERIFIED_REVIEWED` are canonical-eligible. Even then, `promotionReady` remains false unless the caller supplies the exact approved source SHA. `assertPromotionReady` and `getCanonicalPromotionRecords` are defensive writer boundaries; they do not write canonical data.

## Audit persistence

`apps/api/src/defense-budget/verification/budget-verification-repository.ts` contains:

- narrow repository interfaces for extraction candidate, cell, run, and check rows
- an adapter shape for a future generated Prisma client
- `persistVerificationResult`, which writes only audit records and updates candidate status

The migration is:

`apps/api/prisma/migrations/20260802050000_budget_verification_audit/migration.sql`

It creates the handoff tables:

- `budget_extraction_candidate`
- `budget_extraction_cell`
- `budget_verification_run`
- `budget_verification_check`
- `budget_verification_discrepancy`
- `budget_review_decision`
- `budget_golden_example`

The migration is additive and has no `ProgramElementYear` mutation. The Prisma adapter is intentionally narrow until the generated Prisma schema/client contract is approved.

## Verification commands

From the isolated worktree:

```bash
pnpm exec prettier --check apps/api/src/defense-budget/verification apps/api/tsconfig.verification.json
pnpm exec tsc -p apps/api/tsconfig.verification.json --noEmit
pnpm --dir apps/api exec jest --runInBand --forceExit src/defense-budget/verification src/defense-budget/assertion-mapper.spec.ts scripts/lib/defense-budget-commit.spec.ts
```

The verification-engine suite includes migration-contract checks and repository/service boundary tests. The broader selected PE regression set must remain green before merge.

## Safety boundaries

- Do not run `--commit` or promote any PE-year dollar from this engine by itself.
- Do not use `pdfplumber` or a second primary PDF money parser.
- Do not infer a winner from duplicate cells.
- Do not convert units based on magnitude alone; use explicit source units.
- Do not merge authorization and appropriations tracks.
- Do not treat extraction status as review or canonical status.
- Keep the occupied `C:\Users\neoma\Downloads\capiro-p11` worktree untouched; this implementation belongs in the isolated `capiro-pe-budget-verification` worktree/branch.
