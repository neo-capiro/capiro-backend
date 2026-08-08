# PE budget — Phase 7 session 10 handoff

**Goal for the session:** pick up item 1 of the session-9 handoff —
`PromotionEligibilityRepositoryV1`'s fact-computing side — which that handoff
classified as needing no human-in-the-loop: "pure engineering. A coding session
can pick this up directly."

**Outcome:** it was not pure engineering. Three of its seven reads were; the
other four were blocked, each for a specific and different reason. That finding
became **Gap 5**. Neo made the four decisions it escalated mid-session, and all
four are now implemented: `PrismaPromotionEligibilityReadRepositoryV1`
implements all seven reads, backed by two new migrations and one new
persistence substrate. Gap 5 is closed. Nothing was deployed and no migration
was applied to any real database.

The correction to carry forward: **item 1 was not pure engineering, and the
reason generalizes.** Two Phase 7 prerequisites were accepted on the presence of
a *contract* rather than of a *producer* — the same conflation Gap 1 already
recorded for Phase 6. The dependency map now says so next to the claim.

Read [PHASE-7-ARCHITECTURE-GAPS.md](../defense-budget/PHASE-7-ARCHITECTURE-GAPS.md)
alongside this. Gap 5's section carries Neo's four decisions **verbatim** and is
the authority; this handoff summarizes.

---

## State

