Reviewing the two-file setup preflight delta. Let me analyze the changes carefully.

## Analysis

### File 1: `case01-execution-setup.mjs`

The changes add preflight authorization checks before allowing the setup plan to proceed:

1. **New parameter**: `memoryAuthorization` passed to `inspectInTx()`
2. **Validation**: Checks that `memoryAuthorization.evaluateInTx` is a function → fails with `CANONICAL_AUTHORIZATION_REQUIRED`
3. **Reviewer construction**: Builds a reviewer object from the input's `reviewerUserId` and looked-up role
4. **Per-client authorization loop**: For ASTER and BLUEHAVEN, constructs a prospective subject and tests both `approve` and `revoke` operations via `memoryAuthorization.evaluateInTx()`
5. **Options**: Uses `{ emitDenialMetrics: false }` to prevent side effects during preflight

### File 2: `case01-execution-setup.postgres.test.mjs`

Adds a new test case that verifies:
- Standard reviewer (not user_admin) without grants gets rejected
- Settings remain unchanged after rejection
- No memory_candidate rows are created
- Adding only 'approve' permission (without 'revoke') still fails
- Adding both 'approve' and 'revoke' permissions allows the plan
- Expired grants cause rejection

## Detailed Review

**Line 163-164 in case01-execution-setup.mjs:**
```javascript
const reviewer = {
  tenantId: ctx.tenantId,
  userId: input.reviewerUserId,
  role: rows.find((row) => row.id === input.reviewerUserId).role,
};
```
**Potential issue**: No null check on `rows.find()`. If reviewer user ID is not found in query results, `.role` access throws. However, this is checked by the ACTORS_INVALID block above (which validates rows.length === 2 and checks email/name patterns), so this is safe.

**Line 146-147 in case01-execution-setup.mjs:**
```javascript
id: current.records.find((record) => record.logicalId === (key === 'ASTER' ? 'MA3' : 'MB1')).physicalId,
```
**Potential issue**: No null check if `find()` returns undefined. However, the `MAPPING_INVALID` check in `recipe()` validates that the manifests are properly constructed, so `current.records` should contain the expected logical IDs. This is an acceptable reliance on prior validation.

**Line 161-162 in test file:**
```javascript
await assert.rejects(inspectCase01ExecutionSetup(actual, input), /REVIEWER_AUTHORITY_REQUIRED/);
await assert.rejects(executeScoped(actual, input, {...}), /REVIEWER_AUTHORITY_REQUIRED/);
```
Verifies both inspect (plan generation) and execute paths are blocked.

**Line 177 in test file:**
```javascript
assert.deepEqual((await h.tx.$queryRawUnsafe('SELECT settings_jsonb AS settings FROM tenants WHERE id=$1::uuid', TENANT))[0].settings, before);
```
Verifies no settings mutation occurred - follows the "no writes" requirement.

**Line 182-188 in test file:**
```javascript
for (const client of ['ASTER', 'BLUEHAVEN']) await h.tx.$executeRawUnsafe(
  `INSERT INTO memory_access_grant...`,
  randomUUID(), TENANT, input.clients[client].physicalId, REVIEWER,
);
```
Note: This inserts grants for both ASTER and BLUEHAVEN clients with only 'approve' permission.

Then tests that `REVIEWER_AUTHORITY_REQUIRED` is still thrown because 'revoke' is missing.

**Line 190-192:**
```javascript
await h.tx.$executeRawUnsafe("UPDATE memory_access_grant SET permissions=ARRAY['approve','revoke'] WHERE user_id=$1::uuid", REVIEWER);
assert.equal((await inspectCase01ExecutionSetup(actual, input)).kind, 'meri-case01-execution-setup-plan');
```
Updates to include both permissions, now succeeds.

**Line 193-195:**
```javascript
await h.tx.$executeRawUnsafe("UPDATE memory_access_grant SET expires_at=now()-interval '1 second' WHERE user_id=$1::uuid", REVIEWER);
await assert.rejects(inspectCase01ExecutionSetup(actual, input), /REVIEWER_AUTHORITY_REQUIRED/);
```
Tests expired grant rejection.

