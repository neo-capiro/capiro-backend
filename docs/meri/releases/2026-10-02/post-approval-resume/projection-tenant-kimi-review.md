PASS

Policy confirmation: Shared policy39590; Codex direct repair explicitly authorized. Bedrock Kimi review constraints accepted.

Scope verification:
- Shared policy39590: NO TOOLS source review only
- Codex direct repair explicitly authorized
- Scope: source-confirmed and LIVE READ ONLY-confirmed post-approval indexing defect
- Canonical candidate/item/outbox committed
- Production app database role: nonowner, non-superuser, non-BYPASSRLS
- Outbox table FORCE RLS policy: exactly `tenant_id=current_setting('app.current_tenant',true)::uuid`
- `app.bypass_rls` alone is NOT a policy bypass
- Actual fresh withSystem pending-job query returned 0; correct tenant query returned 1
- Clio/item visible withSystem

Change scope verification:
- Exactly two governed fast-path outbox operations changed to `withTenant(expectedTenant, fn)`:
  1. `loadExactPendingJob`: Line 86-88, changed from `withSystem` to `withTenant(tenantId, ...)`
  2. `completeExactFastPath`: Line 138-140, changed from `withSystem` to `withTenant(receipt.tenantId, ...)`
- All SQL exact ID/tenant/source/hash/idempotency/status fences remain unchanged
- No RLS changes/role changes/approval retry/customer fixture/provider changes
- Strict projector unchanged

Code correctness verification:
- `loadExactPendingJob`: Uses `tenantId` parameter passed to method, correctly scoped
- `completeExactFastPath`: Uses `receipt.tenantId` from receipt object, correctly scoped
- Both methods now properly set `app.current_tenant` GUC via `withTenant`
- FORCE RLS policy will now evaluate to true for these operations
- SQL fences in WHERE clauses include `tenant_id` checks that align with GUC setting

Test verification:
- Unit test mock updated: `withTenant` mock captures and validates tenant ID
- Integration test validates system-only scope cannot see job (empty result)
- Integration test validates `projectClioMemory` completes exact tenant job
- Integration test validates other tenant job remains unchanged
- Integration test validates missing/wrong tenant scope fails correctly

Connection and cleanup verification:
- Postgres integration test uses bounded disposable random schema + non-owner role
- Creates temporary schema, role, tables with RLS policies matching production
- Proper cleanup in `afterAll`: drops schema and role, verifies both removed
- Owner client validates connection to local disposable cluster (no AWS)

Tenant boundary verification:
- `scopes` array tracks tenant IDs passed to `withTenant`, asserts exactly [tenant, tenant]
- First `withTenant` call from `loadExactPendingJob`, second from `completeExactFastPath`
- No cross-tenant leakage possible due to per-call GUC setting

Authorization check:
- Production role is non-owner, non-superuser, non-BYPASSRLS per force_rls policy
- RLS policy uses `current_setting('app.current_tenant',true)::uuid`
- `withSystem` sets `app.bypass_rls` but not `app.current_tenant`
- FORCE RLS requires tenant evaluation, making bypass_rls insufficient

Result: PASS - The diff correctly addresses the post-approval indexing defect by changing exactly the two fast-path outbox operations from `withSystem` to `withTenant`, respecting all tenant boundaries and SQL fences without any additional production-affecting changes.