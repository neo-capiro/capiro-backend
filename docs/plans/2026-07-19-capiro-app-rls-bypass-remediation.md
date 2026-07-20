# SECURITY REMEDIATION PLAN — `capiro_app` defeats Postgres RLS at runtime

**Date found:** 2026-07-19 (Institutional Memory master-plan execution, Phase 0/1 probing)
**Severity:** High (defense-in-depth regression — NOT an exposed-user vulnerability by itself; see §3)
**Status:** APPROVED by Neo for dev (2026-07-19, after Neo confirmed a real past cross-tenant leak from master-privileged connections) — dev execution record in §6. Prod remains separately gated (scheduled window + explicit go).
**Evidence session:** ECS one-off `hermes-memkg-rlsproof`, dev Aurora, task `b395a3f2…` (2026-07-19 19:47 UTC); root cause isolated by `hermes-memkg-rlsmech` (see §6.1).

## 1. The finding (dev-proven, primary evidence)

Connected as `capiro_master`, then `SET ROLE capiro_app` (the live application role), **no GUCs set**:

| Probe | Expected if RLS fired | Observed |
|---|---|---|
| `SELECT count(*) FROM clio_memory` (no `app.current_tenant`) | 0 | **857 — every tenant's rows** |
| `SELECT count(*) FROM memory_items` (no GUCs) | 0 | **7,680 — every tenant's rows** |
| Catalog: `clio_memory`/`memory_items`/`context_embeddings`/`clients`/`tenants` | — | all `ENABLE`d + `FORCE`d, policies present |
| `pg_roles`: `capiro_app` | — | `rolbypassrls = f`, `rolsuper = f`, **member of `capiro_master`** (the owner of most tables; `memory_items` is owned by `capiro_app` itself) |

Conclusion: every RLS policy on the memory tables (tenant isolation, 1C owner-scope, expiry, and the new wall policies) is **inert for the live app connection**. The `prisma.service.ts:59-79` comment ("capiro_app … BYPASSES Postgres RLS … the 2026-07-16 incident") describes runtime reality; the mechanism is owner-privilege via role membership, not `BYPASSRLS`.

## 2. Why the docs disagreed (for the record)

- Migration texts (`20260705120100`, `20260712030000`, `20260713030000`) say "fail-closed at the DB layer" — true only for non-owner roles.
- `prisma.service.ts:172-183` says `withTenantUser` is "required" for RLS policies referencing `current_user_id()` — forward-true, runtime-false today.
- The master plan's live probe verified policies **exist**; existence ≠ firing for this role. The master plan should be read with this correction (ledger updated accordingly).

## 3. Actual exposure

- **No direct user-facing hole is known:** the application enforces isolation in-query (`applyTenantScope` hook forcing `where.tenantId`, manual predicates in raw SQL, `tenant-scope-guard.spec.ts` CI guard). The 2026-07-16 incident showed what happens when that single layer slips.
- The regression is architectural: the product's stated guarantee ("private scopes are database-enforced" — blueprint gate §12.5#1, marked shipped with 1C) is **not currently true at runtime**. All isolation is one code-review away from a repeat incident.
- New ethical walls (2026-07-19) are therefore enforced app-side (primary) with RLS shipped forward-ready.

## 4. Remediation (proposed, in order)

1. **Grant audit (read-only, no approval needed):** enumerate `capiro_app`'s effective privileges per table; diff against what it would retain after losing `capiro_master` membership (`information_schema.role_table_grants WHERE grantee='capiro_app'`). Several migrations already GRANT explicitly (e.g. `clio_memory`, `client_memory_access`); most tables likely rely on inherited owner privilege.
2. **Author a grants migration:** explicit `GRANT SELECT/INSERT/UPDATE/DELETE ON <each app table> TO capiro_app` (+ `USAGE` on sequences, `EXECUTE` on functions as needed) so the app keeps working without owner inheritance. Idempotent DO-block style, per house pattern.
3. **The role change (Neo-gated):** `REVOKE capiro_master FROM capiro_app;` — after which `FORCE ROW LEVEL SECURITY` + existing policies bind the app connection. NOTE: `memory_items` is owned by `capiro_app` itself; FORCE already targets owners, so it binds once membership stops short-circuiting… verify per-table in rehearsal; if owner-ship itself proves to be the defeat vector for that table, `ALTER TABLE memory_items OWNER TO capiro_master` first.
4. **Clone rehearsal (mandatory):** Aurora copy-on-write clone; run the full API smoke + nightly-job dry-runs against the clone with the revoked role; the failure mode to hunt is a code path that relied on inherited privilege (would now error `permission denied`) or on RLS *not* firing (would now return 0 rows — exactly the 1C caller-conversion class of bug).
5. **Behavioral re-probe (the acceptance test):** re-run `hermes-memkg-rlsproof`; expected: bare counts = **0**, tenant-GUC count = that tenant's rows only, walled-client rows absent without a grant.
6. **Prod:** scheduled window + explicit go, standard discipline.

