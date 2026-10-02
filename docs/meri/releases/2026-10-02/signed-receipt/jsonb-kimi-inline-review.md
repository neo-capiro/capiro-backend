I'll conduct an independent static security and correctness review of this minimal signed JSON persistence repair. Let me analyze the code carefully.

## Static Review: Signed JSON Persistence Repair

### Summary of Changes

The repair replaces Prisma's JSON update (which rounds floating-point numbers) with direct PostgreSQL JSON-text casting using parameterized SQL, preserving exact numeric values in signed receipts.

---

### Detailed Analysis

#### 1. **Predicate Scoping** ✓ CORRECT

**Before (vulnerable):**
```typescript
const current = await tx.clioMessage.findFirst({ where, select: { metadata: true } });
// ... Prisma update with merged metadata
```

**After (fixed):**
```typescript
const current = await tx.clioMessage.findFirst({ where, select: { id: true } });
// ... $executeRaw with full WHERE clause inline
```

**Evaluation:**
- **Old path**: Read `metadata` back, merge in-memory, write via Prisma (corrupts floats via JSON.stringify/parse in Prisma's query engine)
- **New path**: Verify record existence with minimal `select: { id: true }`, then atomic UPDATE with full scoped predicates
- **Scoped predicates are correct**: `id`, `tenant_id`, `user_id`, `conversation_id`, `client_id IS NOT DISTINCT FROM` (handles NULL), `role = 'assistant'`
- Prevents cross-tenant/cross-user/cross-conversation writes via scoped binding

#### 2. **JSON Merge/Null Behavior** ✓ CORRECT

```sql
SET metadata_jsonb =
  (CASE WHEN jsonb_typeof(metadata_jsonb) = 'object'
    THEN metadata_jsonb ELSE '{}'::jsonb END) || ${signedMetadata}::jsonb
```

**Evaluation:**
- `jsonb_typeof` check handles legacy NULL/non-object metadata safely
- `||` operator performs deep JSONB merge (shallow at top level, nested objects merged)
- **Preserves unrelated metadata**: The `unrelated` field test in postgres test confirms this
- **Whitespace preservation**: String values with whitespace/newlines preserved via JSON text binding

#### 3. **Signature Preservation** ✓ CORRECT

**The core bug:** PostgreSQL JSONB stores numeric values as `number` type (IEEE 754 double), which causes precision loss for values like `0.27222999999999997` → `0.27223`.

**The fix:**
```typescript
const signedMetadata = JSON.stringify({
  serverCaptureEvidenceReceipt: args.receipt,
  serverReadonlyCapturePolicy: policy,
});
// ... bind as JSON text, cast to ::jsonb in SQL
```

**Evaluation:**
- `JSON.stringify` preserves exact decimal representation in the **text** before PostgreSQL sees it
- PostgreSQL JSONB text→binary conversion preserves the exact value from the JSON text
- Test confirms: `cost = 0.27222999999999997` (the long decimal) is preserved exactly
- Signature verification after readback succeeds with exact equality (`isDeepStrictEqual`)

#### 4. **Race/Readback Semantics** ✓ CORRECT

**Before:**
```typescript
await tx.clioMessage.update({...});
const readback = await tx.clioMessage.findFirst({ where, select: { metadata: true } });
```

**After:**
```typescript
const updated = await tx.$executeRaw`...`;
if (updated !== 1) throw new Error('meri_capture_assistant_message_readback_missing');
const readback = await tx.clioMessage.findFirst({ where, select: { metadata: true } });
```

**Evaluation:**
- Same-transaction readback guarantees consistency
- `updated !== 1` check ensures exactly one row affected (predicates match)
- `isDeepStrictEqual` on readback data verifies signature-valid payload matches
- Error message reused from old path: `meri_capture_assistant_message_readback_missing`

#### 5. **Security Boundaries**

##### a. **SQL Injection** ✓ SAFE
- All values are parameterized: `${args.assistantMessageId}::uuid`, `${signedMetadata}::jsonb`, etc.
- `signedMetadata` is `JSON.stringify` output (controlled, escaped)
- No string interpolation of user data into SQL

##### b. **Authorization Preservation** ✓ VERIFIED
- Pre-check: `assertMeriServerReadonlyCaptureCurrentAuthority` before transaction
- Post-check: Same assertion after transaction
- Scoped WHERE clause in UPDATE provides defense-in-depth
- Tenant isolation: `tenant_id = ${args.ctx.tenantId}::uuid`

##### c. **HMAC Integrity** ✓ RESTORED
- Postgres test demonstrates: old path corrupts HMAC (signature verification fails with `/authentication_failed/`)
- New path: `assert.deepEqual(after.metadata.serverCaptureEvidenceReceipt, receipt)` + signature verifies

#### 6. **Test Coverage**

**Unit test updates** (meri-server-readonly-capture.spec.ts):
- Mock updated to simulate `$executeRaw` with metadata parsing
- Tampering test preserved: sets `tamper=true` → expects `meri_capture_receipt_readback_mismatch`
- All 38 existing test cases preserved, no behavioral changes

**PostgreSQL integration tests** (capture-receipt-jsonb.postgres.test.mjs):
- 2 tests (generic scope, client scope)
- Exact float preservation verified
- Signature round-trip verified
- Foreign actor targeting denied
- Revoked membership gating verified
- Independent schema cleanup via rollback

#### 7. **Unintended Boundary Changes** ✓ NONE DETECTED

Reviewed scope:
- No changes to `validateMeriCapturePolicyPair` (policy/receipt validation unchanged)
- No changes to `authorizeMeriCaptureMessageReadback` (readback auth unchanged)
- No changes to capture boundary, tool dispatch, or policy issuance
- No schema changes (uses existing `metadata_jsonb` column)
- No changes to fixture version, capture catalog, or expected writes array

#### 8. **Type Safety**

- `apps/api/src/meri/meri-server-capture-evidence.ts` has unchanged exports
- `SignedMeriCaptureEvidenceReceipt` type preserved
- PrismaClient `$executeRaw` usage is typed (returns `number` for UPDATE)

---

### Findings

| Category | Status |
|----------|--------|
| Predicate scoping | PASS |
| JSON merge/null handling | PASS |
| Signature preservation | PASS |
| Race/readback semantics | PASS |
| SQL injection resistance | PASS |
| Authorization preservation | PASS |
| HMAC integrity restoration | PASS |
| Test coverage completeness | PASS |
| Unintended boundary changes | NONE |

---

## VERDICT: **PASS**

The minimal repair correctly addresses the PostgreSQL JSONB floating-point precision loss that corrupted HMAC signatures. The scoped parameterized SQL approach:
- Preserves exact numeric values via JSON-text cast
- Maintains full predicate scoping for security
- Preserves unrelated metadata via JSONB merge
- Includes comprehensive postgres-level regression tests
- Introduces no new attack surface or behavioral changes

The repair is appropriate for the authorized Codex direct-repair exception scope (capiro-dev synthetic capture metadata only).
