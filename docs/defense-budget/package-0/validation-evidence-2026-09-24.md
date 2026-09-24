# Package 0 validation evidence — 2026-09-24

This record separates repository checks from live-environment proof. No skipped test is counted as a pass.

## Repository and disposable-infrastructure checks

| Check | Result | Evidence |
| --- | --- | --- |
| Initial combined Package C, Package E, observation bridge and Package 0 snapshot suites | PASS | 12 suites passed, 1 database-gated suite skipped; 148 tests passed, 14 skipped. |
| Exact post-rebase merge candidate focused regression | PASS | 12 suites and 133 tests passed with no skipped suite. |
| Package C disposable PostgreSQL 16 pre-migration upgrade | PASS | A real legacy scoped review and correction were migrated; 4 of 4 upgrade checks passed. |
| Package C disposable PostgreSQL replacement/reconciliation | PASS after repair | 74 of 74 tests passed. The first run found that `--acknowledge-revoked-scope` was implemented but missing from the CLI allow-list; Package 0 added the flag and the complete rehearsal then passed. |
| Prisma schema | PASS | `prisma format`, `prisma validate` and client generation completed. |
| Governed manifest TypeScript boundary | PASS | The manifest-specific TypeScript project compiled without emission. |
| Package E local Postgres/MinIO qualification | Not counted | The rehearsal stopped before mutation because workstation port 5432 was already allocated. Exact-image qualification is performed in the isolated AWS Fargate qualification task instead. |

## Live read-only checks before release

- AWS account `967807252336`, region `us-east-1`; `capiro-dev` is the only cluster with the defense-budget archive, extraction-artifact and drain topology.
- A diagnostic ECS task queried PostgreSQL inside `BEGIN READ ONLY` and exited zero: `arn:aws:ecs:us-east-1:967807252336:task/capiro-dev/5055a48296364d78bba241ac9e431a2d`.
- The complete aggregate result is stored in `approved-data-snapshot-2026-09-24.json`; it contains no source bytes, reviewer rationale or other row-level payloads.
- The pre-release snapshot found 43 active scoped approvals, zero canonical snapshots, zero governed manifests, nine pending outbox rows and four dead-letter rows. These are preserved baselines, not completion claims.

## Release checks still required by this packet

Before Package 0 is marked complete, release evidence must record the merged Git SHA, pushed ECR digests, migration task, stable API task definition, isolated exact-image qualification result, parked drain task definition and post-deploy read-only snapshot.
