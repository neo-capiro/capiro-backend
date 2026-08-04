# Phase 2 R8.1 — Final Trusted Verification Closeout

**Date:** 2026-08-04
**Branch:** `agent/pe-budget-verification-r8-1-final-closeout`
**Base:** `origin/main` `5d933902fde429f34df64d29c8f715d3dc2bc190`
**Scope:** audit-only defense-budget verification. No production-facing action was taken.

## Delivered work

| Increment | Commit | Result |
|---|---|---|
| R8.1-A | `35092fb5` | Report result preservation and baseline cleanup; migration inspected only. |
| R8.1-B | `6eddce2c` | Structured independent reference-artifact descriptors. |
| R8.1-C | `b0af45ee` | Fail-closed authoritative source-byte and immutable/parser proof enforcement. |
| R8.1-D | `6c943d91` | Required-comparison coverage and executable-policy semantics. |
| R8.1-E | `93a512ea` | Assertion-level reconciliation for page-only monetary evidence. |
| R8.1-F | `49585070` | Deterministic replay identity, persisted-result replay, and verification concurrency handling. |
| R8.1-G | `ce071e7c` | Full review dry-run eligibility pipeline, review locking/concurrency handling, and executable CLI refusal tests. |

## Trust and review controls

- Production verification obtains and hashes authoritative source bytes; an artifact-asserted source hash cannot satisfy proof.
- Missing or invalid immutable archive proof and parser proof are blocking.
- Required comparison rules cannot pass with absent references, zero matches, or partial coverage. Optional zero-match comparisons are `NOT_RUN`.
- A passing comparison clears only the matching page-only assertion; uncovered or failed evidence remains review/blocking evidence.
- Verification replay identity uses attempt `"0"`; existing terminal persisted results are returned rather than re-run.
- Review dry-run uses the same acceptance eligibility checks as commit mode and returns before persistence.
- Review persistence locks the candidate with PostgreSQL `SELECT ... FOR UPDATE`, verifies `NEEDS_REVIEW` and no terminal decision under that lock, and conditionally updates exactly one candidate row.
- A competing terminal review is surfaced as `ReviewAlreadyCompletedError`, not as an untyped Prisma/database error.

## Validation evidence

All database work below used a fresh disposable local Docker PostgreSQL 16 (`pgvector/pgvector:pg16`) container bound to loopback. It was removed after validation. No production, staging, or development database was contacted.

| Command / check | Result |
|---|---|
| `pnpm exec tsc -p tsconfig.budget-verification-v1.json --noEmit` | PASS |
| `pnpm exec jest --runInBand --forceExit src/defense-budget/verification/services/budget-review-v1.service.spec.ts` | PASS — 55 tests before final rehearsal enhancement; later combined targeted run 57 tests PASS. |
| `pnpm exec jest --runInBand --forceExit scripts/review-defense-budget-verification-v1.spec.ts` | PASS — 2 executable child-process refusal tests. |
| `DATABASE_URL=<disposable> pnpm --filter @capiro/api verify:pe-budget-phase-2` | PASS — 36 suites, 705 tests. |
| `DATABASE_URL=<disposable> pnpm exec prisma migrate deploy` on fresh database | PASS — 215 migrations applied. |
| Same `prisma migrate deploy` immediately again | PASS — no pending migrations. |
| `DATABASE_URL=<disposable> pnpm exec prisma validate` | PASS. |
| `DATABASE_URL=<disposable> pnpm exec prisma generate` | PASS. |
| `DATABASE_URL=<disposable> pnpm exec tsx scripts/rehearse-budget-verification-v1.ts` | PASS — 32 checks, including immutability, rollback/constraint controls, and concurrent review persistence. |
| Post-rehearsal database probes | 215 applied migrations; `program_element=0`; `program_element_year=0`; exactly one terminal decision for concurrent candidate. |
| `git diff --check` | PASS. |

### Operator command refusal behavior exercised

Actual TSX CLI process results, all before database initialization:

| Command | Exit | Result |
|---|---:|---|
| Verify with unknown flag | 4 | `Unknown flag: --unexpected-flag` |
| Verify with incomplete arguments | 4 | `Missing --document` |
| Review with unknown flag | 1 | `Unknown flag: --unexpected-flag` |
| Review with incomplete arguments | 1 | `Missing --run-id` |
| Cycle report with unknown flag | 1 | `Unknown flag: --unexpected-flag` |
| Cycle report with no manifest | 1 | usage refusal |
| Rehearsal with no `DATABASE_URL` | 1 | `DATABASE_URL must be set` |

## Negative controls

The full Phase 2 suite exercised all 16 named negative-control families in `negative-controls.spec.ts`, covering caller proof injection, hash/manifest tampering, required omissions, page-only auto-pass, reference proof reuse, numeric invalidity, missing arithmetic children, required `NOT_RUN`, risk override, partial persistence, mismatched review binding, review waiver, canonical writer containment, and typecheck wiring.

## Scope and safety confirmation

- No canonical Program Element writer, service, or table was modified by this branch: the branch diff contains no files under `apps/api/src/program-element` and no `apps/api/prisma/schema.prisma` changes.
- No deployment, scheduler, backfill, ingestion wiring, promotion logic, LlamaParse/paid parser call, AWS action, or shared-database migration was performed.
- The V1 migration SQL was not amended; fresh disposable migration replay succeeded.
- Audit rows are immutable, including deletion. The rehearsal now intentionally requires a fresh disposable database rather than attempting to delete prior terminal evidence.

## Remaining boundaries

This closeout does not add canonical promotion, ingestion, scheduler wiring, a review UI/API endpoint, deployment, or parser routing. Those remain explicitly out of scope.

## Delivery status

Ready for final local validation, push, draft PR creation, and hosted CI observation. Do not merge.
