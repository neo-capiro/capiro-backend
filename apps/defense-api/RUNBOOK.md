# Defense API Session 2 runbook

## Dark start

```bash
DEFENSE_CUTOVER_MODE=dark \
DEFENSE_SERVE_DB_ROLE=capiro_defense_serve \
bash apps/defense-api/scripts/entrypoint.sh serve
```

No public ALB rule or legacy route ownership is changed.

## Readiness interpretation

| Mode | DB/config/role | Active snapshot | Result |
|---|---|---|---|
| dark | healthy | absent | 200, domain unavailable |
| dark | unhealthy | any | 503 |
| strict | healthy | absent | 503 |
| strict | healthy | present | 200 |

## Database roles

`capiro_defense_serve` and `capiro_defense_job` are NOLOGIN capability roles.
Deployment creates/rotates login roles and grants membership separately.
Neither capability role may own schema objects, bypass RLS, or activate snapshots.

**Login-level timeouts are not automatic.** `ALTER ROLE capiro_defense_serve
SET statement_timeout = ...` in the migration only takes effect for a session
that authenticates *as* `capiro_defense_serve` directly. PostgreSQL applies
role-specific session defaults based on the role used to log in, not roles it
inherits from — a login role that is merely a *member* of
`capiro_defense_serve` does **not** automatically receive these settings.
Whatever process creates/rotates the real login role
(`capiro_defense_serve_login` or similar) must apply the same
`ALTER ROLE <login> SET statement_timeout/lock_timeout/idle_in_transaction_session_timeout`
directly to that login. `scripts/verify-phase8-session2-db.sh` proves this
distinction and asserts it against a fresh connection as the rehearsal login,
not via `SET ROLE` from a superuser.

Tenant/membership resolution before `app.current_tenant` is known goes through
three narrow SECURITY DEFINER functions
(`capiro_defense_resolve_tenant_by_clerk_org`, `capiro_defense_resolve_tenant_by_id`,
`capiro_defense_has_active_membership`), not a generic RLS-bypass method —
`apps/defense-api/src/prisma/prisma.service.ts` has no `withSystem()`.

## Rehearsal

```bash
pnpm verify:phase8-session2:db
```

This runs `scripts/verify-phase8-session2-db.sh`, which starts a disposable
`pgvector/pgvector:pg16` container (or uses `REHEARSAL_DATABASE_URL` if
already set, e.g. a CI service container), applies the full migration ledger
from empty, creates real serve/job/main-api login roles with production-shape
grants, seeds two tenants and minimal Program Elements fixtures, and proves —
with a nonzero exit on any failure — migration-from-zero, capability-role and
real-login safety, the SECURITY DEFINER tenant functions, own/foreign tenant
RLS reads and writes, the serve/job table boundary, that neither role can
create objects/migrate/promote/activate a snapshot, that the parser plane has
no database role, and a guarded main-api cutover-revocation rehearsal — before
finally running `apps/defense-api`'s own database-backed test suite against
the same database. It also destroys the container it started on exit.

Do not run `cutover-revoke-main-api.sql` outside this disposable rehearsal
until the later canary/cutover workstream is explicitly authorized.