|                    |                                                                 |
| ------------------ | ---------------------------------------------------------------- |
| `origin/main`      | `1f97650d` (PR #844)                                            |
| Branch             | `agent/pe-budget-phase7-eligibility-read-repo`                   |
| Worktree           | `C:/Users/neoma/Downloads/capiro-pe-phase7-eligibility`         |
| Deployed           | nothing                                                         |
| Migrations applied | none, anywhere, outside disposable rehearsal containers         |
| New migrations     | `20260907010000` (candidate metadata), `20260907020000` (plans) |

## The four decisions

Made by Neo on 2026-08-08, recorded verbatim in Gap 5. In one line each:

1. **Denormalize `family` and `extractionMethod`** onto
   `budget_extraction_candidate_v1` at write time. Do not make promotion
   eligibility fetch an artifact to rediscover verified metadata. Backfill
   existing rows deterministically, failing closed.
2. **Do not invent a Phase 1–5 source-profile analogue.**
   `sourceProfileHashes` may be empty; the requirement is family-aware, keyed
   off the Phase 6 source-profile policy rather than `family === 'committee'`.
   Absence is valid where no profile artifact exists; fabrication never is.
3. **Persist projection plans** immutably at the Phase 4/5/6 producer boundary,
   in one substrate. Phase 7 reloads and verifies, never recomputes.
4. **Promotion conflicts come from the persisted plan** — not the legacy
   reconciliation queue, not verification discrepancies.

## What shipped

| Decision | Files                                                                                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | migration `20260907010000`; `verification/candidate-source-metadata-v1.ts`; `verification/candidate-source-metadata-backfill-v1.ts`; `scripts/backfill-budget-candidate-source-metadata-v1.ts`; write-path wiring in `prisma-budget-verification.repository.ts` + `budget-verification-v1.service.ts` |
| 2        | `stages/stage-source-profile-coverage-v1.ts`; `promotion-eligibility-v1.ts` (candidate binding gains `family` + `sourceProfileSha256`, record-level set may be empty, both-direction cross-check); `source_profile_missing` block reason; schema version → `_v2` |
| 3        | migration `20260907020000`; `projection-plan/projection-plan-record-v1.ts`; `projection-plan/projection-plan-repository-prisma-v1.ts`; `scripts/persist-defense-budget-projection-plan-v1.ts` |
| 4        | `summarizeProjectionPlanV1` + `PROJECTION_EXCLUSION_BLOCKS_PROMOTION_V1`, consumed by both counters in the read repository                                                             |

`PrismaPromotionEligibilityReadRepositoryV1` now implements **all seven reads**.

## Verification run

| Gate                                                             | Result                                         |
| ---------------------------------------------------------------- | ---------------------------------------------- |
| `tsc -p tsconfig.phase7.json --noEmit`                           | clean                                          |
| `tsc -p tsconfig.budget-verification-v1.json --noEmit`           | clean                                          |
| `prisma validate`                                                | valid (needs a placeholder `DATABASE_URL`)     |
| `jest src/defense-budget src/program-element/snapshot`           | 204 suites / 2845 tests pass                   |
| `verify-pe-budget-phase-7-negative-controls.ts`                  | 32/32 controls passed                          |
| `verify-pe-budget-phase-7-safety.ts`                             | passed                                         |

No database was involved. Everything is unit-tested against fakes.

## Things worth not rediscovering

- **The backfill compares *content* SHA, not byte SHA.**
  `extraction_artifact_sha256` holds `resolution.extractionArtifactContentSha256`
  — a canonical-JSON hash computed with `artifactId` and `contentSha256`
  removed — so the obvious `sha256Bytes(bytes)` check fails for every
  legitimate artifact. The chain is: bytes → parse → recompute content SHA →
  compare, plus the artifact's own self-declared hash.
- **A composed artifact resolves to its riskiest parser method.** One artifact
  can carry several parser runs; the contract names one method. Picking the
  riskiest can only make the authorizer-equals-extractor control stricter. A
  test pins the precedence list's first three entries to
  `HIGH_RISK_EXTRACTION_METHOD_V1_VALUES`.
- **A hardcoded schema-version literal in the service** made the `_v2` bump
  surface as `projection_hash_mismatch` — a projection-plan refusal for a
  version problem. It now uses the exported constant. Worth checking for the
  same pattern elsewhere before any future contract bump.
- **`verification-containment.spec.ts` holds a frozen allowlist** of scripts
  permitted to import the verification module. A new operator script fails that
  gate until it is listed — which is the gate working, not a broken test.
- **`family: 'unknown'` is refused, not stored**, and NULL metadata is a
  refusal at the promotion boundary rather than a wildcard.

## What's left

Items 2–5 from session 9 are unchanged and still Neo's. Item 1 is now closed
except for producer wiring, which needs no further decision:

| #   | Item                                                        | Needs a human first?      |
| --- | ----------------------------------------------------------- | ------------------------- |
| 1a  | Wire the three producers to persist their plans             | **No** — pure engineering |
| 1b  | Rebuild + persist existing Phase 4/5/6 outputs              | **No** — per decision 3   |
| 1c  | Extend the DB rehearsal to the two new migrations           | **No**                    |
| 2   | Gap 1's remaining stages (enacted, reprogramming/execution) | Yes, then engineering     |
| 3   | Production-scale rehearsal thresholds                       | Yes — measured SLOs       |
| 4   | Canary acceptance                                           | Yes, mandatory            |
| 5   | Any actual deployment, including `capiro-dev`               | Yes                       |

**1a in detail:** `persist-defense-budget-projection-plan-v1` exists, is
typechecked, and files any of the three plan shapes, but `build-rdte-cycle`,
`plan-defense-budget-non-rdte-projection`, and the Phase 6 cycle commands still
print a plan and exit. Until they call it, filing a plan is a separate operator
step — the same shape Gap 4 closed for promotion plans, and it should probably
close the same way.

**1c in detail:** `pe-budget-phase7-migration-rehearsal.sh` has not been
extended to cover `defense_budget_projection_plan` or the new candidate
columns. The append-only trigger, the status/count CHECK, and the storage-mode
CHECK on the new table have never run against a real Postgres. Both migrations
are additive, but "additive" has not been *demonstrated* here the way session
9 demonstrated it for the eligibility table.

## Environment notes

A fresh worktree needs four manual build steps before any Phase 7 gate runs,
and each failure looks like a code defect rather than a missing build:

1. `pnpm install` (`--ignore-scripts` skips the Prisma postinstall).
2. `npx prisma generate` in `apps/api`, or every `@prisma/client` import
   reports `has no exported member 'PrismaClient'`. **Re-run after every schema
   edit** — a stale client makes new columns look like TypeScript errors.
3. `npx tsc -p tsconfig.json` in **each** of `packages/{shared,meriv2-core,auth,strategy-verifier}`,
   or `tsconfig.phase7.json` reports `Cannot find module '@capiro/shared'` plus
   hundreds of cascading implicit-`any` errors.
4. `prisma validate` needs `DATABASE_URL` set to anything
   (`postgresql://placeholder:placeholder@localhost:5432/placeholder`); it
   never connects.

`tsconfig.phase7.json` includes `src/defense-budget/promotion/**/*.ts` and now
`src/defense-budget/projection-plan/**/*.ts` as globs, so new source files
there need no config change — a new *script* must be listed explicitly.

Carried forward and still true: the local `main` ref in these worktrees is
stale, so compare against `origin/main`; `git push` needs
`git -c credential.helper='!gh auth git-credential' push`.

## Safety statement

Read-only inspection plus new source, new specs, two additive migrations, and
doc edits. No merge, no push, no deployment, no AWS mutation, no shared-database
migration, no production-data access, no canonical promotion, no snapshot
activation, no rollback, no alert fan-out, no paid-parser call. No database of
any kind was connected to, disposable or otherwise.
