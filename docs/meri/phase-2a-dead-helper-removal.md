# Phase 2A: Remove unused Hermes status helper

Candidate base: `06748f1ccdb87b285721d696d6f4551d208fd814`

Candidate branch: `phase2a/meri-dead-helper-20260925`

## Change

Removed the unreferenced `isHermesTerminalStatus` helper and the
`HERMES_WIRE_TERMINAL_STATUSES` set that existed only to support it. The event
translator module remains in place: `MeriHermesRuntimeAdapter` imports and uses
`translateHermesWireEvent`, `hermesCitationsFrame`, and
`hermesCitationsFromRunEvents`.

## Evidence and scope

- Repository-wide exact-symbol search across tracked source/docs found no
  callers of `isHermesTerminalStatus`; the only prior source occurrences were
  its declaration, its constant import/use, and the constant declaration.
- The constant likewise had no other consumers. The helper is a plain function,
  with no Nest decorator, provider registration, route binding, or reflection
  metadata.
- The API package is private (`apps/api/package.json`) and has no published
  `exports`, `main`, or `types` entry. Its build config disables declaration
  output (`apps/api/tsconfig.build.json`), so this helper is not part of a
  generated external type surface.
- Graphy's scoped Meri index marked it as a candidate, not proof. Graphy cannot
  establish dynamic or external consumers; the repository-wide search and
  package/build checks above supplement it. No remaining exact-name dynamic,
  reflection, or import-by-string use was found in the repository.
- No V1/V2/V3 runtime, decorated route/controller, or active translator was
  considered for deletion.

## Verification

- `git diff --check`: passed.
- Repository-wide exact search for both removed symbols: no remaining
  references.
- Focused `meri-hermes-event-translator.spec.ts`: 18/18 passed.
- API typecheck: passed (`PE_PHASE_A_B_SAFETY_OK`, `API_TYPECHECK_PASS`).
- API build: passed (`API_BUILD_PASS`).
- The wider Hermes directory contains DB-backed suites that require a
  disposable local `DATABASE_URL`; this worktree did not have one. Those suites
  were not accepted as product failures and were not run against a shared or
  production database. Seven suites passed and one was skipped in the broader
  attempt; the focused translator suite passed independently.

Rollback is a source revert of this commit. This is a private, unreferenced
utility deletion and does not alter database schema, routes, DI wiring, runtime
state, or release task definitions.
