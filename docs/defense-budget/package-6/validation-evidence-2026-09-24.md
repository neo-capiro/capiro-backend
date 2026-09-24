# Package 6 validation evidence

## Executed gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Focused API regressions | PASS | 8 suites / 49 tests covering pure certification, source adaptation, source routing, append-only storage, temporal financial reads, controller validation, worker gating/continuation, and qualification safety. |
| Fresh-schema migration | PASS | All 426 migrations applied to disposable PostgreSQL database `package6_qualification`, including `20280924060000_package6_funding_execution_accounting`. |
| Package 6 database qualification | PASS | Proposed/enacted separation, paired transfer source/destination, cumulative snapshot, signed negative obligation, signed rescission, explicit unallocated residual, availability period, immutable certification status, legacy compatibility, immutable source history, and dry-run worker reachability. |
| Accounting boundaries | PASS | A 100,000,000.00 cumulative snapshot remained separate from -12,000,000.00 of transaction deltas; transfers were balanced and atomic; residuals remained separate from allocations; a positive rescission was rejected by PostgreSQL. |
| Temporal read boundary | PASS | Reads filter certification and publication timestamps by `knownAt`; transfer counterparts and corrections obey the same bound; immutable certification status drives residual authority; availability dates survive publication and read. |
| Source-to-store adapter | PASS | Materialized source inputs require explicit source dates and existing measure UUID bindings, retain source-native/evidence identity, append only source events, and expose no allocation-writing capability. Writes require a separate exact activation flag. |
| Late-commit checkpoint safety | PASS | Allocation timestamps use wall-clock insert time and the worker freezes its high-water mark under a table lock, preventing pre-watermark timestamps from committing after a completed window. |
| Worker default | PASS | The real store reported `DRY_RUN`, examined 7 rows, found the single eligible exact account-level fact, published zero rows, and did not advance a checkpoint. |
| Qualification write safety | PASS | Qualification requires `PACKAGE6_QUALIFICATION_ALLOW_WRITES=1`, `--execute-on-disposable-package6-db`, and the exact parsed database name `package6_qualification`; connection credentials are never printed. |
| Prisma schema | PASS | Schema validation, client generation, and a full fresh-database migration. |
| Targeted TypeScript | PASS | Package 6 sources, adapters, scripts, controllers, storage, qualification, and worker paths compile under `tsconfig.package6.json`. |
| Full API build | PASS | Workspace dependencies, generated Prisma client, and the complete Nest API production build compiled together. |
| CDK schedule contract | PASS | 1 suite / 15 tests, including the Package 6 schedule disabled with its publication flag explicitly false. |
| Patch hygiene | PASS | `git diff --check`. |

The exact machine-readable result is [qualification-2026-09-24.json](./qualification-2026-09-24.json). It was produced by the executable database qualifier against a schema created entirely from repository migrations.

## Qualification-discovered correction

The first database run exposed that the certification query did not select the measure fiscal year when constructing immutable publication snapshots. That caused otherwise valid publications to be absent from fiscal-year reads. The query now selects `fiscalYear`, a regression assertion verifies the persisted snapshot, the disposable database was recreated from scratch, and the full qualifier then passed.

## Independent review corrections

Hermes’s final review found and the release fixed five additional gaps before merge:

1. `knownAt` now bounds publication rows, transfer counterparts, and correction suppression—not only certifications. Residual authority comes from immutable certification status.
2. Effective availability dates are snapshotted and exposed by financial reads.
3. Worker high-water capture combines wall-clock allocation timestamps with a table lock, eliminating the late-commit-behind-cursor window.
4. Rescissions must be negative transaction deltas in the pure certifier, store, and PostgreSQL constraint.
5. A real dark CLI/provider now calls the pure adapter and append-only store, requires explicit dates and existing measure UUID bindings, and never infers allocations.

## Dark-release posture

The Package 6 EventBridge schedule is disabled. The publication worker additionally requires both `--commit` and `FUNDING_EXECUTION_PUBLICATION_ENABLED=true`; the source adapter separately requires `--commit` and `FUNDING_EXECUTION_SOURCE_ADAPTER_ENABLED=true`. Missing either condition keeps its path read-only. Alternative-funding and execution source families remain ineligible for canonical annual promotion.

Production source-control and AWS deployment identifiers are recorded after the exact merged commit is released.
