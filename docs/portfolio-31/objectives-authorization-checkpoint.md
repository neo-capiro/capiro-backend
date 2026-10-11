# Objectives client authorization checkpoint

Date: 11 October 2026. This is a backend prerequisite for the existing Objectives
candidate, not a deployed feature or a completed Portfolio acceptance test.

## Isolation and source

- Checkout: `C:/dev/cap-objectives-auth-261011`.
- Branch: `codex/portfolio-objectives-authorization-20261011`.
- Starting candidate: `a9c6bdc35af70270d774ed9aeec542840f97af4c` (PR 2362).
- Freshly fetched backend `origin/main`: `fd8765ec01d292013758606204f2c9d886cd31c1`.
- Freshly read shared policy: `b32b4803933760dc0a93fffdcd8fba30a89c3aac`.
  Its clean, three-commit local lead over remote main was preserved. BOOTSTRAP,
  AGENTS and the machine path map were read; no repository AGENTS file exists here.
- No other checkout, migration, schema, controller, module, authentication setting,
  helper, dependency, deployment or provider was changed.

## Confirmed issue and correction

The candidate's `assertClient` originally checked only tenant and non-archived
client status. A same-tenant actor without a memory-wall grant could list, read,
create, edit, transition and soft-delete Objectives. The route's existing minimum
`standard_user` role did not address this client access boundary.

The service now calls the unchanged `clientMemoryAllowed` from
`apps/api/src/memory/memory-wall.helpers.ts`, once in each `assertClient` invocation,
inside the existing `withTenant` transaction. Access still requires an existing
client in the caller's tenant with status other than lowercase `archived`.
A closed wall returns the same `404 Client not found` as a missing, foreign or
archived client, before touching Objective data or revision history.

The canonical policy permits an unwalled client, or a walled client with an exact
tenant/client/user grant. Administrators receive no implicit bypass. The actual
`client_memory_access` table has six columns and no expiry/status/revocation flags;
revocation hard-deletes the grant. The different `memory_access_grant` table is not
used as a substitute.

Rechecks cover:

- List results and single-Objective reads, before publishing existence, readiness
  or version-conflict details.
- Owner membership reads, before disclosing an invalid owner or writing.
- Create dispatch, write count and idempotent lookup, including a duplicate request
  with matching saved payload and a conflicting request.
- Versioned update/delete/transition dispatch, `updateMany` count conflicts and
  record readback.
- Revision writes before and after their awaited operation, before returning a
  saved receipt. Unchanged edits and already-current transitions remain inert and
  cannot return a record after a visible access change during their read.

The controller has no revision-history read endpoint. Existing internal revision
persistence is gated; no new history API was invented. Objective readiness, owner
rules, normalized fields, creation idempotency, version predicates, soft deletion
and all existing assertions are preserved. The old service spec adds only the
canonical raw-query fixture needed by its already-authorized synthetic actor.

## Checks and evidence

Runtime: explicit bundled Node `v24.19.0`. Existing backend dependencies were read
from `C:/dev/cap-portfolio-31-20261010/apps/api/node_modules`; nothing was installed
or modified. Test configurations and original source are retained under this
checkout's uncommitted `work/objectives-authorization/` qualification directory.

| Check                                                             | Result                                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Initial authorization run against untouched candidate             | Expected RED: 65 failed, 12 passed, 77 total; exit 1                   |
| Final identical 78-case spec against exact original service bytes | Expected RED: 66 failed, 12 passed; exit 1                             |
| Final authorization spec against corrected service                | 78 passed, zero skipped; exit 0                                        |
| Existing Objective service/controller/rules specs                 | 10 + 5 + 5 passed                                                      |
| Unchanged canonical memory-wall and role specs                    | 10 + 12 passed                                                         |
| Unchanged Objective migration PGlite spec                         | 8 passed; exit 0                                                       |
| Focused service + changed/new spec TypeScript check               | Zero diagnostics; exit 0                                               |
| Wider Objective source graph baseline comparison                  | Same one inherited diagnostic in both graphs; comparison exit 0        |
| Scoped Prettier and whitespace check                              | Passed                                                                 |
| ESLint attempt with available borrowed runtime                    | Unavailable: exit 2, no repository ESLint configuration; preserved log |

The wider graph diagnostic is the existing missing `supertest` declaration in
`objectives.controller.spec.ts`, not a new diagnostic in a touched file. This is
not a claim that the full backend typecheck or lint suite is green. The lint
configuration was not invented and no checks/assertions were weakened.

The new authorization suite executes the unchanged canonical wall SQL and
tenant/archive client lookup SQL in disposable PGlite tables. It covers all six
operations, wrong grant tenant/client/user, hard-deleted grants, no admin bypass,
absent actor, SQL failure, pending read/write/revision access changes, owner checks,
version conflicts, inert branches and matching duplicate-create receipts.
Objective operations in this suite are observable test doubles. The separate,
unchanged PostgreSQL suite executes the actual Objective migration and checks its
foreign keys, readiness, tenant RLS, immutable revision lineage, idempotency,
version compare-and-set and transactional revision rollback. These are local
checks, not live database or authenticated HTTP acceptance.

Reproduce with the explicit Node executable and the retained qualification
configs: run `jest.config.cjs` and `jest.baseline-final.config.cjs` with
`--experimental-vm-modules --runInBand`, and `jest.regression.config.cjs` normally.
Run `jest.pg.config.cjs` from `apps/api` with VM modules so its existing migration
path resolves correctly. Use `tsconfig-focused.json` for the focused `tsc --noEmit`
check and `compare-typecheck.cjs` for the exact original/candidate graph comparison.
JSON/log evidence and harness copies are delivered separately under parent task
`outputs/evidence/portfolio-objectives-authorization-20261011/`.

## Limits and remaining owner gates

These are authorization rechecks, not an atomic grant-revocation/write fence.
The test transaction adapter exposes committed SQL changes between awaits; a
production transaction snapshot/isolation level can hide concurrent revocation.
A change can also occur after the final check. Neither canonical helper nor grant
writers acquire a shared lock or embed wall membership in the Objective write
predicate. No stronger guarantee is claimed. If a recheck throws inside the real
`withTenant` transaction, its ordinary transaction error behavior applies; this
suite does not independently establish concurrent live rollback semantics.

Root owns independent review and the PR update. Existing migration allocation,
deployment approval, live designated-service tests and integration remain separate
gates. There were no live reads/writes, provider calls, migration applications or
builds. The broader Objective contracts listed in `objectives-contract.md` remain
unresolved by this security correction.
