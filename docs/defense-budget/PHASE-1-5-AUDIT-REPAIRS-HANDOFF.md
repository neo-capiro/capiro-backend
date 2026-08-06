# Phase 1–5 Defense-Budget Audit Repairs — Handoff

## Status

This branch contains targeted correctness repairs discovered while auditing the merged Phase 1–5 defense-budget ingestion foundation against the phase plans and current code.

It does **not** implement Phase 6. Phase 6 remains a separate congressional, conference, enacted, reprogramming, and execution ingestion phase with its own source corpus, schema, migration, parser, verification, and negative-control requirements.

## Branch

```text
agent/pe-phase5-audit-repairs
```

Draft PR:

```text
#757
```

## Repaired defects

### Phase 1 extraction contract and legacy adapters

1. **Mixed legacy year values could silently disappear.**
   - Money, quantity, and text carried on one `YearValueAssertion` are now represented independently.
   - A review warning records the legacy mixed representation.

2. **Malformed R-1 fiscal-year keys were partially parsed.**
   - Values such as `2027junk` no longer become FY2027.
   - Fiscal-year keys must be exact four-digit years in range.

3. **Null R-1 funding cells were skipped.**
   - Null cells now produce explicit source facts and `missing_value` omissions.

4. **Committee adapter mode could relabel source authority.**
   - HASC/SASC/HAC-D/SAC-D/conference/public-law mode must match the manifest/source authority.

5. **P-doc aliases used first-non-null behavior.**
   - Conflicting request or unit-cost aliases now fail closed.
   - Source facts name the exact field that supplied the value.

6. **An unrelated duplicate warning weakened the whole artifact.**
   - Multiple-value consumption is waived only when the duplicate warning references that exact source fact.

7. **Page evidence could reference a parser run with no page ranges.**
   - Page-addressable evidence now requires a nonempty covering parser range.

8. **Milestone dates were shape-checked but not calendar-checked.**
   - Impossible ISO-shaped dates are rejected using deterministic leap-year/month arithmetic.

9. **Validator commands leaked raw file/JSON failures and ignored unknown arguments.**
   - Manifest and artifact validators now return deterministic invalid results for unreadable/malformed files.
   - Unknown, duplicate, and missing flags fail closed.

### Phase 3 → Phase 5 parser proof and composition

10. **A partial single parser result could enter Phase 5 semantics.**
    - Single-result mode requires requested pages, succeeded pages, and page payloads to match exactly with no page failures.

11. **Correct multi-parser composition had no Phase 5 semantic entrypoint.**
    - Added a strict `defense_budget_composed_output_v1` adapter.
    - Validates composition content SHA, page ledger, selected/alternative lineage, and source SHA.
    - Derives every contributing parser run and selected page range.
    - Unresolved requested pages become blocking `missing_evidence` omissions.

12. **Parser proof required artifact ranges to equal the full parser result.**
    - Artifact ranges may now be a nonempty selected subset of successful persisted-result pages.
    - Any selected page absent from the result is rejected.

13. **One parser-result file could be reused as proof for every artifact run.**
    - Artifact maps now carry one exact persisted-result descriptor per contributing run.
    - Certification and projection independently load and hash each result.
    - Missing, duplicate, extra, reused, or byte-SHA-mismatched proof descriptors fail closed.

14. **Single-result artifact construction did not require independently computed result-byte proof.**
    - Exact persisted-result byte SHA is now mandatory.

### Phase 5 certification and projection governance

15. **The proof-bound projection wrapper still exposed a caller-controlled reviewed-acceptance set.**
    - The exported proof-bound interface omits it.
    - Runtime calls attempting to inject it fail with `review_acceptance_bypass`.
    - Projection requires the exact Phase 2 `PASS` / `VERIFICATION_PASSED` result.

16. **The internal pure planner could become a parallel production entrypoint.**
    - Added an import-boundary regression guard: production callers must use the proof-bound wrapper.

17. **Operator documentation described a review bypass that the code should never support.**
    - The runbook now states that `NEEDS_REVIEW` remains non-projectable in Phase 5.
    - Governed review proof belongs to the later authenticated promotion workflow.

18. **The runbook did not describe exact multi-run proof inputs.**
    - Added complete single-result and composed-output parser-map examples.
    - Added per-run proof, unresolved-page, recovery, certification, and projection rules.

## Added regression coverage

Key new or expanded tests include:

```text
src/defense-budget/contracts/phase1-post-plan-regressions.spec.ts
src/defense-budget/contracts/validator-cli-regressions.spec.ts
src/defense-budget/contracts/adapters/pdoc-alias-regressions.spec.ts
src/defense-budget/non-rdte/non-rdte-semantic-artifact-factory-v1.spec.ts
src/defense-budget/non-rdte/non-rdte-phase3-composed-artifact-v1.spec.ts
src/defense-budget/non-rdte/non-rdte-proof-bound-artifact-v1.spec.ts
src/defense-budget/non-rdte/non-rdte-artifact-map-proof-regressions.spec.ts
src/defense-budget/non-rdte/non-rdte-review-governance.spec.ts
src/defense-budget/non-rdte/non-rdte-projection-import-boundary.spec.ts
```

Existing committee and containment tests were updated to use exact authority ownership.

## Required validation before merge

The connector-only audit environment could inspect and update GitHub but could not execute the repository. Therefore this branch must **not** be represented as test-green until the exact branch SHA passes the following in a normal checkout/build environment.

At minimum:

```bash
pnpm --filter @capiro/api verify:pe-budget-phase-1
pnpm --filter @capiro/api verify:pe-budget-phase-2
pnpm --filter @capiro/api verify:pe-budget-phase-3
pnpm --filter @capiro/api verify:pe-budget-phase-4
pnpm --filter @capiro/api verify:pe-budget-phase-5
pnpm --filter @capiro/api typecheck
pnpm --filter @capiro/api exec prisma validate
pnpm --filter @capiro/api exec prisma generate
pnpm exec prettier --check apps/api/src/defense-budget apps/api/scripts docs/defense-budget docs/runbooks
git diff --check
```

Parser runtime:

```bash
cd apps/defense-budget-parser
uv sync --frozen
uv run ruff check .
uv run ruff format --check .
uv run mypy .
uv run pytest
```

When available, run the branch-contained Phase 5 closeout, negative controls, disposable PostgreSQL rehearsal, and container checks.

## Known limits

- **Phase 6 is not implemented on this branch.** Do not describe the system as complete through congressional/enacted/post-enactment ingestion.
- No production source corpus was parsed during this audit.
- No official DoD values were re-verified.
- No GitHub Actions evidence was available from this connector session.
- The branch requires executable validation before acceptance or deployment.

## Safety confirmation

During this audit session:

```text
merge:                         no
deployment:                    no
AWS action:                    no
shared migration application: no
paid parser call:              no
canonical write:               no
production-data access:        no
```

GitHub branch commits and draft-PR updates are the only persistent changes made.
