# Combined Portfolio backend verification

Review PR: [backend #464](https://github.com/neo-capiro/capiro-backend/pull/464). Companion: [frontend #556](https://github.com/neo-capiro/capiro-frontend/pull/556).

Final source checkpoint: `2da4153abff52e663a119b9a12944452a312b41b` (tree `e2f9d0be364ccc4acff173a3664e9220d2073835`). Published trees were compared exactly with the locally reviewed integration trees. Later documentation-only commits do not change that source.

## Current-base integration

`backend-import` advanced from `471e3451b48674d881b395b354ea5b1292b698ca` to `4254a1cd7e5933197065bb698a5600288af65121` while this task was running. The latter's DIBBS funding-document change is preserved. The local merge retained both parent schemas and every file in the 563-file migration-directory union; only two runtime closure schema-hash pins conflicted. The canonical source-binding generator resolved those pins, and independent review verified preservation and the resulting tree. No historical migration bytes were changed.

Merged Prisma client generation passed. The source-binding verifier and the two focused schema/contract checks passed. Seven regression suites spanning the newly integrated funding documents and the Portfolio opportunity, metric and folder consumers passed: **137 tests, no skips**.

## Checks

Node 24.22.1, pinned pnpm 9.12.0, Prisma 5.22.0. Dependencies came from the unchanged frozen lockfile. Required shared/defense packages and sibling Prisma clients were built/generated locally; no migration or network-backed job was run for setup.

| Check | Result |
| --- | --- |
| Workflow tests | 123 targeted tests plus 7 mounted HTTP text-read tests pass. |
| Service and selected-tracker admission tests | 602 passed across the documented runs; 8 native PostgreSQL SQL cases skipped because an isolated connection was not configured. |
| Combined current-base regression | 7 suites / 137 tests pass. These overlap earlier coverage and are not an additional unique-test total. |
| API TypeScript phases | All TypeScript phases pass on the original baseline and candidate with a 6 GB heap, including the final LegiWatch phase run separately. |
| Safety script | The package command reaches `tsx` after the preceding TypeScript phases, but that CLI cannot create its IPC socket in this host. This reproduces on baseline and candidate. The same DB-free script passes in both through `node --import tsx scripts/verify-pe-phase-a-safety.ts`; the final TypeScript phase then passes separately. No test assertion or source command was weakened. |
| Final merged API production build | `NODE_OPTIONS=--max-old-space-size=6144 pnpm --filter @capiro/api build` passes on the final merged source. Earlier lower-memory attempts exhausted the heap or were killed by the host limit; the final run was isolated. |
| Boundary and qualification checks | 67/68 boundary and 22/24 qualification cases pass. The missing `resumeDebriefJob` route registry entry and two qualification assumptions fail identically on exact base; see lane evidence. |
| Backend lint | Not run: the existing script refers to ESLint, but the backend's installed declared dependency set supplies no executable. |
| Independent review | No blocking source findings in the final contracts or upstream integration. Tenant/client/wall boundaries, explicit history and source-specific district semantics were reviewed. |

## Release limits

The two proposed forward migrations must be qualified and applied through the existing release process before the dependent frontend is deployed. The PGlite folder/metrics tests establish executable SQL, foreign-key and application authorization behavior; owner-role execution does not prove non-owner PostgreSQL RLS enforcement. Native PostgreSQL, runtime image scans, deployment and live acceptance were not performed.

F02 now has bounded source/query recovery and preserves partial/unknown outcomes; the production outage's actual cause remains unverified. F04 prevents rejected extractor caveats being reintroduced after composition, but the old approved synthetic artifact was not rewritten or re-approved. F11 prevents archived canonical-client conversion targets and improves prerequisites; the historical fixture and a fresh deployed conversion still need acceptance. Mail contact ties are no longer auto-assigned, but individual existing mail associations were not adjudicated.

See [workflow evidence](backend-workflows.md) and [service evidence](backend-services.md) for exact commands, reviewed local checkpoints, failed baseline assertions and supported behavior.
