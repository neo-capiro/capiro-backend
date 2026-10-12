# Source qualification receipt

Reviewed candidate: `961cbe0204d762ddfcb96ec054a907665720380e`, tree
`04749f1c520bc68ee5b68b1516b4256c2009cb27`. Runtime repair:
`2821bd4266b79d908fc131ba7fb738579b2b3407`. The final candidate adds only two
independently written tests. The prerequisite remains PR2395 at
`c5e41e320af4b4d841d4b3136777d712116916ed`; no original candidate was altered.

Implementer final synthetic runs: **128/128 Core tests in 10 suites** and
**141/141 Strategy tests in 7 suites**. The independent reviewer separately
passed **284/284 tests in 15 suites**, including 15 adversarial cases. These
selections overlap; do not add them together as unique coverage.

The independent review reproduced four legacy activity wall bypass cases (P1)
and two stale completed-receipt cases (P2) on the initial implementation
`027b5681349029086d4d9d836c5566130002b122`. Both repairs passed the same controls.
Original failures, expanded negative cases, runner failures and final passing
logs remain in `evidence/independent-review`.

The review covers scoped duplicate keys, activity/intent transaction rollback,
lost browser/provider responses, failed local persistence after remote acceptance,
stale versions and attempt fencing, no remote calls in a Core transaction,
actor/tenant/client boundaries, client walls on canonical activity routes,
revoked/remapped assignees, changed person association, deleted records, immutable
remote keys, unavailable or mismatched task destinations, scope headers, explicit
date/time/zone input, and bounded synthetic HTTP responses.

The Core and Strategy primary TypeScript checks and Nest builds are recorded in
the final machine receipt. A concurrent Core compiler run and the independent
Core compiler were OS-killed with exit 137; neither is counted as a pass. Final
Core compilation was rerun serially. The earlier Strategy check failed on a
tuple-index typing issue; after correction, primary tsc, build and normal Jest
diagnostics pass. Every failed invocation remains disclosed in the raw bundle.

Dependencies: frozen pnpm 9.12.0 offline install with scripts disabled. Shared
packages built locally. Official Prisma 5.22 WASM validated the schema and
generated a local no-engine client; no native engine was substituted. Core Jest
uses a supplementary isolatedModules configuration because this large existing
suite exhausted memory under normal ts-jest; primary tsc is separate. Strategy
uses the repository Jest configuration. No global compiler/linter replacement.

**Not qualified:** native Prisma/PostgreSQL concurrency, RLS enforcement, migration
application/rollback, real network/provider integration, deployed configuration,
frontend behavior, end-to-end distributed operation or a full repository test
run. No database migration or database write ran, including ephemeral databases.
The migration is source-only. API lint remains blocked by missing repository
ESLint dependency/configuration; see `TOOLING.md` for exact diagnostics/remedies.

Changed-path intersections were recomputed at the exact candidate. The new delta
over PR2395 overlaps that prerequisite only in Planner controller/HTTP tests.
Of the originally preserved candidates, only objective PR2362 intersects:
`apps/api/prisma/schema.prisma` and `apps/api/src/clients/clients.module.ts`.
The migration allocation is distinct. All other requested original intersections,
including Cleanup2392, are empty. A future integration must reconcile those two
additive registrations/schema relations without recreating objective persistence.

Source review supports this bounded contract only. Deployment preparation belongs
to dot; native qualification, migration authorization and frontend security
review remain separate gates. Full commitment/product decisions are enumerated
in `SCOPE.md` and `CONTRACT.md`.
