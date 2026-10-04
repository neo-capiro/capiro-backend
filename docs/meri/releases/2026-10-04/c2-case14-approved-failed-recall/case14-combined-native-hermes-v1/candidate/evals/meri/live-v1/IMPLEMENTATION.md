# Meri C2 Case14 combined native spend row

Candidate copies: `lib/windows-capture-spend.py` and `tests/capture-spend-fresh.unit.py`. The evidence originals are unchanged. No JS, repository files, live ledger, or live authorization were modified. Tests were not executed per the file-tools-only restriction.

## Native API contract

`fresh_reserve` takes exactly `kind`, `caseId`, `captureRunId`, `reservationId`, `ceilingMicros` for existing cases. For the sole prospective Case14 row, it takes those fields plus exactly `approvalCeilingMicros`, `recallCeilingMicros`, and `approvalBoundSha256`. Values are fixed at 15,000,000 / 1,000,000 / 14,000,000 micros; the bound is a lowercase 64-hex SHA-256. It can only append as sequence 25 immediately after the immutable, digest-checked exact 24-event prefix. There may be only one prospective Case14 row; total cap remains 30,000,000 and concurrent active reservation count remains one.

The native Case14 reserved journal row carries the three partition values and approval bound in addition to the existing native common fields. Non-Case14 reserved rows retain their previous exact field set. Unknown fields and malformed/wrong partition values are rejected.

`fresh_settle` for existing non-Case14 runs retains its previous exact fields and behavior. Case14 takes the usual `kind`, identifiers, `chargedCostMicros`, `ledgerSha256`, and `envelopeSha256`, plus `conservativeApprovalCostMicros`, `approvalBoundSha256`, `approvalOutcomeSha256`, and `projectionTerminalSha256`. Native usage records those fields and `captureAuthority: true`. Actual recall `chargedCostMicros` is an integer from zero through 14,000,000; approval conservative cost must be exactly 1,000,000; the approval bound must equal the reservation's value; all four proof hashes must be lowercase 64-hex SHA-256 strings. Native validates structure and binding; it does not authenticate JavaScript WeakMap capabilities. Callers must establish actual approval and projection-terminal authority before invoking settlement.

## Accounting and failure behavior

`knownSettledCostMicros` remains historical/exact actual spend plus actual settled recall spend only. `conservativeApprovalCostMicros` is a separate aggregate (zero for all existing historical and other runs). A successfully settled Case14 run retains actual recall in `chargedCostMicros` and the separate 1,000,000 approval conservative amount in `conservativeApprovalCostMicros`. `committedCostMicros` is known actual plus conservative approval plus the complete 15,000,000 ceiling for any active run; `remainingReservationMicros` is the 30,000,000 total less committed cost. The approval envelope is never refunded. Until a fully valid settlement appends, the entire active 15,000,000 hold remains committed. No uncertain close, reservation recovery, or hashless settlement is introduced. NTFS identity/checkpoint checks, exclusive handle behavior, append verification, and fail-closed handling remain in place.

## Tests

The revised unit tests use the existing test-only root rebinding and disposable journal copies, including an in-memory checkpoint descriptor refresh for the exact 24-event evidence prefix. They cover unchanged historical 20-event adoption and legacy Case01/20 accounting, fixed Case14 partition and bound, zero historical approval aggregate, actual-versus-conservative accounting, proof-field validation, malformed/over-cap/bool values, exact prefix and duplicate/premature rejection, and retention of a full active hold after invalid settlement attempts. They assert the evidence live files remain byte-identical during test teardown.

Status: NOT_RUN (file tools only; no commands or tests executed). No test pass is claimed.
