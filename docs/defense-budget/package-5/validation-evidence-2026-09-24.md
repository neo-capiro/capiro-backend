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
