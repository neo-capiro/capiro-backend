# Program Element Watch Tenant-Isolation Rollout

## Purpose

Move `program_element_watch` from the legacy `(user_id, pe_code)` identity to
`(tenant_id, user_id, pe_code)` without moving rows between tenants or making an
old-container rollback unsafe.

## Release 1 — Expand schema

1. Run the duplicate preflight from
   `20260728230000_add_tenant_scoped_pe_watch_key/migration.sql`.
2. Apply the migration. It adds `program_element_watch_tenant_user_pe_code_key`.
3. Confirm `program_element_watch_user_pe_code_key` still exists.
4. Confirm the table still has RLS enabled and forced.

No application behavior changes are required before this release.

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
- After Release 3, old application code is unsafe. Recreate the legacy key before
  rollback or roll forward with tenant-aware code.

## Prohibited operations

- Never rewrite `tenant_id` to resolve a duplicate.
- Never delete by user+PE without tenant.
- Never disable or bypass RLS for interactive API paths.
- Never drop the legacy key until all old containers are gone.
