# Source qualification receipts

Independent accepted implementation: `77e8323527d5ed533aa084cb8865f4b2d75f9958`.
Tree: `fd813d3ecf5937f1eebcc498af244f612bcdb61b`.
The publication commit adds only this handoff/evidence directory. All eleven
incremental code/test/migration-source Git blobs remain identical to that head.

Passing author checks: shared TypeScript build; primary full Core TypeScript
(`NODE_OPTIONS=--max-old-space-size=8192`); primary full Workspace TypeScript;
Core and Workspace Nest production builds; pinned Prisma5.22 official WASM
schema/DMMF and no-engine client generation into worktree-local outputs.
Core focused suites pass **92/92** across six suites, and internal command/state
flag boundary suites pass **18/18** across two suites. Workspace document and
prospect regression suites pass **39/39** across three suites. The independent
review passes **40/40** separate adversarial tests; no independent full-build or
native database claim is made. Counts are distinct run reports, not an aggregate
coverage metric.

The independent reviewer found and retained four P1 findings in the original
source `fcea81c0f1bda36c658d47def1abb9e7ccaf80a2`: impermissible immutable-origin
row lock, unresolved legacy-client content classified as firm, chooser disclosure
without current client wall, and preparation/unknown source origins admitted to
distribution. All are corrected. The original-helper regression preserves nine
failed and twenty-one passing checks, alongside setup/fixture failures. See
`evidence/independent-review/REVIEW.md` and exact source blob/SHA receipts.

All author failures are retained: the first engine/setup attempt lacked the local
Meri build; the first six-suite attempt also ran a source-contract fixture from
the wrong working directory and needed the new route manifest entry; copied
baseline Workspace client lacked PR2400 fields; the default 4GB full Core check
exhausted heap; the first8GB run reported two generic synthetic mock-interface
casts; a post-review lock assertion wrongly included the already-protected plain
canonical wall predicate. Local dependency setup, worktree-local exact-schema
WASM generation, the bounded route fixture, larger source check, and those test
fixtures were corrected. Empty final type/build logs are paired with exit0
receipts in `evidence/CHECKS.json`; complete prior output is preserved.

`evidence/generate-source-clients.cjs` records the exact official WASM/no-engine
recipe and refuses shared generation targets. Existing dependency store files
are read only; local built packages/Prisma clients are untracked worktree artifacts.
No native Prisma download, engine execution, migration or database execution,
provider/model call, upload, send, credentials, permission change, AWS operation,
security/network change, main merge or deployment occurred.

The final integration still requires coordinated shared/Core/Workspace release,
the reviewed saved-version immutability migration source, database-role/table
availability and native PostgreSQL/RLS/MVCC/lock/deadlock/revocation qualification.
Synthetic transaction queues test source decisions and rollback intent; they do
not demonstrate PostgreSQL acceptance. Dot owns that preparation. No limitation
is bypassed and source-only success is not a deployed-completion claim.
