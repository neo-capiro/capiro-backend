# Package 5 validation evidence

## Executed gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Focused API regressions | PASS | 9 suites / 60 tests covering bitemporal identity continuity, acquisition identity, portfolio projection, query-wide coverage, cursor-stable qualified reads, durable projector continuation, qualification safety, and container entrypoint dispatch. |
| Fresh-schema migration | PASS | All 425 migrations applied to disposable PostgreSQL database `package5_qualification`, including both Package 5 migrations. |
| Package 5 database qualification | PASS | Renumbered PE, split program fanout, signed negative obligation, parent vehicle with orders, multi-path award deduplication, explicit unsupported allocation, and immutable-history rejection. |
| Financial safety boundaries | PASS | Account totals remained separate from transaction deltas; unsupported relationships exposed no allocated dollars; an unknown allocation produced an open coverage gap instead of zero. |
| Projector default | PASS | With the activation flag absent, the projector reported `DRY_RUN` and wrote no records or relationships. |
| Prisma schema | PASS | `prisma validate`, client generation, and a full fresh-database migration. |
| Qualification write safety | PASS | Qualification refused writes unless both independent opt-ins were present and the parsed PostgreSQL database name was exactly `package5_qualification`; 4 focused guard tests passed. |
| Targeted TypeScript | PASS | Package 5 source, controllers, module wiring, storage, qualification, and projection paths compiled with strict settings through `tsconfig.package5.json`. |
| Full API build | PASS | Workspace dependencies, generated Prisma client, and the complete Nest API production build compiled together. |
| CDK schedule contract | PASS | 1 suite / 14 tests, including the Package 5 rule disabled by default. |
| Patch hygiene | PASS | `git diff --check`. |

The exact machine-readable result is [qualification-2026-09-24.json](./qualification-2026-09-24.json). It was produced by the executable database qualifier, not manually inferred from unit tests.

## Independent review corrections

The final Hermes review found and the release fixed four gaps before merge:

1. Query coverage is computed across all temporally visible relationship heads rather than the current page. A subject with no source evidence now reports partial `source_coverage_unknown`, never complete. Mutable gap history that cannot be reconstructed at `knownAt` reports `coverage_history_unavailable` and remains fail-closed.
2. The projector now walks deterministic, bounded source snapshots with independent SAM/award cursors, durable successful-run checkpoints, explicit `hasMore`, and startup high-water IDs. Repeated scheduled runs cannot starve rows beyond the cap.
3. Acquisition cursors carry the normalized `knownAt`. A continuation request may omit it and still reads the same bitemporal snapshot.
4. The database qualifier requires `PACKAGE5_QUALIFICATION_ALLOW_WRITES=1`, `--execute-on-disposable-package5-db`, and the exact disposable database name `package5_qualification`; connection details are never logged.

## Dark-release posture

The Package 5 schedule ships with `enabled: false`. The projector additionally requires both `--commit` and `PROGRAM_ACQUISITION_CONTINUITY_ENABLED=true`; either condition missing leaves it in dry-run. The projector reads already-ingested local SAM and federal-award rows and performs no network fetch.

Reviewed associations, inferred relevance, negative/corrected transactions, and unresolved relationships cannot publish authoritative allocated dollars. Only evidenced source-stated or deterministic financial allocations can do so. The release therefore preserves unsupported joins as visible gaps instead of inventing allocation values.

## Source control and AWS deployment

- Pull request [#1782](https://github.com/neo-capiro/capirov2/pull/1782) merged to GitHub `main` at `fd1c1c2903aad6d051e79cfb6a764255aea0ac23`; local `main` was fast-forwarded to the same commit before deployment.
- GitHub-hosted checks failed before acquiring a runner: the inspected job had an empty runner name and zero steps. This matches the repository billing/spending-limit outage and is CI infrastructure failure, not a passing signal; the executed local and AWS gates remain the release evidence.
- Native ARM64 CodeBuild `capiro-build-intel-api:a86971e7-b662-4cf7-a6f7-29142a160671` resolved the exact merge commit and succeeded. It pushed API digest `sha256:8356ac90a0ae8753f312906203fc4eeab0d3225a59b0644e3c335423380d1f8b` under the immutable SHA and Package 5 tags; the pushed manifest reports `linux/arm64`.
- Migration task `652a50cc39354d81b9cb71074b6f795f` used task definition `capiro-dev-api-migrate:133`, applied `20280924040000_program_identity_continuity` and `20280924050000_acquisition_continuity_ledger`, and exited 0 before the API service changed.
- API task definition `capiro-dev-api:447` binds the exact digest and merge identity with `PROGRAM_ACQUISITION_CONTINUITY_ENABLED=false`. ECS completed the rollout at 2026-09-24T20:50:18Z with desired/running/pending `2/2/0`; both tasks and both replacement load-balancer targets are healthy.
- Sync task definition `capiro-dev-api-sync-jobs:33` binds the same digest and dark flag. Read-only proof task `7152595ced6b4858aefe05c790532094` exited 0 in `DRY_RUN`, examined one real SAM row and one real award row, and returned bounded continuation evidence without writing.
- Live EventBridge inventory returned no Package 5 projection rule. No production acquisition relationship, coverage gap, transaction, or financial allocation was written during deployment.
