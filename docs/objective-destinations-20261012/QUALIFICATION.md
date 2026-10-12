# Objective destination source qualification

Original reviewed production/source checkpoint:
`49c6fe290cfc4f02552b05357ae00df1f6750b67`, tree
`b3119cffa84304611f53c9627b2de665b1556df5`. Its initial publication changes
were documentation and retained evidence only. A follow-on permission finding
required the source correction below. The original Objective candidate
and refreshed main remain preserved ancestors.

| Check | Outcome and receipt |
| --- | --- |
| Author focused authorization/owner tests | 23/23 passed; both ordinary and isolated ts-jest logs retained. |
| Author exact repaired source/regressions | 80/80 across 8 synthetic suites; `author-repaired-tests.json` and `.log`. Includes strict HTTP validation, active role guard, current Objective authority, owner-private sessions, stale revision, replay after revocation, changed sponsor, corrupt hash, legacy Objective service/controller/rules, route manifest and existing feature-guard regressions. |
| Independent baseline | 37/37 reproduced across the 3 new author suites; overlaps the author's 80 and is not an additional count. |
| Independent adversarial tests | 39/39 added cases passed on the reviewed exact tree. Includes integrated real owner/service methods with synthetic transactions, tenant/actor mismatch, role downgrade despite stale admin context, removed/archived/walled/deleted scope on replay, stale version, authorization gates during asynchronous reads, archive/sponsor transfer, other sponsor kinds and duplicate/nested/extra transport queries. Exact reviewer receipt, hashes and raw logs are retained under `evidence/independent-review`. |
| Primary Core TypeScript | Full `node --max-old-space-size=8192 node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` from apps/api passed exit 0 on repaired source. `core-tsc-repaired.log` is empty on success; the author source receipt records command/result. |
| Production Core Nest build | `node --max-old-space-size=6144 node_modules/@nestjs/cli/bin/nest.js build` from apps/api passed exit 0; `core-nest-build.log` and source receipt retained. This compiles production sources without executing API startup or connecting to a database. |
| Prisma schema/local typing | Official pinned Prisma 5.22 WASM configuration validation/DMMF plus existing JS client generator with `noEngine:true` passed. Worktree-local output only; `wasm-source-receipt.json`, pinned package lock, generator helper and raw log retained. Shared generated clients remain untouched. |
| Dependency/path checks | Every preserved candidate's exact head and merge base checked by Git; `path-intersections.json` contains complete changed paths and both increment/whole-branch intersections. Main read-only refresh confirms `4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace`. |

## Failed and corrected evidence

Follow-on P1 correction: initial published head
`30fa58467238542ff2b98137844ea02a3225e545` requested `FOR SHARE` on immutable
revisions, although original Objective migration source grants only SELECT/INSERT
and revokes UPDATE/DELETE on that table. PostgreSQL locking SELECT requires UPDATE
privilege ([official SELECT documentation](https://www.postgresql.org/docs/current/sql-select.html)).
The initial synthetic suite did not model that privilege boundary; its passing
results remain historical evidence and are not native permission acceptance.

Corrected source `3f5a879efc06174f77231706244c1ba5e33810fa`, tree
`1f94bbde87da5f996b17ec074b849c97452a769e`, removes only that immutable revision
row-lock request. The mutable current Objective and current tenant/member/user/
client/grant locks remain; parent locks protect cascade removals during resolution.
Schema, migration, role grants and permission configuration are byte-identical.
There is no new privilege request or executed grant.

The new source/synthetic privilege regression failed on the original published
source with the modeled UPDATE privilege refusal, then passed after correction.
An incomplete initial patch application also failed 1/120; both raw failures are
retained in `evidence/immutable-revision-repair`. The corrected source passes
120/120 selected synthetic tests across 10 suites and full primary Core TypeScript.
The independent correction review receipt records its own additional tests and
exact reviewed source hashes: 130/130 across 11 synthetic suites, including 10 new
independent repair cases, 39 retained independent destination cases and 81 author
cases. Its evidence-only commit is `9d7b2d4706646ebe9069de85761c4b6f7881cd0c`.
No database, migration, native MVCC/RLS or live
permission experiment was run.

The original full TypeScript check failed on 16 strict unchecked array indexing
diagnostics. Its raw `core-tsc-frozen.log` remains. Production now uses an optional
sponsor reference when checking the exact client; a missing reference fails closed.
Synthetic assertions explicitly mark known recorded query rows. The repaired
checkpoint above passes full TypeScript and all author checks.

The first `pnpm exec` launcher attempted workspace auto-install and failed before
installation on a protected home path. Its raw `initial-tests.log` remains; all
subsequent tests used direct installed Node/Jest executables. The first pinned
internals install with scripts disabled failed on the protected home cache;
`pinned-internals-install.log` remains. The writable `/tmp` cache retry passed
with scripts still disabled. No native engine download or bypass was attempted.

Independent review initially had 33/39 passing cases because two test fixtures
hashed invalid sponsor state before invoking the resolver and an empty-array test
parameter was shaped incorrectly. Both original fixtures and failing raw results
were retained, then fixed in the reviewer worktree; the repaired independent 39/39
passed. A wrong-root Jest launcher failure is also retained. These are separately
identified fixture/tool failures, not hidden production failures.

## Deliberate execution boundary

No database or migration was executed, including PGlite or another ephemeral
database. Existing `objectives.pg.spec.ts` and `objectives.authorization.spec.ts`
were excluded because they execute a database. Synthetic SQL boundary tests verify
parameterization, ownership predicates, lock clauses, control flow and replay;
they do not execute PostgreSQL locks or prove MVCC/RLS acceptance.

No real message, upload, provider call, paid model, customer mutation, credential
or permission change, AWS operation, security/network change, main merge or
deployment occurred. Native Prisma HTTPS CONNECT restrictions remain respected;
no alternate engine host/checksum disablement was used. Native PostgreSQL
authorization, lock ordering/deadlock, concurrent revocation, RLS and Objective
migration qualification remain a coordinated release gate owned through dot.
