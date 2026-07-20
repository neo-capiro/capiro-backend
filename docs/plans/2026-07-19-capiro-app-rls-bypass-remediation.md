# SECURITY REMEDIATION PLAN — `capiro_app` defeats Postgres RLS at runtime

**Date found:** 2026-07-19 (Institutional Memory master-plan execution, Phase 0/1 probing)
**Severity:** High (defense-in-depth regression — NOT an exposed-user vulnerability by itself; see §3)
**Status:** PROPOSED — requires Neo's explicit approval (auth-adjacent role change) + clone rehearsal before any environment applies it.
**Evidence session:** ECS one-off `hermes-memkg-rlsproof`, dev Aurora, task `b395a3f2…` (2026-07-19 19:47 UTC).

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
