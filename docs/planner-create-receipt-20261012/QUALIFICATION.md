# Planner receipt qualification

Source: `78b24af72e97f5e36202f8e036d7a96345006b57`, based on refreshed main
`4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace`. Scope was committed first at `3f99b82ee`;
initial implementation was `ba695ab92843e5ef595f4c4013f88c1d354d446d`. Later evidence
commits do not modify runtime/test source. Exact hashes/intersections are in
`candidate-paths.json`. No original candidate branch was altered.

- **PASS:**183/183 tests in7 suites, zero skipped, using the unmodified checked-in
  `apps/api-strategy/jest.config.cjs` (normal ts-jest typechecking; no isolated-mode
  or diagnostics overrides). Existing Planner validation, access, links, resources,
  schedule and HTTP tests remain. Two additional suites exercise the real task owner
  with synthetic persistence/link boundaries. No DB/provider/model request is made.
- **PASS:**primary strategy TypeScript (`tsc --noEmit`) and Nest build on final source;
  six changed source/test files pass Prettier and whitespace checks.
- **BLOCKED TOOLING:**strategy lint exits1 because frozen dependencies lack `eslint`.
  No dependency/config change or suppression was introduced to hide this.
- **NOT RUN:**full monorepo gates, native Prisma/PostgreSQL/RLS/multi-connection
  contention, authenticated deployed acceptance, database/provider/model operations.

The new tests cover exact immutable recovery, concurrent synthetic replay, changed
payload409, object-key canonicalization, array order and omitted/null distinctions,
actor/tenant isolation, valid UUID parsing, untrusted authority fields, inactive actor
and assignee, project grants, direct Core links after task editing, receipt exclusion
from generic resources, lost committed responses, rollback after receipt insertion,
malformed deep JSON, missing task, calendar string and existing DST gap/fold policy.
The transaction double serializes callbacks and restores snapshots; it proves control
flow and write boundaries, not actual native lock/RLS behavior.

Independent reviewer found two P2 defects at `ba695ab92`: replay unnecessarily checked
an obsolete submitted client link, and deep invalid JSON overflowed recursive hashing
before canonical task validation. Both failing regressions were preserved, added to
the candidate and fixed in `78b24af72`. New commands validate their supplied links;
replays validate the current task's direct links. Existing non-command paths retain
validation order. Canonical task-shape validation bounds input before hashing. No
extra permission or date policy was invented.

Initial retained failures include six TypeScript test-fixture nullability errors and
two incorrect test assumptions about existing400 inactive-member validation and DST
gap normalization. The independent review also retains an initial test-injection
mistake, its correction, and both genuine RED cases. These are not passing receipts.

Frozen pnpm9.12 dependencies were reused from the sender candidate's successful
`--frozen-lockfile --ignore-scripts` install. `@capiro/auth` and
`@capiro/strategy-verifier` builds passed. The strategy-specific Prisma5.22 client
was generated to its configured isolated output using official WASM DMMF and the
official client generator with `noEngine:true`; it is for compilation/mocks only.
Official native engine installation remains HTTP403-blocked at binaries.prisma.sh.
No alternate engine/download/checksum bypass, native engine or live DB target was used.
Scratch harnesses/logs remain under `/workspace/backend-qualification-20261012/planner/`.

Reproduction (after existing frozen dependencies, package builds and generated client):

```bash
NODE_OPTIONS=--max-old-space-size=4096 apps/api-strategy/node_modules/.bin/jest \
  --config apps/api-strategy/jest.config.cjs --runInBand --runTestsByPath \
  apps/api-strategy/src/planner/planner-task-create-command.spec.ts \
  apps/api-strategy/src/planner/planner-task-create-command.independent-review.spec.ts \
  apps/api-strategy/src/planner/planner.http.spec.ts \
  apps/api-strategy/src/planner/planner.spec.ts \
  apps/api-strategy/src/planner/planner-links.spec.ts \
  apps/api-strategy/src/planner/planner-resources.spec.ts \
  apps/api-strategy/src/planner/planner-schedule.spec.ts
```

This closes an idempotent Planner-create/recovery prerequisite only. Complete Quick log
Core activity lineage, durable cross-service orchestration and task-audience/date-zone
product decisions remain open. No frontend, schema, migration, production/customer
mutation, approval, generation/send, merge or deployment is included. Deployment
preparation belongs to dot; draft source review does not grant release acceptance.

## Independent final verdict

`independent_backend_review`, a separate non-author reviewer, accepted exact source
`78b24af72e97f5e36202f8e036d7a96345006b57` with no blocking source findings.
Independent replay: **194/194** (183 focused tests in7 suites plus11 tenant-isolation
guards in2 suites), zero skipped. See `evidence/independent-review/FINAL-RECEIPT.json`
and `REVIEW.txt`. Review did not modify production source or open external/database
connections. Native multi-connection/RLS and release acceptance remain separate.
