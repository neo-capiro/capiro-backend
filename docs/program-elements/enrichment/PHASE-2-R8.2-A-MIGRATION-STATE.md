# Phase 2 R8.2 Workstream A — Migration State Evidence

Status: RESOLVED — no repair required; migration is deployed and finished on the only
authorized shared environment.

## 1. Contradiction under resolution

Two prior records disagreed:

1. The merged commit history states that `20260816010000_budget_verification_v1` left
   `_prisma_migrations` in a failed state after another migration was applied.
2. The R8.1 handoff states the migration was never applied to a shared environment.

Per R8.2 Workstream A, neither is treated as established without inspecting the actual
environment. The live database was inspected read-only on 2026-08-04.

## 2. Authorized environments inspected

Only one shared environment is authorized for this engagement:

| Environment                               | Inspection method                                                                                                                                                                    | Date       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| capiro-dev (Aurora, account 967807252336) | read-only ECS one-off task (`capiro-dev-api-c1-sql-v6`, image `capiro/dev/api:c7a564fb083fc69b5074d395d7d7c32dbd3baf93`) querying `_prisma_migrations` + `information_schema.tables` | 2026-08-04 |

Task ARN: `arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/52e65a98b0654161bf8dde8a4e57ea63`
(exit code 0, read-only SQL only; a duplicate accidental task was stopped before it did work).

## 3. Observed `_prisma_migrations` state (capiro-dev)

Two rows exist for `20260816010000_budget_verification_v1`:

| Row | started_at (UTC)         | finished_at              | rolled_back_at           | applied_steps | Meaning                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------ | ------------------------ | ------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 2026-08-03T19:33:38.369Z | NULL                     | 2026-08-03T20:27:37.446Z | 0             | First attempt FAILED with database error code 42601 (syntax error at `CREATE UNIQUE INDEX budget_v1_review_one_terminal_per_candidate` — the original SQL contained a stray duplicate `ON ...` clause). The failed row was manually resolved `--rolled-back` at 20:27:37Z (logs record: "manual rollback: syntax error fixed in 5d933902, retrying"). |
| 2   | 2026-08-03T20:29:01.649Z | 2026-08-03T20:29:01.885Z | NULL                     | 1             | Corrected migration re-applied SUCCESSFULLY.                                                                                                                                                                                                                                                                                                          |

Additional observations:

- `SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL`
  → **0**. No migration is left in a failed state.
- Last five migrations by start time: all finished, none rolled back, except the
  explicitly rolled-back row above.

## 4. Observed Phase 2 object state (capiro-dev)

All six V1 audit tables exist:

```text
budget_extraction_candidate_v1
budget_verification_run_v1
budget_verification_check_v1
budget_verification_proof
budget_verification_discrepancy_v1
budget_review_decision_v1
```

(The Phase 0 scaffold tables without the `_v1` suffix also exist, as designed.)

## 5. Decision table outcome

The observed state matches the "Migration marked finished" row of the R8.2 decision
table:

- **Do not** edit `20260816010000_budget_verification_v1/migration.sql` further.
- **Do not** mark anything rolled back — the environment already carries a finished row.
- Any additional database change must be a new forward migration.

The failed-state record (row 1) and the R8.1 handoff claim ("never applied") are both
superseded by direct evidence: the migration failed once, was recovered, and the
corrected version is deployed and finished.

## 6. Fresh PostgreSQL replay proof (local, disposable)

Disposable PostgreSQL 16 container (`pgvector/pgvector:pg16`, trust auth, local only):

1. Empty database `capiro` created.
2. `prisma migrate deploy` applied the complete history: **215 migrations, all
   successfully applied**, including `20260816010000_budget_verification_v1`.
3. A second `prisma migrate deploy` reported the schema is up to date with **no
   pending migrations**.
4. Catalog probes confirmed all six V1 tables exist in the fresh database and the
   migration row is finished with no rollback.

## 7. Safety guard

`apps/api/src/defense-budget/verification/verification-migration-state-r82.spec.ts`
pins the corrected migration content so the known defect cannot silently return:

- the `budget_v1_review_one_terminal_per_candidate` index is a single well-formed
  `CREATE UNIQUE INDEX ... WHERE` statement (no stray duplicate `ON` clause — the
  exact defect that caused the 42601 failure);
- all six V1 tables are created;
- the migration touches no canonical Program Element table;
- ON DELETE RESTRICT audit-evidence FKs are present.

## 8. No shared mutation performed

Workstream A performed only read-only inspection of the shared environment and local
disposable replay. No `prisma migrate resolve`, no repair, and no shared deployment
occurred. Per the decision table, none is needed.
