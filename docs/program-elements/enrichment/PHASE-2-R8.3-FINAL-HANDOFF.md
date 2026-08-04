# Phase 2 R8.3 — Final Verification Acceptance Handoff

## Delivery status

**Status:** merge-ready implementation; no deployment performed.

**Repository:** `neo-capiro/capirov2`

**Branch:** `agent/pe-budget-verification-r8-3-final-acceptance`

**Base:** `0cc05569aabd8d9ebddeb0b58b0d15bb8d75002c`

This branch closes the remaining Phase 2 correctness defects without adding
canonical promotion, ingestion activation, scheduler wiring, paid parser calls,
or shared-database mutations.

GitHub Actions were intentionally not used, per owner instruction. The GitHub
connector used for implementation does not provide a repository runtime, so the
branch includes executable regression and acceptance tests but this handoff does
not claim that those commands were executed in this session.

## Corrections delivered

### 1. Exact parser-output declaration binding

- Added `DeclaredParserOutputProofSource` as a central production trust wrapper.
- Independently loaded parser output must expose a canonical content SHA.
- That SHA must equal the parser run's declared `outputArtifactSha256`.
- Local parser proof optionally performs the same binding inside the adapter.
- LlamaParse proof requires persisted `normalizedResultSha256` and
  `outputByteSha256` metadata in strict production mode.
- Actual persisted LlamaParse bytes are hashed and compared with the recorded
  byte SHA.
- The central wrapper also protects custom/injected parser proof sources.

### 2. Authority-aware policy selection

- Added `lookupPolicyForManifestDocument`.
- HASC, SASC, HAC-D, SAC-D, NDAA conference, appropriations conference, and
  public-law policies are selected using manifest authority.
- Family/exhibit matches that remain ambiguous fail closed.
- HASC and SASC no longer inherit each other's required funding fields.

### 3. Executable page-only reconciliation

- `page_only_reconciliation` is now a real verification check.
- Full exact corroboration produces required `PASS`.
- Partial or unavailable coverage produces required `NOT_RUN`.
- A failed covering comparison produces blocking `FAIL`.
- Successful reconciliation finalizes the provisional money-evidence check as
  `PASS`, eliminating the former false-review outcome.
- Only the exact assertion IDs included in a passing comparison are cleared.

### 4. Required arithmetic comparison coverage

- R-1/R-2 comparison is now bidirectional.
- R-2 candidates can no longer receive a required `SKIPPED` outcome.
- Missing, partial, ambiguous, and mismatched R-1/R-2 coverage cannot pass.
- Passing checks retain exact candidate assertion and evidence IDs.
- R-2A project rollups now retain exact parent/child assertion coverage.
- Missing parent totals, duplicate parents, partial groups, and mismatches fail
  or remain required `NOT_RUN` truthfully.

### 5. Removed nonfunctional `attemptId`

- Removed `attemptId` from the strict public verification request.
- Exact immutable identity has one deterministic verification run.
- Corrections require a changed source, manifest, artifact, policy, or verifier
  identity.
- Exact replay continues to return the existing persisted result without new
  audit evidence.

### 6. Exact-manifest cycle reporting

- The report hashes the exact supplied manifest bytes.
- Candidate queries bind to cycle ID, manifest SHA, and document key.
- Candidate selection is deterministic by status, current-run presence,
  update time, and ID.
- Multiple exact candidates produce an explicit selection warning.
- Output includes candidate ID, run ID, candidate count, policy SHA, verifier
  version, and exact manifest SHA.
- Unresolved comparison counts exclude unrelated required checks.

### 7. Corroboration-aware review triggers

- Congressional and enacted values force review only when uncorroborated.
- A passing independent-reference check must explicitly contain the assertion
  ID before the review trigger is cleared.

### 8. Production parser-store posture

- Production proof no longer defaults to a process-relative parser artifact
  directory.
- A shared persistent root must be explicitly supplied through
  `BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT` or wiring options.
- Without a configured local source, local parser proof fails closed.
- LlamaParse output remains object-store based.

## Tests added or replaced

- `authority-policy-resolution.spec.ts`
- `verification-request-r83.spec.ts`
- `parser-output-declaration-binding.spec.ts`
- `rdte-summary-detail-r83.spec.ts`
- updated `page-only-reconciliation.spec.ts`
- `verification-cycle-report-r83.spec.ts`
- `final-acceptance-r83.spec.ts`
- `cli-process.spec.ts`

The placeholder `services/cli-commands.spec.ts` file was removed. Its no-op
assertions were replaced with actual TSX child-process refusal tests.

## Exact acceptance outcomes encoded

The test suite now asserts exact outcomes rather than accepting any result:

- clean required controls → `PASS` / `VERIFICATION_PASSED`;
- unresolved required reconciliation → `REVIEW` / `NEEDS_REVIEW`;
- blocking parser-output corruption → `REJECT` / `REJECTED`.

## Safety confirmation

The branch:

- adds no Prisma migration;
- applies no shared migration;
- performs no AWS action;
- performs no LlamaParse or paid parser call;
- changes no canonical Program Element writer;
- adds no canonical promotion token or eligibility property;
- adds no scheduler, ingestion activation, or public controller;
- leaves deployment entirely out of scope.

## Recommended local validation

GitHub Actions are intentionally excluded. Before or immediately after merge,
the normal local validation command set is:

```bash
pnpm exec prettier --check \
  apps/api/src/defense-budget/verification \
  apps/api/scripts/report-defense-budget-verification-cycle-v1.ts \
  docs/program-elements/enrichment/BUDGET-VERIFICATION-GATE-V1.md \
  docs/program-elements/enrichment/PHASE-2-R8.3-FINAL-HANDOFF.md

pnpm exec tsc -p apps/api/tsconfig.budget-verification-v1.json --noEmit
pnpm --filter @capiro/api verify:pe-budget-phase-1
pnpm --filter @capiro/api verify:pe-budget-phase-2
pnpm --filter @capiro/api verify:pe-budget-phase-3
pnpm --filter @capiro/api verify:pe-budget-phase-4
pnpm --dir apps/api exec prisma validate
```

## Merge posture

The implementation branch is ready for owner review and merge. Use squash merge
if a compact main-branch history is preferred; the branch intentionally contains
small bounded commits produced through the GitHub contents API.
