# PE budget — Phase 7 session 11 handoff

**Goal for the session:** implement the decisions Neo made on 2026-08-08 in
response to session 10's escalations — the Phase 6 projection-plan shape (A),
Gap 1's three remaining stages (B), and SLO/canary/deployment scope (C) — and
update the docs so none of it is listed as an open architecture question again.

**Outcome:** all of A, B, and C implemented. **Every architecture gap this
programme ever escalated is now closed**, including Gap 1, which had carried a
"partially closed" qualifier since session 9. The DB rehearsal went 117 → 124
checks. Nothing was deployed; no AWS mutation, no shared-database migration, no
live canary.

The status line for this work, per Neo's own instruction:

```text
IMPLEMENTATION COMPLETE
LIVE ACCEPTANCE NOT RUN — AUTHORIZATION REQUIRED
```

Read [PHASE-7-ARCHITECTURE-GAPS.md](../defense-budget/PHASE-7-ARCHITECTURE-GAPS.md)
alongside this. It carries all of Neo's decisions **verbatim** and is the
authority; this handoff summarizes.

---

## State

|                    |                                                          |
| ------------------ | -------------------------------------------------------- |
| `origin/main`      | `1f97650d` (PR #844)                                     |
| Branch             | `agent/pe-budget-phase7-eligibility-read-repo` (PR #848) |
| Deployed           | nothing                                                  |
| Migrations applied | none outside disposable rehearsal containers             |
| Gaps 1–5           | **all closed**                                           |

## What shipped

### A — the Phase 6 projection plan

| File                                                        | Role                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `phase6/phase6-projection-plan-builder-v1.ts`               | pure, Prisma-free. One audit-projection row = one candidate; A2/A3 mapping; dedup policy |
| `scripts/build-defense-budget-phase6-projection-plan-v1.ts` | the I/O half — read-only, no `--commit`, chains into the generic persist verb            |
| 4 new exclusion reasons                                     | `unresolved_binding`, `binding_conflict`, `unsupported_projection`, `phase6_projection_blocked` |

`committee` can now file a real, non-empty projection plan — the thing session
10 had to leave open.

### B — Gap 1's remaining stages

| Decision | Function added to `phase6-projection-builder-v1.ts`                          |
| -------- | ---------------------------------------------------------------------------- |
| B1       | `buildEnactedStagePositionProjectionV1` — threads the existing proof through |
| B2       | `buildExecutionStagePositionProjectionV1` — threads existing metric/as-of    |
| B3       | `phase6-action-scope-identity-v1.ts` + wired into `buildStageActionProjectionV1` |

B3 was the one genuine semantic addition: a discriminated
PACKAGE / ACCOUNT / TRANSFER_PAIR identity, direction-sensitive by construction.

### C — SLOs and canary

- `promotion/slo-metrics-v1.ts` — 9 metrics declared, **2 wired and emitting**,
  7 specified-not-wired and recorded as such in `SLO_METRIC_WIRING_STATUS_V1`.
  Every emission carries `THRESHOLD_PENDING_ROLLOUT_BASELINE`, never a number.
- `promotion/canary-controls-v1.ts` — the rollback kill switch
  (`PE_SNAPSHOT_CANARY_ROLLBACK`, default `off`) and `CanaryMismatchAggregatorV1`.
  Most canary machinery already existed from Workstream M and was deliberately
  not duplicated.

## Verification

| Gate                                              | Result                       |
| ------------------------------------------------- | ---------------------------- |
| `tsc -p tsconfig.phase6.json` / `.phase7.json`    | clean                        |
| `pe-budget-phase7-migration-rehearsal.sh`         | **124 checks, exit 0**       |
| Phase 7 negative controls                         | 32/32                        |
| Phase 6 negative controls                         | 24/24                        |
| Phase 6 safety scan                               | PASS                         |
| Base `tsc --noEmit`                               | 6 errors — the known pre-existing baseline, unchanged |

## Things worth not rediscovering

- **`phase6_verified_binding_check`** (in the phase6-projection migration)
  refuses a `stage_position` with `projection_status = 'verified'` and any
  `binding_status` other than `'accepted'`. It is the DB twin of
  `phase6NativeProjectionV1Schema`'s superRefine. A fixture with
  verified+unresolved is invalid data, not a constraint to route around.
- **`phase6_track_stage_check`** pins each stage to its track — `sasc`/`hasc`
  are `authorization`, not `appropriations`. Easy to get wrong in a hand-written
  fixture.
- **`persist-defense-budget-projection-plan-v1` exits 3 for a BLOCKED plan and
  still files it.** That is success, not failure. The rehearsal brackets that
  call with `set +e`/`set -e` because `set -euo pipefail` would otherwise abort
  before the exit code could be inspected.
- **`worstSeverityV1` reduces mismatch *classes*, not severities.**
  `canary-controls-v1.ts` needed its own small severity reducer; reusing the
  name would have implied it was the same function.
- **Phase 5 and Phase 6 each have their own NC20**, and they are different
  controls. Phase 5's is the Prisma-DML ban on planner scripts.

## What's left

Nothing is blocked on an architecture decision any more.

| Item                                                    | Needs a human first?      |
| ------------------------------------------------------- | ------------------------- |
| Wire the remaining 7 SLO metrics to emission call sites | No — pure engineering     |
| Chain the persist verb into producing pipelines         | No                        |
| Rebuild + persist existing Phase 4/5/6 outputs          | No — needs real cycle data |
| `composeEnactedStageV1` producing real enacted candidates from extraction | No — upstream of B1 |
| Measured SLO thresholds                                 | **Yes** — production baseline |
| Live canary                                             | **Yes** — separate authorization |
| Any real deployment                                     | **Yes** — separate authorization |

## Safety statement

New source, new specs, doc edits, and rehearsal-script changes. No merge to
`main`, no deployment, no AWS mutation, no shared-database migration, no
production-data access, no canonical promotion, no snapshot activation, no
rollback, no alert fan-out, no paid-parser call, no live canary. The only
databases touched were disposable containers destroyed on exit.
