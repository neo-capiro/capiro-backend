# Defense-budget completion plan — Package 0 release inventory

Package 0 was executed against current `neo-capiro/capirov2` main rather than assuming the plan's older audited commit or inaccessible repository name. The evidence here distinguishes repository code, deployed AWS state and live database state.

## Exit evidence

- [Runtime and deployed digest inventory](./runtime-inventory-2026-09-24.json)
- [Live approved-data and coverage snapshot](./approved-data-snapshot-2026-09-24.json)
- [Source-to-reader traces](./source-to-reader-traces.md)
- [Numerical operating budgets](./operating-budgets.v1.json)
- [Assigned delivery backlog](./delivery-backlog.v1.json)
- [Validation evidence](./validation-evidence-2026-09-24.md)
- [Release and AWS deployment evidence](./release-evidence-2026-09-24.json)

## Reconciliation decisions

| Item | Finding | Package 0 action |
| --- | --- | --- |
| Repository | Active repository is `neo-capiro/capirov2`; the release-code commit is `4b118bc148df9ae168585ebd8ad0dd595cb6a230`, not the plan's `0f477343d`. | Rebased all work on current `origin/main`; final evidence is merged separately as documentation-only history. |
| Package C PR #1704 | The open branch conflicted with later main and its approval-replacement guards were absent. | Reconciled through PR #1759 while preserving later schema fields. The disposable rehearsal exposed and fixed an omitted CLI allow-list entry. PR #1704 is closed as superseded. |
| Package E PR #1716 | The open draft conflicted with later main and its governed manifest runner was absent. | Reconciled through PR #1759, migrated, built into digest-pinned ARM64 images, qualified in isolated Fargate and deployed dormant. PR #1716 is closed as superseded; no runnable production manifest exists. |
| Scheduler | A daily legacy budget watcher is live, but the lifecycle coordinator has no timer and no deployed `defense-api` runtime. | Record as a Package 1 owned gap; do not count the legacy rule as lifecycle-coordinator activation. |
| Approved data | 43 active scoped approvals exist, but there is no canonical snapshot or canonical row. | Preserve approvals; do not claim published canonical coverage. Assign the promotion proof to Package 3. |
| Coverage | The database contains 82 logical source slots for FY2024, only five `published` and one `partially_published`. | Use 82 only as a logical denominator; Package 1 must reconcile physical documents/exhibit units. |
| Queue | Nine rows are pending and four are dead-lettered; the oldest pending row dates to 2026-08-23. | Do not auto-drain during release. Package 1 receives an exact-manifest recovery item. |
| Extraction | Only RDT&E is wired through the durable factory resolver. | Assign non-RDT&E production wiring to Package 3. |
| Alternative funding/execution | Readiness explicitly reports these tracks unsupported. | Assign certification/publication to Package 6. |

## Completed release ordering

1. Package C, Package E and the Package 0 inventory merged through PR #1759; two release-found defects were corrected through PRs #1762 and #1763.
2. Prisma validation, focused unit suites, disposable PostgreSQL rehearsals and isolated PostgreSQL/MinIO image qualification passed.
3. Release code was merged into both local and GitHub `main` at `4b118bc148df9ae168585ebd8ad0dd595cb6a230` before the documentation-only evidence merge.
4. Linux/ARM64 API and drain images were built from that exact revision, pushed with immutable tags and bound by digest; the drain manifest contains the exact API layer set as its prefix.
5. `prisma migrate deploy` applied both additive migrations before the first service rollout.
6. The dev API reached a stable two-task deployment. The manual drain revision remains parked at `echo no-op-default-command`, with no service, running task, EventBridge target or Scheduler schedule.
7. The final `BEGIN READ ONLY` snapshot confirmed both migrations, 43 preserved active approvals, an empty governed-manifest table, and zero canonical snapshots/rows.

The selected AWS target is `capiro-dev`: it is the only cluster with the defense-budget archive, extraction-artifact stack and drain task. No matching defense runtime was found in staging or prod-os, so Package 0 does not pretend to deploy a nonexistent production topology.
