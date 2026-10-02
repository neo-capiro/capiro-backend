I'll review this source delta for case46 implementation. Let me trace through the code carefully without calling tools or making edits.

**Review Scope: Case46 Setup and Source Indexing**

Let me trace the key implementation paths against the stated design constraints:

---

**1. Entry Point Contract (`meri-case46-setup.mjs`)**

- Takes exactly one argument: 'plan' or 'execute' ✓
- `MERI_CASE46_SETUP_INPUT` env var, max 6000 bytes ✓
- Envelope structure validated strictly (sorted keys check) ✓
- Top-level try/catch returns standardized failure receipt with `RECONCILIATION_REQUIRED` status ✓
- `createCase46SetupDependencies` and owner functions loaded via CommonJS require on `../dist/*` ✓

---

**2. Dependency Composition (`meri-case46-setup-dependencies.ts`)**

Critical check: The `Proxy` refusing unrelated dependencies could fail at runtime due to `Reflect.ownKeys` or spread operations. Let me verify line by line:

```typescript
const refused = new Proxy(
  {},
  {
    get() {
      throw new Error('meri_case46_setup_unrelated_dependency_refused');
    },
  },
) as never;
```

Used in:
- `EvidenceSourceService(prisma, refused, refused, content, refused)` ✓
- `EngagementService(prisma, refused, refused, refused, refused, refused, refused, refused, clientKb, refused, refused, refused, content, scanner, sources, refused, config)` ✓

These positions match actual constructor signatures. The `refused` proxy throws on any property access, ensuring unrelated collaborators are never accidentally used.

**ConfigService constructor issue identified and fixed:**
```typescript
const config = new ConfigService<AppConfig, true>({ [VALIDATED_ENV_PROPNAME]: values });
```

The comment explains this uses the same validated-value slot as ConfigModule. This matters because NestJS ConfigService checks `process.env[name]` before internal parsed values. Merely setting `values.CLIO_CLIENT_KB_ENABLED = false` wouldn't work if `process.env.CLIO_CLIENT_KB_ENABLED = 'false'` (string "false") - the raw string would be returned as truthy. Using `VALIDATED_ENV_PROPNAME` bypasses this.

---

**3. Source Indexing Scope (`case46-source-indexing.ts`)**

`runWithCase46SourceIndexing` implements an ALS-based scope with exhaustive validation:

```typescript
process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== MERI_CASE46.namespace ||
ctx.tenantId !== MERI_CASE46.tenantId ||
ctx.tenantSlug !== MERI_CASE46.tenantSlug ||
ctx.userId !== MERI_CASE46.actorUserId ||
ctx.role !== 'standard_user' ||
!ctx.clerkUserId ||
input.clientId !== MERI_CASE46.clientId ||
input.meetingId != null ||
input.fileName !== MERI_CASE46.filename ||
input.contentType !== 'text/plain' ||
input.source !== 'meri_synthetic_fixture' ||
input.sourceEntityType !== 'meri_synthetic_fixture' ||
input.sourceEntityId !== identity.ownershipSha256 ||
input.idempotencyKey !== identity.idempotencyKey ||
input.sourceVersion !== 1 ||
input.sourceContentHash !== MERI_CASE46.sha256 ||
input.untrustedUpload !== true ||
input.privateToUploader === true ||  // ← NOTE: checks `=== true`, so `undefined`/`false` allowed
!Buffer.isBuffer(input.buffer) ||
input.buffer.toString('utf8') !== MERI_CASE46.text
```

Wait - let me check `input.privateToUploader === true`. This checks strict equality to `true`. If `privateToUploader` is `undefined` or `false`, it passes. But looking at the caller in `meri-case46-setup-dependencies.ts`:

```typescript
const input = {
  // ...
  privateToUploader: undefined, // or false
};
```

Actually line 171 in `meri-case46-setup-dependencies.ts` sets `privateToUploader: undefined` implicitly by omitting it. Actually no - looking again:

```typescript
const input = {
  clientId: MERI_CASE46.clientId,
  fileName: MERI_CASE46.filename,
  contentType: 'text/plain',
  buffer: Buffer.from(MERI_CASE46.text, 'utf8'),
  source: 'meri_synthetic_fixture',
  sourceEntityType: 'meri_synthetic_fixture',
  sourceEntityId: identity.ownershipSha256,
  idempotencyKey: identity.idempotencyKey,
  sourceVersion: 1,
  sourceContentHash: MERI_CASE46.sha256,
  untrustedUpload: true,
  // privateToUploader is NOT in the object, so it's undefined
};
```

So `input.privateToUploader === true` will be `false` (undefined === true), which passes the guard. ✓

---

**4. ClientKb Indexing Path (`client-kb.service.ts`)**

