I'll review this bounded increment for the case46 readback feature. Let me analyze the provided source files carefully.

## Review Summary

**Overall Assessment: PASS**

The increment correctly implements authenticated GET admission/readback for case46 while stripping private signed capture binding from public conversation DTOs. The authority/effect joins, transaction locking, and DTO boundaries are properly handled.

---

## Concrete Findings

### 1. **Authority/Effect Joins - CORRECT**

**File:** `meri-case46-capture-readback.ts:82-130`

The `inspect()` function correctly joins:
- `readCase46BoundAuthorityInTx()` for current source + parent lock (line 86)
- Raw SQL queries with `FOR SHARE` for messages, proposals, artifacts (lines 88-108)
- `assertTextArtifactCurrentProposal()` for proposal→artifact action verification (line 128)

The join order matches reservation/proposal/effect locking as noted in the comment on line 87.

### 2. **Transaction Locking - CORRECT**

**File:** `meri-case46-capture-readback.ts:88-108`

All readback queries use `FOR SHARE`:
- `clio_messages` with tenant/conversation filter, ordered by `created_at,id` (line 90)
- `meri_action_proposals` ordered by `id` (line 94)
- `clio_artifacts` ordered by `id` (line 98)

This is consistent with the governing policy's lock order and prevents duplicate readback races.

### 3. **DTO Leak Prevention - CORRECT**

**File:** `meri-case46-capture-readback.ts:36-44`

```typescript
export function publicCase46ConversationMetadata<T>(value: T): T {
  const metadata = case46Record(value);
  const binding = metadata[CASE46_BINDING_KEY];
  if (binding === undefined) return value;
  return { ...metadata, [CASE46_BINDING_KEY]: { version: 1, bindingSha256: case46BudgetHash(binding) } } as T;
}
```

The function correctly:
- Returns original value when no binding exists (preserves ordinary behavior)
- Replaces full `sealedPolicy` (MAC + encrypted transport) with only `bindingSha256`
- Never exposes `sealedPolicy` or `qualification` in public response

**Test verification** at `meri-case46-capture-readback.spec.ts:35-36`:
```typescript
expect(JSON.stringify(publicCase46ConversationMetadata(metadata))).not.toContain('test-private-mac');
```

### 4. **Ordinary Fallback Behavior - CORRECT**

**File:** `meri.service.ts:464-467` (getConversation dispatch)

```typescript
const captureAdmission =
  (await readCase46CaptureAdmission({ ... })) ??
  (await readMeriControlledCaptureAdmission({ ... })) ??
  (await readMeriCase14CaptureAdmission({ ... })) ??
  (await readMeriCase01CaptureAdmission({ ... }));
```

Case46 dispatches **first** (as required), falls through to existing readonly bindings only when case46 returns `null`.

**File:** `meri-case46-capture-readback.ts:56-57`
```typescript
if (!bound(input)) return null;
```

Returns `null` for non-case46 conversations, enabling proper fallback.

### 5. **Test Assertions - VERIFIED**

**Unit tests** (`meri-case46-capture-readback.spec.ts`):
- DTO stripping verified (lines 31-42)
- Dispatch order verified (lines 43-58)
- Fallback chain verified (lines 59-71)
- All service callsites apply `publicCase46ConversationMetadata` (lines 72-95)
- Message readback attaches only current server readback (lines 96-107)

**Integration tests** (`case46-provider-budget.postgres.test.mjs:447-535`):
- Actual PG readback joins saved usage, canonical approval, exact bytes (line 447)
- `attemptCount: 2` is explicitly allowed (line 512: "Two attempts may still produce exactly one effect")
- Rejects changed served body, changed metadata, changed usage (lines 502-507)
- Rejects tampered approval fields (lines 513-520)

### 6. **Authorization Gate - CORRECT**

**File:** `meri-case46-capture-readback.ts:50-54`

```typescript
function bound(input: Input): boolean {
  return input.ctx.tenantId === f.tenantId && input.ctx.userId === f.actorUserId
    && case46Record(input.conversationMetadata)[CASE46_BINDING_KEY] !== undefined;
}
```

Strict equality check for exactT1/Pat tenant and actor user ID.

### 7. **Message Integrity Verification - CORRECT**

**File:** `meri-case46-capture-readback.ts:64-71`

```typescript
if (!bound(input) || input.message.role !== 'assistant') return null;
const current = await inspect(input);
if (!current.assistant || current.assistant.id !== input.message.id
  || current.assistant.bodySha256 !== sha(input.message.body)
  || case46BudgetHash(case46Record(input.message.metadata).governedArtifactCaptureReceipt)
    !== case46BudgetHash(current.providerUsage)) fail('served_message_changed');
```

Re-reads and verifies:
- Message ID matches
- Body SHA256 matches
- Stored usage receipt hash matches computed usage

---

## No Blocking Issues Found

| Concern | Status | Evidence |
|---------|--------|----------|
| Authority joins | PASS | Lines 82-130 in readback file |
| Transaction locking | PASS | `FOR SHARE` on all queries |
| DTO leak of sealedPolicy | PASS | Hash-only replacement, tested |
| Ordinary fallback | PASS | Returns null when unbound |
| Dispatch order | PASS | case46 first in getConversation |
| Test coverage | PASS | 19/19 Jest, 6/6 PG, no skips |
| Retry with attemptCount=2 | PASS | Lines 512-513 in PG test |
| Raw seal/MAC in public | PASS | Never included, only bindingSha256 |

---

**Result: PASS**