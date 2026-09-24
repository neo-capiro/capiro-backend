# Defense-budget completion plan — Package 0 release inventory

Package 0 was executed against current `neo-capiro/capirov2` main rather than assuming the plan's older audited commit or inaccessible repository name. The evidence here distinguishes repository code, deployed AWS state and live database state.

## Exit evidence

- [Runtime and deployed digest inventory](./runtime-inventory-2026-09-24.json)
- [Live approved-data and coverage snapshot](./approved-data-snapshot-2026-09-24.json)
- [Source-to-reader traces](./source-to-reader-traces.md)
- [Numerical operating budgets](./operating-budgets.v1.json)
- [Assigned delivery backlog](./delivery-backlog.v1.json)
- [Validation evidence](./validation-evidence-2026-09-24.md)

## Reconciliation decisions

| Item | Finding | Package 0 action |
| --- | --- | --- |
| Repository | Active repository is `neo-capiro/capirov2`; current main was `950072f47`, not the plan's `0f477343d`. | Rebased all work on current `origin/main`. |
| Package C PR #1704 | Open, conflicting and absent from main. Its approval-replacement guards, migration and tests were not shipped. | Reconciled on the Package 0 release branch while preserving later schema fields. The full disposable upgrade/replacement rehearsal exposed and fixed an omitted CLI allow-list entry before release. |
| Package E PR #1716 | Open draft, conflicting and absent from main. Its manifest tables/runner were not shipped. | Reconciled separately from Package C. The exact drain image must be qualified in isolated Fargate and the worker remains parked until an exact manifest is approved. |
| Scheduler | A daily legacy budget watcher is live, but the lifecycle coordinator has no timer and no deployed `defense-api` runtime. | Record as a Package 1 owned gap; do not count the legacy rule as lifecycle-coordinator activation. |
| Approved data | 43 active scoped approvals exist, but there is no canonical snapshot or canonical row. | Preserve approvals; do not claim published canonical coverage. Assign the promotion proof to Package 3. |
| Coverage | The database contains 82 logical source slots for FY2024, only five `published` and one `partially_published`. | Use 82 only as a logical denominator; Package 1 must reconcile physical documents/exhibit units. |
| Queue | Nine rows are pending and four are dead-lettered; the oldest pending row dates to 2026-08-23. | Do not auto-drain during release. Package 1 receives an exact-manifest recovery item. |
| Extraction | Only RDT&E is wired through the durable factory resolver. | Assign non-RDT&E production wiring to Package 3. |
| Alternative funding/execution | Readiness explicitly reports these tracks unsupported. | Assign certification/publication to Package 6. |

## Release ordering

1. Merge the reconciled Package C and E code into the Package 0 branch without combining their responsibilities.
2. Run Prisma validation, focused unit suites and disposable Postgres/MinIO qualification where available.
3. Merge the reviewed Package 0 branch into local `main`, push GitHub `main`, and capture the exact Git SHA.
4. Build and push the API/drain image tagged with that SHA; bind ECS task definitions to the resolved digest.
5. Run `prisma migrate deploy` through the fail-closed migration entrypoint before starting any new writer.
6. Update the dev API service and the manual drain task definition through AWS CLI, leaving the drain parked.
7. Run the Package 0 read-only snapshot command and verify both new migrations are applied, approved rows are preserved and no unapproved manifest started.

The selected AWS target is `capiro-dev`: it is the only cluster with the defense-budget archive, extraction-artifact stack and drain task. No matching defense runtime was found in staging or prod-os, so Package 0 does not pretend to deploy a nonexistent production topology.