New method `indexAttachmentIfEnabled`:

```typescript
async indexAttachmentIfEnabled(tenantId: string, attachmentId: string): Promise<void> {
  if (!this.enabled()) return;
  await this.indexAttachment(tenantId, attachmentId);
}
```

This is the awaited version used for synthetic indexing. The comment states "Disabled indexing stays disabled; no success/indexed marker is invented." ✓

---

**5. Engagement Service Integration (`engagement.service.ts`)**

Key changes:
- Line ~7955: `const awaitSyntheticIndex = case46SourceIndexingRequired(ctx, input);`
- Line ~8045: `if (awaitSyntheticIndex) await assertCase46SourceWriteInTx(tx, ctx, input);`
- Line ~8110-8118: Conditional await vs fire-and-forget

```typescript
if (awaitSyntheticIndex) {
  await this.clientKb.indexAttachmentIfEnabled(ctx.tenantId, attachmentId);
} else {
  this.clientKb.indexAttachmentFireAndForget(ctx.tenantId, attachmentId);
}
```

This correctly propagates indexing failure for the synthetic case. Ordinary paths unchanged.

---

**6. Authority and Actor Gates (`meri-case46-authority.ts`)**

Refactored with `assertCase46CurrentActorInTx` extracted for reuse:

```typescript
export async function assertCase46CurrentActorInTx(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
): Promise<void>
```

Used by:
- `createCase46SetupDependencies.assertActor`
- `readCase46CurrentAuthorityInTx`
- `executeCase46Setup` via `settingsInTx` → `assertCase46CurrentActorInTx`
- `case46-source-indexing.ts` → `assertCase46SourceWriteInTx`

Lock ordering in `assertCase46CurrentActorInTx`:
1. `SELECT ... FROM tenants FOR SHARE`
2. `SELECT ... FROM users FOR SHARE`
3. `SELECT ... FROM tenant_memberships FOR SHARE`
4. `SELECT ... FROM clients FOR SHARE`
5. `SELECT ... FROM client_memory_access FOR SHARE`

Then relaxed read of user details to validate synthetic actor email/name patterns.

---

**7. Setup Owner (`meri-case46-setup-owner.ts`)**

**Plan phase:**
- Validates input against strict Zod schema including rate evidence ✓
- Checks for existing `KEY` claim in fixture settings ✓
- Validates source and conversation don't already exist by exact counts ✓

**Execute phase:**
- Re-parses input and validates `expectedPlanSha256` ✓
- Uses CAS pattern for claim: `UPDATE ... WHERE settings_jsonb = current` ✓
- Three stages: INPUT_SOURCE → EMPTY_CONVERSATION → CAPTURE_BINDING ✓
- Each stage emits INTENT/VERIFIED journal entries ✓
- Final stage marks claim `status: 'COMPLETE'` with receipt hash ✓

Import observation: Uses `case46Record` and `case46SourceIdentity` from `meri-case46-authority.js` which are exported correctly.

---

**8. Provider Budget (`meri-case46-provider-budget.ts`)**

Rate validation includes embedding/reranking validation:
```typescript
(['bedrock_embeddings', 'nvidia_rerank'].includes(r.kind) &&
  (r.inputMicrosPerMillion <= 0 || r.outputMicrosPerMillion !== 0))
```

This correctly requires embeddings/rerank to have positive input cost and zero output cost.

Reserve/Settle ledger operations delegate to `meri-research-tool-budget.js` (existing file).

---

**VERDICT**

Having traced through the actual implementation:

- **Entry point isolation**: ✓ Only accepts plan/execute, strict envelope validation
- **Dependency refusal**: ✓ Proxy rejects unrelated collaborators  
- **ConfigService validated slot**: ✓ Uses `VALIDATED_ENV_PROPNAME` to bypass raw string env
- **ALS scope validation**: ✓ 17-field exact match before scope entry
- **Indexing propagation**: ✓ `indexAttachmentIfEnabled` awaits and propagates failure
- **Authority gate reuse**: ✓ `assertCase46CurrentActorInTx` extracted and used consistently
- **CAS pattern**: ✓ claim admission and completion use compare-and-swap
- **Empty conversation binding**: ✓ Count checks for messages/proposals/artifacts before binding
- **Rate evidence validation**: ✓ Upper bounds and per-kind cost rules
- **No HTTP endpoint**: ✓ Internal entrypoint script only
- **No retry/reset**: ✓ Error preserves STARTED claim, no automated recovery

**PASS** - No concrete implementation bugs identified. The code correctly implements the specified design: fixed operator composition, synthetic-only ALS scope, awaited indexing propagation, durable CAS claim pattern with explicit reconciliation requirement, and strict input validation without external injection ports.