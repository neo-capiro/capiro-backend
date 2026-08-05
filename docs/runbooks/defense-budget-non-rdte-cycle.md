# Defense-Budget Non-RDT&E Cycle Runbook

## Prerequisites

1. Phase 1 extraction contract is merged and green.
2. Phase 2 trusted verification is merged with proof, persistence, review, and database rehearsal gates passing.
3. Phase 3 parser router is merged and can produce replayable parser outputs.
4. Phase 4 RDT&E implementation is merged with stable cycle/report/projection conventions.

## Operator Workflow

### 1. Local/Free Preflight (Inspect-Only)

```bash
pnpm --filter @capiro/api inspect:defense-budget-non-rdte \
  --manifest <fy-manifest.json>
```

- Validates manifest and source SHA.
- Default execution is local/inspect-only and performs no paid call.
- Exit codes: 0 = complete/pass; 1 = needs review; 2 = rejected/incomplete; 3 = operational failure.

### 2. Parse Selected Family (No Canonical Writes)

```bash
pnpm --filter @capiro/api extract:defense-budget-non-rdte \
  --manifest <fy-manifest.json> --family procurement
```

- Family options: `procurement`, `om`, `milcon`.
- Vendor parsing requires Phase 3's exact authorization and maximum-page flags.
- Outputs canonical JSON with deterministic ordering.

### 3. Trusted Verification

```bash
pnpm --filter @capiro/api verify:defense-budget-non-rdte \
  --manifest <fy-manifest.json> --family procurement
```

- Runs Phase 2 trusted verifier with family-specific rules.
- OCR-derived money requires review.

### 4. Read-Only Projection Plan

```bash
pnpm --filter @capiro/api plan:defense-budget-non-rdte-projection \
  --verification-run <run-id>
```

- Produces the `non_rdte_canonical_projection_plan_v1`.
- Requires a final trusted verification result.
- Does NOT execute against Prisma or any database.

### 5. Certification

```bash
pnpm --filter @capiro/api certify:defense-budget-non-rdte \
  --manifest <fy-manifest.json>
```

- Produces cycle certification report.
- Cannot pass while any required document, identity category, or verification control is missing.
- No `--commit` or promotion option is available in Phase 5.

## Exit Codes

| Code | Meaning             |
| ---- | ------------------- |
| 0    | Complete/pass       |
| 1    | Needs review        |
| 2    | Rejected/incomplete |
| 3    | Operational failure |

## Resume/Replay

Family runs can be resumed/replayed from content-addressed artifacts. Content SHA mismatch rejects cached parser output.

## Permanent Checks (Phase 5 Gate)

The Phase 5 gate runs:

- TypeScript typecheck
- Contract tests
- Verifier tests
- Family extraction/composition/reconciliation tests
- Command tests
- No-write architecture tests
- Formatting and `git diff --check`

## Prohibited Symbols

Phase 5 paths must not import or invoke:

```
ProgramElementWriterService
upsertProgramElement
upsertProgramElementYear
assertPromotionReady
getCanonicalPromotionRecords
promotionReady
canonicalEligible
```

## Negative Controls

20 mandatory negative controls are documented in the test suite. Each control injects a defect, proves the test fails for the intended reason, reverts, and confirms green.

## Recovery

- **Corrupt cache**: Delete the cached artifact; re-run from the manifest.
- **Failed parsing**: Re-run the specific family; content-addressed artifacts allow replay without repeating valid paid/local parse work.
- **Missing required document**: The cycle will be INCOMPLETE until the document is supplied.

## Phase 5 Performs No Canonical Promotion

Phase 5 does not promote verified assertions into canonical tables. All projection plans are read-only. Canonical promotion is Phase 7 work.
