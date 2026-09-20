# Package E local validation evidence

Recorded 2026-09-20T10:51:00-04:00 from
`codex/package-e-batch-ingestion`, based on
`91b7a56ea1149f995bcebdb542fc1db54499adf2`.

This is source-tree and disposable-infrastructure evidence. It is not
qualification of a container image and it records no AWS deployment or
production ingestion.

## Environment

| Dependency | Identity |
| --- | --- |
| PostgreSQL container | `26319192191b9df628a520bb0b31fd0062438a546509b73ba0dba3efac05d5d6` |
| PostgreSQL image | `sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b` |
| PostgreSQL version | 16.15 |
| MinIO container | `90bf40811bd03cf6b6ca6296df04218ca6921c6bd6b3125b9b6dfaceeadc54f3` |
| MinIO image | `sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e` |
| MinIO version | `RELEASE.2025-09-07T16-13-09Z` |
| Node / pnpm / Python | `v24.19.0` / `9.12.0` / `3.11.15` |
| Disposable database | `ingestion_manifest_test_pkg_e_v3` |

Credentials and database URLs are intentionally omitted.

## Results

| Command or gate | Result |
| --- | --- |
| `pnpm install --offline --frozen-lockfile` | PASS |
| `pnpm --dir apps/api run typecheck:defense-budget-ingestion-manifest-v1` | PASS |
| `pnpm --dir apps/defense-api run typecheck` | PASS |
| `pnpm --filter @capiro/api run build` | PASS |
| `pnpm --dir apps/api exec prisma validate --schema prisma/schema.prisma` | PASS |
| Complete affected unit/regression Jest run | PASS, 101/101 tests across 9 suites |
| Fresh database migration replay on rebased `origin/main` | PASS, all 412 migrations applied |
| Migration timestamp guard against `origin/main` | PASS |
| Real PostgreSQL Package E matrix | PASS, 14/14 tests; suite 90.851 seconds, invocation 91.112 seconds |
| Real versioned-MinIO/archive → Package E controller → bridge → Python parser → fenced PostgreSQL finalization | PASS, selected test body 43.630 seconds; invocation 90.687 seconds |
| API/runtime-source mirrored bridge, parser, archive-read, and legacy-claim files | PASS, all seven SHA-256 pairs matched |
| `git diff --check` | PASS; only Git's existing LF-to-CRLF working-copy warnings were emitted |

## Real PostgreSQL scenarios

The 14-test run demonstrated exact selection, due-time enforcement, one-owner concurrency, overlap
conflict, repository heartbeat, controller heartbeat beyond the test lease,
atomic item/outbox lease rollback, post-deadline persistence refusal,
candidate-before-ack adoption, stale-owner fencing, uncertainty and exact
reconciliation, preservation of an initially failed row across retry,
stop-new-work, candidate/approval/correction drift refusal, source/outbox drift
refusal, and legacy-claim exclusion.

## Real parser-path assertions

The source-backed test used the repository's existing FY2024 Army R-2 Volume 1
BA1 official fixture and an immutable versioned MinIO object. It prohibited
mutable HTTP fetch and raw-archive registration, required an exact candidate/run
correlation, finalized only through the manifest lease, and asserted:

- one terminal selected item with a persisted candidate and verification run;
- explicit `not_requested_manifest_ingestion_only` outbox metadata;
- no change to scoped approvals, candidate corrections, or promotion audit;
- no new source document, observation, or outbox row.

## Cleanup

The exact PostgreSQL and MinIO containers above were removed after the final
test/review pass. Their disposable databases and object store were removed with
them and are not recoverable. No shared or production resource was modified.
