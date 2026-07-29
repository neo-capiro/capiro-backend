# Program Element Watch Tenant-Isolation Rollout

## Purpose

Move `program_element_watch` from the legacy `(user_id, pe_code)` identity to
`(tenant_id, user_id, pe_code)` without moving rows between tenants or making an
old-container rollback unsafe.

The original watch-table migration created `tenant_id` but omitted row-level
security. Phase C corrects that gap in a separate additive migration so the
index-only expansion remains faithful to the expand/contract plan and the RLS
change is independently reviewable.

## Order matters: the RLS migration must NOT precede the code rollout

Both Phase C migrations are additive, but they are **not** interchangeable in
ordering, and this is the most important operational constraint in this document.

`program_element_watch` is read cross-tenant, on purpose, by the PE alert fan-out:

- `DeltaEngineService.getAffectedTenants`
- `ProgramElementWriterService.getAffectedTenants`
- `BillPeExtractorService.maybeEmit`
- `scripts/send-pe-alert-emails.ts`
- `scripts/diag-program-element-trust-baseline.ts`

`capiro_app` is a plain, NON-`BYPASSRLS` role — it lost its `rds_superuser`
inheritance in the 2026-07-20 role hardening. So once the policy exists, any one of
those reads that is not wrapped in `PrismaService.withSystem` returns **zero rows
with no error**. Each caller treats an empty result as "no tenant watches this PE"
and emits nothing. The failure is silent: no exception, no log line, no metric —
PE alert routing simply stops.

Phase C routes all five call sites through the bypass path. **Pre-Phase-C images do
not have that fix.** Applying the RLS migration while an old image is still serving
therefore silently disables PE alert routing for the whole window.

This matters for the standard deploy chain, which runs the migrate task _before_
rolling the service: for the duration of the roll, RLS is on while the old image is
still serving. Any PE alert job that fires in that window silently drops its
recipients. Either roll the image first, or accept and monitor that window.

Correct order: expand the index, roll the code, retire every old task definition,
and only then enable RLS.

## Release 1 — Expand schema (index only)

1. Run the duplicate preflight from
   `20260728230000_add_tenant_scoped_pe_watch_key/migration.sql`.
2. Apply that migration. It adds only
   `program_element_watch_tenant_user_pe_code_key`.
3. Confirm `program_element_watch_user_pe_code_key` still exists.

This release is safe with old containers online: they still resolve conflicts on
the legacy key, which is untouched, and no policy exists yet.

## Release 2 — Switch code

Deploy the Phase C API and sync-job image. The code:

- reads watches with explicit tenant, user and PE predicates;
- inserts against `(tenant_id, user_id, pe_code)`;
- never updates `tenant_id` to resolve a conflict;
- deletes with tenant, user and PE predicates;
- groups alert recipients by `tenantId:userId`;
- writes the mutated tenant into the audit record; and
- reads the cross-tenant alert fan-out through `withSystem` (the bypass path), so
  it behaves identically before and after the RLS migration.

While the legacy unique key still exists, adding the same user+PE in a second
tenant is expected to return `409 PE_WATCH_TENANT_KEY_ROLLOUT_PENDING`. That is
a safe temporary state: no existing row is moved or disclosed.

Do not continue until every running API, worker and scheduled sync task uses the
new image SHA. Confirm with `aws ecs describe-services` / `describe-tasks` that no
task is still running a pre-Phase-C task-definition revision, and that the
scheduled EventBridge targets point at the new revision.

## Release 2b — Enable RLS (only after Release 2 is fully rolled out)

1. Re-confirm no pre-Phase-C task definition is still running (see above).
2. Apply `20260728230100_enable_program_element_watch_rls/migration.sql`.
3. Confirm the table has RLS enabled and forced.
4. Confirm the only table policy is `program_element_watch_isolation` and its
   `USING`/`WITH CHECK` expression is
   `rls_bypass() OR tenant_id = current_tenant_id()`.
5. Confirm a query without `app.current_tenant` sees zero rows through the
   application role.
6. Confirm PE alert routing still works: a bypass-context read must still see every
   tenant's watches. Verify an alert is emitted for a tenant whose ONLY signal is a
   watch (no client capability, no relevance match) — that is the exact case a
   missing bypass silently drops.

The RLS migration aborts when any pre-existing policy is found. PostgreSQL
OR-combines policies, so an unexpected out-of-band policy must be reviewed rather
than silently preserved alongside the canonical policy.

Rehearse both migrations and the policy behaviour first with
`apps/api/scripts/pe-phase-c-rls-rehearsal.sh` against a disposable PostgreSQL 16
database. It asserts 23 checks, including that the fan-out read returns zero rows
without the bypass GUC and full cross-tenant reach with it.

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
- **An application rollback past Phase C is only safe if the RLS policy is dropped
  in the same operation.** Old images read the alert fan-out without the bypass
  path, so leaving `program_element_watch_isolation` in place while serving a
  pre-Phase-C image silently stops PE alert routing (see "Order matters" above).
  Interactive watch read/write paths keep working — they already use `withTenant` —
  so the failure is invisible from the UI. To roll application code back before
  Release 3, either roll back only as far as Phase C, or drop the policy in the same
  operation and re-apply the RLS migration when rolling forward:

```sql
DROP POLICY "program_element_watch_isolation" ON "program_element_watch";
ALTER TABLE "program_element_watch" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "program_element_watch" DISABLE ROW LEVEL SECURITY;
```

- After Release 3, old application code is unsafe. Recreate the legacy key before
  rollback or roll forward with tenant-aware code.

## Prohibited operations

- Never rewrite `tenant_id` to resolve a duplicate.
- Never delete by user+PE without tenant.
- Never disable or bypass RLS for interactive API paths.
- Never add a second permissive policy without reviewing its combined effect.
- Never drop the legacy key until all old containers are gone.
- Never apply the RLS migration before the Phase C image is fully rolled out.
- Never add a new `program_element_watch` read outside `withTenant`/`withTenantUser`
  (tenant-scoped paths) or `withSystem` (deliberate cross-tenant fan-out). A
  `// tenant-scope-exempt:` comment silences the static guard but does **not** bypass
  the policy, so the read fails closed and returns zero rows.
