# Defense-budget Package 6 — funding and execution

Package 6 adds source-qualified alternative-funding and execution accounting without collapsing distinct financial stages or treating unsupported associations as allocations. It is deployed from merge commit `d31604f6e489fdd76b5175241c6eeb547d2fcf0c`. The release remains dark by default: the scheduled certification worker is disabled, committed worker publication requires `FUNDING_EXECUTION_PUBLICATION_ENABLED=true`, and canonical annual promotion remains unsupported for these source families.

## Delivered scope

- Typed adapters for supplementals, emergency supplementals, reconciliation measures, continuing resolutions, rescissions, transfers, and reprogrammings.
- A callable source-to-store adapter that requires explicit source dates and existing measure UUID bindings, preserves native evidence, creates no allocations, and is dark behind an independent write gate.
- Explicit `alternative_funding` and `execution` source-family routing and readiness decisions.
- Append-only source events, immutable certifications, immutable publication snapshots, explicit reconciliation residuals, and durable bounded worker checkpoints.
- Proposed and enacted positions remain separate. A proposed measure cannot overwrite or masquerade as enacted authority.
- Cumulative snapshots and transaction deltas remain separate at read time and are totaled independently.
- Negative obligation corrections and rescissions retain their sign.
- Transfers require explicit balanced source and destination legs and are returned atomically for either touched program or program element.
- Only verified, exact, evidenced account-level facts can enter the narrow automatic worker path. Legacy and ambiguous allocations remain visible but cannot be certified.
- Cursor-paginated financial reads expose source identity, freshness, coverage state, residuals, and bitemporal `knownAt` behavior.
- One disabled EventBridge schedule definition for bounded certification and publication.

## Activation boundary

Do not enable the Package 6 schedule or set `FUNDING_EXECUTION_PUBLICATION_ENABLED=true` until operators approve the governed source coverage and initial residual queue. Source-event ingestion separately requires `FUNDING_EXECUTION_SOURCE_ADAPTER_ENABLED=true`. Package 6 does not enable canonical annual promotion for alternative-funding or execution sources, does not treat award association as allocation, and does not reconcile facts whose scope, metric, stage, or period differ.

## Evidence

- [Validation evidence](./validation-evidence-2026-09-24.md)
- [Machine-readable qualification](./qualification-2026-09-24.json)
- [Machine-readable release evidence](./release-evidence-2026-09-24.json)

Release scope: account `967807252336`, region `us-east-1`, cluster `capiro-dev`.

| Runtime | Released state |
| --- | --- |
| API task definition `:449` | ECS steady; desired/running/pending `2/2/0`; both tasks and replacement load-balancer targets healthy |
| Migration task definition `:134` | Package 6 accounting migration applied; one-off task exited 0 |
| Sync task definition `:34` | Exact release image registered; both Package 6 write flags false; proof run stayed in `DRY_RUN` and did not advance the checkpoint |
| Package 6 schedule | No live EventBridge rule; recurring certification/publication inactive |
