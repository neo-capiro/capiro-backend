Synthetic fullChat workflow implementation report

Status

Implemented code/offline only on `codex/meri-synthetic-fullchat`, based on `8ca56777e1557b4407fae4c2a3f7a84acc6da728`. No GitHub dispatch, AWS call, remote database call, deploy, migration, image build, IAM/network change, push, or merge was performed.

Reviewed inputs

- `C:/Users/Administrator/Documents/Codex/2026-09-28/goal-execute-the-entire-file-untill/outputs/synthetic-meri-enablement.json`: `APPROVED_NOT_APPLIED`; exact two tenant UUID/slug pairs; literal `settings.clioFeatureFlags.meriv3.fullChat`; prior state recorded as absent; separate cohort/environment rollback requirements.
- Existing guarded cohort implementation: `.github/workflows/meri-synthetic-cohort.yml`, `scripts/meri-synthetic-cohort.py`, and `scripts/meri-synthetic-cohort.test.py`.
- Existing command owner/runtime: `apps/api/scripts/set-tenant-flag.ts`, `apps/api/scripts/entrypoint-dispatcher.inc`, `apps/api/scripts/entrypoint.sh`, `apps/api/scripts/entrypoint-legacy.sh`, and `apps/api/Dockerfile`.
- Existing RLS policy/function source: `apps/api/prisma/migrations/20260501000000_init_identity_tenancy/migration.sql`.
- `evidence/review-cohort-final-report.md` was not present in the assigned worktree, repository history path search, or the supplied original-task directory. No substitute contents were invented.

Implemented slice

1. Fixed command mode

`apps/api/scripts/set-tenant-flag.ts` retains the existing generic `--slug/--flag/--value [--commit]` behavior and dispatcher route. A separate opt-in `--foundation-fullchat` mode delegates to `set-tenant-flag-foundation.ts`.

The fixed mode accepts no slug, UUID, flag, shell, script, URL, task-definition, image, or database target. It binds only:

- `f2d6cf8f-057c-479a-8110-62fe5086d43f` / `meri-foundation-20260928-t1`
- `52e91176-08f0-4d89-9633-bc212f5bdbbf` / `meri-foundation-20260928-t2`
- literal key `clioFeatureFlags['meriv3.fullChat']`

Plan is the default. Apply and rollback require their exact confirmations and receipt-derived canonical state token.

2. Transaction/readback behavior

The fixed mode uses one serializable transaction for both rows. Each lock/update/readback resets `app.bypass_rls=off`, sets `app.current_tenant` to the exact UUID, and predicates on exact UUID+slug. It uses `FOR UPDATE`, compares prior flag presence/value, and mutates only the JSONB path under `clioFeatureFlags`.

Apply sets JSON boolean `true`. Rollback restores the exact captured flag state: absent, false, or another prior JSON value. It never captures or emits the surrounding settings document. Exact prior state is accepted as an already-completed rollback reconciliation; a third state fails closed.

3. Guarded Actions runner

`.github/workflows/meri-synthetic-fullchat.yml` and `scripts/meri-synthetic-fullchat.py` provide separate plan/apply/rollback flow. Apply consumes one exact successful plan artifact; rollback consumes one exact successful apply artifact. GitHub run attempt, workflow/repository/main SHA, actor, artifact ID/name/timestamps, and archive SHA-256 are bound before use.

The runner accepts no arbitrary operational target. It discovers the fixed current API service and latest fixed `capiro-dev-api-diag` family, then requires:

- fixed account `967807252336`, region `us-east-1`, cluster `capiro-dev`;
- current complete merged `origin/main` checkout;
- one currently served immutable API digest;
- one-off image pinned to that same digest and source commit;
- source commit present in current main history and containing the fixed command implementation;
- no task-definition entrypoint override;
- unchanged served API task/execution roles;
- only the same served API DB_HOST/DB_PORT/DB_USER/DB_PASSWORD references and DB_NAME;
- existing API service network configuration;
- task exit code zero and exactly one sanitized CloudWatch DB result.

A lost `RunTask` acknowledgement is reconciled once through the unique fixed `startedBy` identity. The runner never sends a second `RunTask`; zero or multiple matches fail closed.

4. Independent cohort hold

The existing cohort workflow and runner were not modified. The new runbook keeps fullChat flag receipts, active-research drain, cohort release, database recovery, and rollback as separate controls. A fullChat receipt does not satisfy or weaken `LEAD_CONFIRMED_DB_FLAGS_AND_RESEARCH_DRAIN`.

Verification executed

PASS — existing cohort offline suite:

`python scripts/meri-synthetic-cohort.test.py`

Result: 28 tests passed, including drift, mutation ordering, rollback artifact binding, final authoritative readback, and accepted-update/lost-response reconciliation.

PASS — new fullChat runner suite:

`python scripts/meri-synthetic-fullchat.test.py`

Result: 11 tests passed, covering fixed commands/no arbitrary targets, sanitized exact readback, absent/false/prior rollback distinctions, artifact/run-attempt binding, runtime image/role/credential/entrypoint guards, ambiguous acknowledgement without retry, generic command compatibility, and independent cohort hold.

PASS — Python syntax:

`python -m py_compile scripts/meri-synthetic-cohort.py scripts/meri-synthetic-fullchat.py scripts/meri-synthetic-fullchat.test.py`

PASS — TypeScript syntax/transformation with an already-cached esbuild binary (no install/network):

- `apps/api/scripts/set-tenant-flag.ts` and imported fixed-mode module
- `apps/api/scripts/set-tenant-flag-foundation.test.ts` and imported fixed-mode module

PASS — native PostgreSQL-engine RLS/JSONB transaction probe using already-cached PGlite (no install/network):

`node C:/ProgramData/Hermes/profiles/meri-foundation-memory-ui/cache/scratch/foundation-fullchat-pglite.mjs`

Result: `PASS native PGlite RLS tenant-GUC apply/rollback preserves unrelated JSONB and restores absent/false`.

The probe used a FORCE-RLS `tenants` table, a non-owner application role, `app.current_tenant`, exact UUID+slug locks, the implementation's JSONB compare/update/remove statements, both tenants in transactions, and a concurrent unrelated settings mutation between apply and rollback.

PASS — final `git diff --check` after the evidence file was present.

Not run / remaining qualification

- `pnpm run test`, `pnpm run lint`, `pnpm run typecheck`, and `pnpm run build`: NOT RUN. This worktree has no installed package dependencies; `pnpm ... exec tsx` returned `Command "tsx" not found`. Installation/network use was prohibited. The checked-in TypeScript PGlite qualification is `apps/api/scripts/set-tenant-flag-foundation.test.ts` for an installed CI/worktree.
- Approved merged API image build and immutable digest qualification: NOT RUN. The workflow intentionally refuses an old/same image that does not prove this command exists in its merged source.
- Live `capiro-dev-api-diag` task-definition qualification: NOT RUN.
- Actions runtime permissions: NOT RUN. Existing permissions must already allow bounded ECS describe/run for `capiro-dev-api-diag`, pass the unchanged API roles, and read the existing CloudWatch stream. This slice creates no IAM grant and has no direct-SQL fallback.
- Live database plan/apply/rollback and GitHub workflow dispatch: NOT RUN.
- Provider/research/user actions: NOT RUN.

Approval

The supplied approval is treated as existing approval for only these two synthetic tenants and this flag path. No new permission request is made by this implementation.