## 5. Interim posture (until remediation lands)

- Treat the in-query tenant-scope hook + explicit predicates + the new wall helpers as THE enforcement; `tenant-scope-guard.spec.ts` and `memory-wall-fail-closed.spec.ts` are the CI tripwires protecting them.
- Any new tenant-scoped table/raw query MUST ship with app-side predicates regardless of its RLS policy.
- Do not represent private-scope or wall enforcement as "database-enforced" in product/marketing claims until §4.5 passes.

## 6. Dev execution record (2026-07-19)

### 6.1 Root cause CORRECTED — it is an Aurora rds_superuser exemption, not owner-privilege

The §1 hypothesis ("owner-privilege via membership") did not survive contact with the
policy evidence: all 95 RLS tables are ENABLE+FORCE (FORCE binds owners in vanilla
Postgres), every policy is `rls_bypass() OR <tenant predicate>`, `rls_bypass()` is
`current_setting('app.bypass_rls', true) = 'on'` (NULL in a bare session), and
`row_security = on` — so vanilla Postgres would have filtered everything. Yet a bare
`SET ROLE capiro_app` read every row with **no policy Filter in the EXPLAIN plan**.

Controlled experiment (`hermes-memkg-rlsmech`, throwaway roles, created + dropped same day):
| role | grants | result |
|---|---|---|
| `rls_probe_plain` | direct SELECT on clio_memory + memory_items, no memberships | **0 rows, policy Filter present** (RLS works, incl. FORCE on the then-capiro_app-owned memory_items) |
| `rls_probe_rdssu` | member of `rds_superuser` ONLY (not capiro_master) | **857/7,680 rows, no Filter** |

→ **Aurora PostgreSQL 16.11 (aurora_version 16.11.2) exempts any role holding
`rds_superuser` privileges from RLS**, regardless of `rolbypassrls=f` and FORCE.
`capiro_app` held them transitively: capiro_app → capiro_master → rds_superuser.
The REVOKE in §4.3 is still the correct fix — it breaks that chain.

### 6.2 Grant audit results (§4.1 — read-only, `hermes-memkg-grantaudit`)

- **Zero at-risk relations.** All 226 public relations either carry direct
  `arwdDxt` grants to capiro_app (via `pg_default_acl` from capiro_master) or were
  owned by capiro_app itself (24 legacy tables: `intel_*`, `memory_items`,
  `memory_edges`, `document_parse_job`). Schema USAGE+CREATE, database CONNECT and
  the one function EXECUTE are directly granted. No sequences exist.
- **Migrations are unaffected:** the `capiro-dev-api-admin-migrate` task def (and the
  api service's DB_HOST sibling) runs `prisma migrate deploy` as **capiro_master**,
  not capiro_app. Historical DDL on capiro_app-owned tables worked via the same
  Aurora rds_superuser power, and keeps working.
- **Fleet inventory:** api, intel-api, onboard-api, meriv2-orchestrator and workspace
  all connect as capiro_app (`/capiro/dev/aurora/app` secret) and all implement the
  withTenant/withTenantUser/withSystem GUC contract; scratch-DB CI has always
  exercised RLS in its *firing* state (plain capiro_app role), so the fleet's
  behavior under live RLS is the tested configuration.

### 6.3 What was executed (runbook: `scripts/sql/2026-07-19-rls-role-hardening.sql`)

Executed as capiro_master via the `capiro-dev-dbadmin-oneoff:2` ECS one-off:
1. `ALTER TABLE ... OWNER TO capiro_master` for the 24 capiro_app-owned tables
   (the runtime role must not own tables — an owner can DISABLE ROW LEVEL SECURITY).
2. Blanket idempotent `GRANT ALL ON ALL TABLES` / sequences to capiro_app
   (restores CRUD on the transferred tables; no-op elsewhere).
3. `REVOKE capiro_master FROM capiro_app` — the fix.
4. `GRANT capiro_app TO capiro_master` (after the revoke; one-directional, lets
   admin tooling SET ROLE capiro_app for behavioral probes).

Acceptance (§4.5) results are recorded in the execution ledger
(`Institutional Memory & Knowledge Graph — Execution Ledger.md`).

### 6.4 Residual notes

- `app.bypass_rls` remains the deliberate withSystem escape hatch; it is
  transaction-local (`SET LOCAL`) and only reachable from code that can already
  execute arbitrary SQL. Acceptable, documented.
- The 4 `capiro_master`-owned views (`kg_*`, `lobby_issue_ref_v`) run with definer
  semantics (owner = capiro_master → rds_superuser → RLS-exempt underneath). Same
  behavior as before the fix (no regression), but view-path queries are NOT
  DB-enforced; callers keep their explicit tenant predicates. Follow-up candidate:
  `ALTER VIEW ... SET (security_invoker = true)` after auditing view callers.
- Scratch-DB migrations create capiro_app WITHOUT the capiro_master membership, so
  test databases never had the bypass and need no equivalent of this runbook.
