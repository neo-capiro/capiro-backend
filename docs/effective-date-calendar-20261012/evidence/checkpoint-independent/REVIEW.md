# Independent automatic-checkpoint correction review

Accepted source: `35abc148e301b5b0b0baa4f5b284757079d9d91d`, tree
`38c8529eb308631922bee8d1c3f4d920bc4a0bf3`. The isolated reviewer worktree
imports the strengthening commit as `c442c41e04c96468e23304f91c74b8c6919fdf0e`
with that same tree. Preserve this source and its parent correction
`64c3b0e3d422b45c6c4c39a5458babbe8c0c2661`; neither is replaced or amended.

Final GREEN: **181/181 tests in eight suites**, retaining all previous 154 cases
and adding 27 independent automatic-checkpoint cases. This is 109 independently
authored cases plus 72 retained author/helper cases; those counts overlap previous
receipts and are not additive. Strict semantic TypeScript with
`--noUncheckedIndexedAccess` checks all three independent test files and the actual
sync script. Source/test formatting checks pass. No runtime code was edited by
the reviewer.

## Defect reproduced against the published candidate

The exact script from published head
`f5a043c2558c1073b46bbeab81e60c403830d299` is retained as
`previous-sync-source.txt`, with its bytes verified against that Git blob.
The same independent regression assertions were executed against it in a VM.
Both selected RED cases fail as intended: the partial/catalog and legacy/catalog
examples expected the safe `2021-01-01` fallback, but received the partially
written catalog's `2026-10-12` maximum. The older unseen tail is therefore omitted
from that request window. This remains a source/synthetic reproduction; no actual
provider request or database execution was involved.

The first review checked partial receipt marking, but did not exercise the
automatic `--incremental` floor selection. This correction review supersedes the
earlier completeness conclusion for that seam. All older review heads, exact logs,
receipts and source snapshots remain retained as historical evidence.

## Corrected boundary verified

Automatic ingestion now asks the existing SyncRun owner for the latest `success`
receipt from `sync-federal-register` with numeric protocol version 1, scope
`publication_window` and actual boolean `incrementalCheckpointEligible: true`.
No checkpoint means the original historical default. The floor uses that approved
receipt's UTC start date, never the locally written document maximum. A newer
partial/error/manual/legacy/foreign-source receipt cannot replace the qualified
one. Database JSON-path/native query acceptance remains unrun; tests verify the
actual generated query and simulate matching with a query-aware receipt fixture.

The eligibility flag is true only for an ordinary window with no explicit CLI or
environment `--since` override, an exhausted unique identity set equal to the
expected count, no page completeness defect and zero row errors. Flag and status
are independently checked. Manual overrides still choose their explicit window,
but their successful receipts remain ineligible for later automatic ingestion.

New cases cover exact protocol query/default floor, partial local maxima, legacy
success, missing/wrong protocol types and eligibility, foreign/refresh scopes,
newest qualified receipt despite later failed attempts, ordinary full/incremental
eligibility, CLI/environment overrides, per-row failure, duplicate identity,
missing identity, count drift, failed older page after partial writes, checkpoint
read failure, failed first page and invalid explicit dates. The actual script runs
with fake Prisma/fetch/timers and explicitly mapped imports; unexpected imports
throw. Terminal catch handling is observed after the script's disconnect.

`source-snapshot.json` verifies the final source tree, every changed code/retained
test blob, and the exact RED snapshot. Only `sync-federal-register.ts` differs from
the preceding published candidate. Every other runtime source path still matches
accepted `f2b4cf3d733bf3cbb84dd8c453c037848d82ea82`, including calendar authority,
observation ordering, schema/migration and the existing receipt owner. This review
adds one test file and evidence, without altering old files or candidate branches.

## Preserved check failures and limits

The first semantic command found reviewer fixture stats-index and parameter-row
typing mistakes; `checkpoint-types-initial.log` is retained. Initial GREEN runs
retain the parameter-row mistake and the subsequent VM terminal-catch timing
mistake in their original logs/JSON. Corrected final semantic and GREEN evidence
remain separate. Raw warning whitespace is preserved; formatting checks concern
source/test files rather than reformatting exact tool output.

No blocking source finding remains. Native Prisma/PostgreSQL JSON-path, migration,
RLS/MVCC/lock/concurrency acceptance, upstream interoperability and deployment
remain unrun under the source-only boundary. No actual credentials/permissions,
AWS/security/network changes, database/customer writes, messages/uploads or paid
models were used. Existing comprehensive legal effective-date coverage and separate
correction resolution remain explicitly unclaimed by the calendar contract.
