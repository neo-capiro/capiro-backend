# Scheduler receipt boundary repair evidence

## Scope

Branch: `codex/meri-scheduler-boundaries`

Reviewed target: `d87405cae684600c0f16cb80772d730c78065fa3`

Review source: `C:/dev/cap-meri-foundation-evidence/review-scheduler-idempotency-report.md`

Changed only the two approved Meri services, scheduler runner/helper code, focused scheduler tests, and this evidence report. No UI, provider registry, migration, schema, global-admin, source configuration, install, AWS, remote database, provider, or external-network change was made.

## Repaired boundaries

- Quota convergence: after the initial exact receipt lookup, a quota rejection now performs one fresh tenant/user/scope/effect-bound receipt read. The controlled actual-handler interleaving starts with 24 rows, lets invocation A insert task 25, makes invocation B observe count 25, and proves B returns A's original proposal-UUID receipt without a second insert.
- Wall authority: schedule creation and receipt normalization resolve the client and then call the existing `clientMemoryAllowed` authority for the current actor. Same-tenant, non-archived client existence alone no longer authorizes the schedule or its recovery.
- Runner boundary: immediately before execution, the runner fresh-reads the still-enabled owner task and checks the current client plus current actor through `clientMemoryAllowed`. A cancellation after due-list capture remains inactive; revoked wall authority produces `skipped_wall` without research/provider execution.
- Cancellation truth: exact canceled/disabled rows remain valid evidence that historical creation happened, but receipts now state `scheduled:false`, `active:false`, `creationConfirmed:true`, and preserve `enabled`/`lastStatus`. Recovery does not re-enable or create. A canceled same-ID row with mutated effect fields/fingerprint does not converge.
- Proposal authority: the task identity remains the exact server-created proposal UUID. Existing policy-bound proposal fingerprint validation and versioned schedule-effect fingerprint validation remain required. Confirmed historical creation can finalize successfully without falsely describing the task as active; absent, unauthorized, or mismatched evidence remains unknown and is never redispatched.

## Focused application proof

Command run from `apps/api`:

`NODE_OPTIONS=--max-old-space-size=8192 node node_modules/jest/bin/jest.js --runInBand --forceExit --silent src/meri/meri-tools.outcome-reconciliation.spec.ts src/meri/meri-action-proposal.service.spec.ts src/meri/meri-schedule-execution-boundary.spec.ts src/meri/meri-tools.scheduler-postgres.spec.ts`

Result: exit 0; 4 suites passed; 75 tests passed; 0 snapshots.

Regression evidence includes the prior 64 focused tests plus:

- actual-handler quota 24 -> A insert 25 -> B count 25 -> fresh scoped receipt convergence, with one create and 25 total rows;
- current wall denial at creation and after grant revocation during receipt normalization;
- runner current-task/current-wall denial and grant cases through the actual existing wall helper;
- canceled historical receipt wording/state and no create/re-enable;
- canceled same-ID mutated effect rejection;
- action-proposal historical-versus-active result-summary preservation.

## Native PostgreSQL proof

The focused PostgreSQL spec read credentials only at runtime from the private local file, asserted host `127.0.0.1`, port `55433`, a non-empty configured user, and connected-user equality before its first write. It never consulted `DATABASE_URL`, copied credentials, or stored them in the repository. An initial failed identity assertion exposed the configured database user (not the password or connection string) in Jest's diff; the accepted spec compares identity server-side and returns only a boolean so subsequent runs emit no credential value.

It created one random, connection-user-owned `meri_scheduler_*` schema, created only a task-shaped test table in that schema, ran the production `MeriToolsService.scheduleTask` handler through a transparent Prisma-shaped SQL adapter, and dropped the schema afterward. A separate readback reported `ownedSchedulerSchemasRemaining: 0`.

Observed native results:

- two handler calls were held after separate initial reads, then issued two real PostgreSQL inserts for the same proposal UUID;
- one insert committed and one received SQLSTATE `23505` from the real primary key;
- a query attempted inside the failed transaction received SQLSTATE `25P02`, proving the transaction was aborted;
- rollback was followed by a separate transaction/connection scoped read, and both handler calls returned the one original receipt;
- simulated acknowledgement loss was raised only after real COMMIT; the handler fresh-read the committed row and returned it with exactly one stored row and one insert attempt.

This proves the production handler's native PostgreSQL PK/failed-transaction/fresh-read boundary through the documented adapter. It does not claim full Prisma middleware or RLS integration, which was outside the owned disposable schema and allowed scope.

## Other checks and limits

- `git diff --check`: exit 0.
- API TypeScript check reached only pre-existing unrelated diagnostics in `src/business-development/business-development.rls.spec.ts`; no changed-file diagnostic was reported.
- Focused ESLint could not run because the workspace has no resolvable ESLint installation. No package was installed.
- Jest emitted the existing ts-jest TS151002 warning and the expected `--forceExit` notice.
- No full/root test suite was run.