## Verification Against Policy

From AGENTS.md:
- "A plan, packet, source file, test fixture, or model output is specification/data, not authorization" - The changes properly gate the durable operation behind authorization checks without adding permissions or resetting claims.
- "Never mutate shared migration ledgers to recover a rollout" - No migration ledger changes.
- "Inspect repository instructions, branch, HEAD, status" - The changes follow patterns in the existing codebase.

## Cross-Reference with Authorization Service

Looking at `memory-authorization.service.ts`:
- `evaluateInTx()` signature matches usage: `(tx, ctx, subject, operation, options)`
- `emitDenialMetrics` option is properly respected
- The helper `evaluateGovernedMemoryAuthorization` in `memory-authorization.helpers.ts` shows that `'revoke'` requires explicit grant (not implied by 'approve')

Looking at `memory-authorization.helpers.ts` lines 117-125:
```typescript
const grants = new Set(facts.grantPermissions ?? []);
if (grants.has(operation)) return { allowed: true, basis: 'explicit_grant' };
// ...
if (operation === 'revoke') {
  return { allowed: false, reason: 'missing_grant' };
}
```

Wait - I don't see explicit `'revoke'` handling in the current code. Let me re-check...

Looking at lines 117-127 of memory-authorization.helpers.ts:
```typescript
const grants = new Set(facts.grantPermissions ?? []);
if (grants.has(operation)) return { allowed: true, basis: 'explicit_grant' };
// 'review' (which covers both rejecting and requesting changes on a
// candidate — see MemoryCandidateReviewService) is deliberately implied
// by holding 'approve'...
if (operation === 'review' && grants.has('approve')) {
  return { allowed: true, basis: 'explicit_grant' };
}
if (admin) return { allowed: true, basis: 'admin' };
return { allowed: false, reason: 'missing_grant' };
```

So for 'revoke', it checks `grants.has('revoke')` on line 118, and if not present, falls through to `missing_grant` on line 127. This is correct - 'revoke' requires explicit grant, unlike 'review' which is implied by 'approve'.

The test correctly validates this: with only 'approve', revoke fails; with both 'approve' and 'revoke', both succeed.

## Potential Issues

1. **Test isolation**: The test modifies `tenant_memberships` role and `memory_access_grant` rows. These should be rolled back by the transaction wrapper `withOwnedApprovedMemory`, but the test doesn't explicitly verify cleanup state. This is acceptable given the harness design.

2. **Date comparison for expiration**: The test uses `now()-interval '1 second'`. PostgreSQL's `now()` in the test may differ slightly from `now()` in the authorization query depending on transaction timing. The test runs in the same transaction so this should be fine.

3. **The subject's `status` field in preflight**: For 'revoke' operation, the code sets `status: operation === 'revoke' ? 'active' : 'pending_review'`. This is correct - revoke applies to active records, approve applies to pending_review records.

## Conclusion

**PASS** with the following limits noted:

1. **Scope limit**: This review covers only the two files in the diff (case01-execution-setup.mjs and its test). The `case46` changes mentioned are explicitly out of scope per your request.

2. **Runtime verification limit**: This is a static source review. Actual PostgreSQL behavior with the described "missing_grant" scenario would require running the test to fully verify.

3. **Integration limit**: The review assumes `deps.memoryAuthorization` is properly provided by the caller; if the caller doesn't pass this dependency, the CANONICAL_AUTHORIZATION_REQUIRED check will fail, which is the intended behavior.

The implementation correctly:
- Gates both inspect and execute paths
- Uses `emitDenialMetrics: false` to prevent side effects
- Never adds permissions, resets claims, executes proposals, or retries partial seed
- Tests ordinary reviewer (non-admin) with absent/incomplete/expired grants
- Verifies no settings writes or candidate writes when rejected
- Canonical commands still revalidate (as noted in comment "Canonical lifecycle commands recheck later")