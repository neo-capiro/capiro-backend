# Effective-date source qualification

Current independently accepted source: `35abc148e301b5b0b0baa4f5b284757079d9d91d`,
tree `38c8529eb308631922bee8d1c3f4d920bc4a0bf3`. Current test/evidence adoption:
`178fad95e51eb1f962d2bf4bf8503eae597fb4fb`, tree
`f8e99e5a01e8be1939e44837dc0655d0e7964e84`, identical to the accepted correction
reviewer tree. Independent final qualification passes **181/181 across eight
suites**, including **109 independent cases** (82 original plus 27 checkpoint).
Primary Core strict typing and strict script semantic typing pass; the production
API source remains unchanged from the previously passing Nest build.

The original published source `f5a043c2558c1073b46bbeab81e60c403830d299`
remains an ancestor. New actual-script VM RED proof reproduces both partial-catalog
and legacy-receipt skipped-tail defects against that original script. Corrected
checkpoint filtering and eligibility refuse partial/error/legacy/manual receipts
and retain the old floor until an ordinary window is proved complete. The source
snapshot confirms only the sync script changed; other runtime/schema/migration
blobs match the original independently accepted source.

`checkpoint-independent/CHECKPOINT-RECEIPT.json` records exact source, all RED,
GREEN, fixture failures and strict semantic checks. `SHA256SUMS.json` is deliberately
the original 66-file first-publication manifest; validate it against the original
Git blobs. `SHA256SUMS-current.json` verifies the corrected publication. No original
failed/pass output or source head is overwritten. The brief executor disconnect
and actual successful recovery checks are recorded separately.

## Original accepted source and retained qualification


Accepted runtime/source: `f2b4cf3d733bf3cbb84dd8c453c037848d82ea82`, tree
`08519d0fa4fc14da9116b3f299d0d9d5c4e0c685`.
API runtime code, schema and migration remain byte-identical to that independently
reviewed source; the independently reviewed checkpoint correction above changes
only the existing sync script. Author worktree test/evidence adoption is
`84e0d719c6447d24319899838a846af9fe3a02c4`, tree
`f9d5950eb141a85e466b9f7fbd989725f739855a`, identical to the independent
fixture-repair tree. Subsequent publication changes only docs/evidence.

## Passing source checks

- Independent final synthetic qualification: **154/154 tests, seven suites**,
  including **82 independently authored cases** and 72 retained author/helper
  cases. These overlap author checks and are not additive test totals.
- The author frozen-source focused run separately passed 72/72 across five suites.
- Independent strict semantic TypeScript includes the actual sync script, both
  independent test files, repository unchecked-index strictness and imported
  runtime sources; passes with no emission.
- Primary Core API strict TypeScript final acceptance is recorded in
  `author-typecheck-final-pass.log` and the command receipt.
- Core API production Nest build passes, exit 0 (`author-nest-build.log`).
- Official pinned Prisma 5.22 WASM DMMF validates the complete schema and new
  evidence fields. This is static source validation; it downloads no native
  Prisma engine and connects to no database.
- Runtime/source hashes match the exact reviewed Git blobs; independently added
  fixtures/evidence match the accepted repair commit tree. Source-only diff-check
  passes. Original exact candidate heads and intersections are recorded separately.

Adversarial coverage includes actual RolesGuard behavior; missing/unknown roles;
invalid/leap/impossible dates; field substitution refusal; canonical publisher and
GovInfo identity/publication-day checks; correction URL refusal and unresolved
correction exclusion; receipt tampering/foreign identity/extra fields; stale/future
observations and exact age boundary; changed/withdrawn date revision lifecycle;
metadata/source mismatch; canonical identity-before-row locks; stale replay without
writes; evidence-write failure propagation; snapshot counts, absent aggregates and
latest-per-source refresh lookup; original sync pagination/duplicate/count-drift/
missing-page/row-failure behavior; bounded historical refresh, foreign detail
identity/date refusal and durable existing SyncRun partial stats.

The actual sync script runs only in an independent VM with fake Prisma/fetch,
synthetic immediate timers and an explicit import allowlist that refuses unmocked
dependencies. No provider or database execution occurs in those tests.

## Retained failed evidence

`author-command-cwd-failure.log` records an initial root-workdir log-path mistake;
no tests ran. `author-tests-initial.log` records eight calendar fixture failures
from an initial run during source/mock edits; the source was frozen before the
72-case passing run. The definitive review and publication checks use committed
sources and retain the earlier failed output.

`author-typecheck-initial.log` records the default 4GB Node heap OOM. The 8GB
semantic retry (`author-typecheck-8gb.log`) reported nine own source/test strict
typing findings; the author added absent-aggregate refusal and corrected fixture
typing. After adopting independent tests, the primary checker reported eight
reviewer fixture unchecked-index findings (`author-typecheck-adopted-fixtures-failed.log`
and `author-typecheck-final.log`). The reviewer corrected only those fixtures and
reran all 154 cases plus semantic compilation with the repository flag.

Independent evidence also preserves the default 3GB ts-jest semantic-transform
OOM, incorrect ambient-type command workdir and reviewer fixture tuple error.
Synthetic execution subsequently used isolated transpilation; separate semantic
checks provide type evidence. No failure is converted into a pass or erased.

Whole-diff whitespace checks intentionally flag exact raw logs with trailing
whitespace. Those bytes remain preserved. Runtime/test source diff-check passes;
receipts record the raw-log check failure and scoped source success independently.
Two readonly reference API browser lookups were inaccessible; no upstream date
sample or live source corpus is used as runtime acceptance.

## Practical limits and exact release gate

No native Prisma engine, PostgreSQL connection, database/migration execution,
RLS/FK/CHECK acceptance, advisory-lock/MVCC/native concurrency, real upstream
provider request from the sync owner, message/upload, paid model, customer data
mutation, credentials/permissions, AWS operation, security/network configuration,
main merge or deployment occurred. Main remains
`4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace` at final refresh.

Synthetic/WASM/type/build receipts qualify reviewed source only. Dot owns release
preparation: compose exact candidate sources, regenerate the pinned exact Core
client through the approved normal toolchain, apply and qualify the migration in
an explicitly authorized database, validate actual publisher interoperability and
native locking/concurrency, and determine the refresh schedule. The recorded
`binaries.prisma.sh` ordinary HTTPS CONNECT block remains unbypassed; no alternate
host, checksum disablement or permission/security change is introduced here.

The independently owned EngagementService reporting slice is untouched; its
unpublished reviewed source is not presumed lost. General Workspace objective
same-client authority and durable Objective-bound creation remain separately
bounded work. Existing task/activity/Planner owners remain intact; the excluded
commitment UI/full party semantics receive no source or dead scaffolding.
