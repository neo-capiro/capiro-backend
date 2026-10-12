# Independent effective-date source review

Accepted runtime/source candidate: `f2b4cf3d733bf3cbb84dd8c453c037848d82ea82`,
tree `08519d0fa4fc14da9116b3f299d0d9d5c4e0c685`, based on main
`4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace`. The isolated review worktree
cherry-picked the final correction as `811cca9ad`; its tree is identical.
Reviewer additions are tests and evidence only. No author worktree was edited.

## Acceptance and scope

The final review run passes **154/154 tests in seven suites**, including **82
independently authored tests** and 72 retained author/helper cases. Counts overlap
the author's checks and must not be added to them. Focused strict semantic
TypeScript verification, including the repository's `noUncheckedIndexedAccess`
setting, includes both independent test files and the actual
`apps/api/scripts/sync-federal-register.ts` script, with no emission. The separate
Jest runner uses isolated transpilation to keep the full repository's semantic
graph out of synthetic test execution; semantic compilation is a separate check.

The calendar requires exact date-only `effective_on`, rule type, matching canonical
document identity and publication-day-bound official GovInfo PDF URL. It retains
publisher field/provenance and a source-projection SHA-256 checksum. Publication
and comment-end dates never supply effective-date values. This is bounded publisher
metadata sourcing, not downloaded PDF content interpretation or a comprehensive
legal dates-section parser.

Actual controller metadata and RolesGuard were exercised with missing context,
unknown role and permitted standard/admin roles. Existing authentication middleware
remains the actor/context owner. This route reads existing global Federal Register
reference data; it does not create a tenant/customer resource or a new data owner.
The reviewer inspected the middleware registration and its route exclusions.

Equal/older observations cannot write metadata or evidence. The existing sync owner
serializes document identity before row loading, binds source/metadata identity,
type, publication date and PDF URL, and commits canonical metadata and evidence in
one transaction. Failed evidence persistence propagates as failure. Tests verify
the source ordering and stale branches with synthetic transactions. They do not
prove native PostgreSQL advisory lock, MVCC, rollback or concurrency behavior.

Read checks reject foreign/malformed/hash-mismatched receipts, contradictory stored
date/observation columns, future timestamps and observations beyond the exact 48-hour
boundary. Corrected/original correction relations require review and are excluded.
Re-observation retains revision/change time; changed/missing date transitions retain
one bounded previous snapshot. Read output strips unexpected receipt fields.

Coverage remains explicitly incomplete: locally ingested publisher metadata only;
all-federal-rule coverage, parsed full dates sections and separately issued correction
resolution remain false. Pagination reports candidate/excluded/returned counts.
Latest ingestion and refresh receipts are selected independently without a shared
history cutoff. Missing aggregate snapshots fail closed. Coverage stats persist in
the existing SyncRun receipt, and a partial window does not become a success watermark.

The actual sync script was independently executed in a VM with only fake Prisma,
fake fetch, immediate synthetic timers and explicitly mapped imports. Unmocked
dependencies throw. Nine tests cover exhausted unique windows, duplicates, count
drift, missing pages, row failures, bounded identity refresh, stale observations,
foreign detail identity, invalid publication dates and failed detail responses.
No network request, database connection or migration was executed.

## Findings incorporated before acceptance

The initial inspection found metadata/source identity disagreement was unchecked,
official PDF package dates were only regex-shaped, timestamp/order validation and
previous-snapshot projection were too permissive, shared recent-run lookup could
hide a source's latest receipt, and SQL CHECK key comparisons could evaluate NULL.
The author fixed these before the reviewed source freeze. The final source includes
explicit key comparisons with `IS TRUE`; the reviewer inspected migration source,
without executing it. A missing-aggregate guard was subsequently added in the
final correction and independently tested. No blocking source issue remains.

## Preserved failures and remaining qualification

`review-initial.log` preserves the first default ts-jest transform's 3GB heap OOM
before assertions ran. `review-types-initial.log` preserves the first focused type
command's incorrect root ambient-type resolution. `review-types-app.log` preserves
one reviewer-only mock tuple type error; that fixture was corrected. Final logs
and JSON receipts are retained separately; no failed evidence was replaced.
The whole-candidate whitespace check flags trailing spaces in unchanged raw
ts-jest warning output; its failure is retained in `review-diff-check-raw.log`.
The source/test check scoped to `apps`, `packages` and `scripts` passes. Raw
tool-output bytes were preserved rather than edited to satisfy a formatting check.

The author's subsequent full Core compile identified eight possible-undefined
index accesses in reviewer fixtures. The earlier focused strict command had not
enabled the repository's additional `noUncheckedIndexedAccess` flag. The original
full-compile failure is retained as `review-repository-types-adopted-red.log`.
Reviewer-only assertions now check the transaction call count before deliberate
non-null call indexing, and the two-rule script fixture is a const tuple. The
updated focused compile explicitly enables `--noUncheckedIndexedAccess` and
includes the actual sync script; it passes. The unchanged 154 synthetic cases
pass again in `review-fixture-repair-final.json`. Runtime source still matches
every frozen Git blob in `source-review-fixture-repair-final.json`.

This review does not constitute native Prisma/PostgreSQL/RLS acceptance, provider
verification, migration application, deployment or a main merge. Those checks
remain unrun under the source-only authorization. No credentials/permissions, AWS,
security/network configuration, real messages/uploads, paid models or customer
data were touched. The separately owned EngagementService reporting work and all
preserved candidate branches remain untouched.
