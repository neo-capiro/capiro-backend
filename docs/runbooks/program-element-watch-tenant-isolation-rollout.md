# Program Element Watch Tenant-Isolation Rollout

## Purpose

Move `program_element_watch` from the legacy `(user_id, pe_code)` identity to
`(tenant_id, user_id, pe_code)` without moving rows between tenants or making an
old-container rollback unsafe.

The original watch-table migration created `tenant_id` but omitted row-level
security. Phase C corrects that gap in a separate additive migration so the
index-only expansion remains faithful to the expand/contract plan and the RLS
change is independently reviewable.

## Release 1 — Expand schema and establish RLS

1. Run the duplicate preflight from
   `20260728230000_add_tenant_scoped_pe_watch_key/migration.sql`.
2. Apply that migration. It adds only
   `program_element_watch_tenant_user_pe_code_key`.
3. Confirm `program_element_watch_user_pe_code_key` still exists.
4. Apply `20260728230100_enable_program_element_watch_rls/migration.sql`.
5. Confirm the table has RLS enabled and forced.
6. Confirm the only table policy is `program_element_watch_isolation` and its
   `USING`/`WITH CHECK` expression is
   `rls_bypass() OR tenant_id = current_tenant_id()`.
7. Confirm a query without `app.current_tenant` sees zero rows through the
   application role.

The RLS migration aborts when any pre-existing policy is found. PostgreSQL
OR-combines policies, so an unexpected out-of-band policy must be reviewed rather
than silently preserved alongside the canonical policy.

No application behavior changes are required before this release. Old code
already performs watch mutations through `withTenant`; the added RLS policy makes
that boundary fail closed instead of relying only on application predicates.

## Release 2 — Switch code

Deploy the Phase C API and sync-job image. The code:

- reads watches with explicit tenant, user and PE predicates;
- inserts against `(tenant_id, user_id, pe_code)`;
- never updates `tenant_id` to resolve a conflict;
- deletes with tenant, user and PE predicates;
- groups alert recipients by `tenantId:userId`; and
- writes the mutated tenant into the audit record.

While the legacy unique key still exists, adding the same user+PE in a second
tenant is expected to return `409 PE_WATCH_TENANT_KEY_ROLLOUT_PENDING`. That is
a safe temporary state: no existing row is moved or disclosed.

Do not continue until every running API, worker and scheduled sync task uses the
new image SHA.

## Release 3 — Contract schema (separate PR/migration)

Only after the Release 2 live smoke gate:

1. Remove the legacy Prisma declaration
   `@@unique([userId, peCode], map: "program_element_watch_user_pe_code_key")`.
2. Add a new migration that drops only
   `program_element_watch_user_pe_code_key`.
3. Apply it in a disposable database and staging first.
4. Verify one user can hold the same PE watch in two tenants.
5. Verify unwatching tenant A leaves tenant B unchanged.
6. Verify alert preferences and canary eligibility remain tenant-local.

This Phase C implementation PR intentionally does **not** include the contract
migration, because `prisma migrate deploy` would otherwise apply expand and
contract together and eliminate the rollback window.

## Rollback

- Before Release 3, old application code can be restored because both keys exist.
- The RLS correction should remain in place during an application rollback; old
  watch paths already use `withTenant` and should continue to satisfy the policy.
- After Release 3, old application code is unsafe. Recreate the legacy key before
  rollback or roll forward with tenant-aware code.

## Prohibited operations

- Never rewrite `tenant_id` to resolve a duplicate.
- Never delete by user+PE without tenant.
- Never disable or bypass RLS for interactive API paths.
- Never add a second permissive policy without reviewing its combined effect.
- Never drop the legacy key until all old containers are gone.
