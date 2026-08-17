# Phase 8 Session 2 — Defense API dark scaffold and database boundary

## Scope

Session 2 implements Workstreams C and D only. It creates an independently
bootable dark `defense-api` and an additive least-privilege database capability
boundary. It does not move public routes, jobs, schedules, traffic, data, or
canonical promotion.

## Workstream C

- Nest application at `apps/defense-api`
- shared Clerk verification and canonical tenant/membership resolver, backed
  by three narrow SECURITY DEFINER database functions rather than a generic
  RLS-bypass method on the Prisma service (see Workstream D)
- request ID and trace-context capture
- HMAC internal-service authentication with body binding, timestamp window,
  caller allowlist, nonce replay protection, and timing-safe comparison
- `/healthz` process liveness
- `/readyz`: config validity, a full login-safety check (not just capability-role
  membership — see Workstream D), and the active-snapshot pointer for the
  configured `(domain, environment)` joined to its canonical snapshot and
  checked for `status = 'ACTIVE'`, using the same `PE_SNAPSHOT_ENVIRONMENT` /
  `NODE_ENV` resolution convention as the canonical read path
  (`PeSnapshotGateService.environment()` in `apps/api`)
- dark/strict readiness modes
- custom generated Prisma client with no independent migration ledger
- bounded HTTP body size, strict validation, graceful shutdown
- non-root Node 20 Bookworm container with no GPU/parser/promoter dependency
- entrypoint refusing migration, promotion, activation, parsing, and benchmark
  modes

## Workstream D

- `capiro_defense_serve`: NOLOGIN, NOBYPASSRLS capability role
- `capiro_defense_job`: NOLOGIN, NOBYPASSRLS capability role
- explicit read/write relation lists; `tenants`/`users`/`tenant_memberships`
  are deliberately absent from them — those FORCE-RLS-protected tables are
  reachable only through the three SECURITY DEFINER functions below
- three narrow SECURITY DEFINER functions (`capiro_defense_resolve_tenant_by_clerk_org`,
  `capiro_defense_resolve_tenant_by_id`, `capiro_defense_has_active_membership`):
  locked `search_path`, fixed shape, minimum fields, no caller-supplied SQL,
  `EXECUTE` revoked from `PUBLIC` and granted only to `capiro_defense_serve`
- active-snapshot pointer is SELECT-only for serve (plus SELECT on the
  canonical snapshot it joins to) and inaccessible for job
- no schema CREATE, DDL, migration-ledger, or promotion authority
- `/readyz`'s role check verifies the actual login has no SUPERUSER, BYPASSRLS,
  CREATEDB, CREATEROLE, schema CREATE, promoter-role membership,
  active-snapshot mutation authority, or unexpected direct grants — not just
  capability-role membership
- `scripts/verify-phase8-session2-db.sh`: a deterministic disposable-database
  harness (migration-from-zero, real serve/job/main-api logins with production
  grants, two-tenant fixtures, RLS positive/negative controls, table-boundary
  positive/negative controls, a guarded main-api cutover rehearsal, and a check
  that no parser database role exists) — 36 checks, all passing, invoked via
  `pnpm verify:phase8-session2:db`
- guarded future cutover script; rehearsed only inside the disposable database,
  never applied in Session 2 or against any shared database
- schema subset manifest and CI gates

## Truth-freeze posture

The service may be deployed dark only. An absent active canonical snapshot is
reported as `domainAvailability: unavailable`. Strict readiness and any public
ownership cutover remain blocked until the truth freeze is accepted.

## No mutations performed

No AWS, shared database, production data, ALB routing, EventBridge schedule,
secret, IAM, or canonical snapshot mutation is part of this implementation.
