# Case14 canonical read prerequisites — independent source review

## Scope and disposition

This is a bounded source review for API source `4f0253874357c272fda1ae2a5271ee4af645f0bc`; no owner invocation, database access, tests, fixture/journal changes, or acceptance claim was made. The previously reported bounded UI lookup did not establish the canonical owner; it is not evidence of absence.

**Source design is usable for a scoped read, subject to mandatory rollback and a sanitized wrapper.** The existing entry point is `readCase14FixtureEvidenceInTx(tx, ctx, authorization, candidateId?)`; with `candidateId` omitted it resolves the candidate ID from the stored Case14 recipe and runs the canonical owner checks. Do not replace it with the pending setup reader, a direct candidate query, a Case17 identity/instance, or a READ ONLY transaction. The canonical path acquires row locks.

## Exact source guards and state distinctions

1. The exported evidence wrapper (`apps/api/src/memory/case14-fixture-evidence.ts:157-174`) returns null unless the namespace env is exactly `meri-foundation-20260928`, tenant ID is `f2d6cf8f-057c-479a-8110-62fe5086d43f`, slug is `meri-foundation-20260928-t1`, role is `user_admin`, and `memoryReviewSurfaceEnabled()` is true. The latter requires all three exact switches: `MEMORY_CLIENT_REVIEW=enforce`, `MEMORY_GOVERNANCE_LIFECYCLE` enabled by its canonical parser, and `MEMORY_GOVERNANCE_ENFORCE` enabled by its canonical parser. The wrapper itself does not verify the authenticated membership/Clerk identity; the caller must provide Priya's server-grounded context and the owner verifies active membership and exact Clerk ID.
2. Fixed owner (`evals/meri/live-v1/fixture-provisioning/case14-memory-owner.mjs:22-50`) independently checks namespace, exact T1 tenant ID/slug, and `user_admin`; reads tenant settings; requires exactly one tenant, Case14 operation `SETUP_COMPLETE`, and a locator; resolves that locator against source; requires case `14` and recipe reviewer equal to `ctx.userId`. With candidate omitted, the recipe selects its sole logical source `MEM-PROPOSAL-14`. It verifies record count/logical ID, recipe hash, fixture instance, and valid plan/receipt hashes. It then requires exactly one active membership with matching role and Clerk ID, and a candidate matching the recipe's proposer/client, revision 1, and numeric xmin row version.
3. **Pending branch:** status must be `pending`; `assertSyntheticCandidateWithdrawalInTx` validates the synthetic ownership marker, deterministic candidate identity, exact source/payload/provenance and pristine pending fields, active membership, and client-wall/access rows. Then `readCase14ReviewerPreflightInTx` requires exact scope/env, Priya's Clerk ID format, UUID inputs, Priya distinct from proposer, exact one active membership with matching role and Clerk ID, exact pending/client/revision/row-version candidate, and successful canonical `approve` authorization. It suppresses denial metrics (`emitDenialMetrics:false`), so authorization simulation does not mint the transaction-local review capability. Returned owner state is explicitly `pending`, with no item or decision.
4. **Approved branch:** status must be `approved`, governed status `active`, approver exactly the current reviewer, and both committed IDs present. It requires exactly one item; `assertSyntheticApprovedMemoryInTx` checks the candidate/item ownership/content/governance identity and locks candidate and item (and exact projection where present). Canonical `loadItemInTx` plus `evaluateInTx(...,'read',{emitDenialMetrics:false})` must permit reading. Exactly one approval transition audit must match tenant/candidate/actor/client/effective tenant/reason/status and committed item/Clio IDs. A valid source hash and `candidate:<candidate UUID>` item source version are required. Owner state/decision is `approved` and includes actual item and audit IDs.
5. **Error distinction:** `null` is not one uniform “absent” result. It can mean outer scope/switch mismatch; no tenant/op, operation not complete or missing locator; recipe reviewer mismatch; or optional candidate mismatch. With candidate omitted and exact scope independently established, classify *database owner absent* only when the isolated settings-path read proves the Case14 operation key is absent. A present `CLAIMED`/other non-complete operation is existing/incomplete and must be reconciled, not treated as absent. A completed locator returning null is blocked/unclassified (including source/reviewer mismatch), not proof of absence. `CASE14_CURRENT_CANONICAL_OWNER_REQUIRED` and `PENDING_MEMORY_*` recipe failures indicate invalid/inconsistent owner/locator, not absence. A non-null return distinguishes `state:'pending'` from `state:'approved'`. Preserve only allowlisted stage and known code; never expose arbitrary exception text or SQL.

## Smallest executable composition (review pseudocode, not executed)

Use the existing private-task launcher/root-owned execution path and exact immutable API image. Reuse the four imports already shown by `apps/api/scripts/meri-case14-recall-setup.mjs` (lines 35-47), substituting the evidence reader:

```js
const { PrismaService } = require('../dist/prisma/prisma.service.js');
const { MemoryAuthorizationService } = require('../dist/memory/memory-authorization.service.js');
const { runWithMemoryGovernanceTenant } = require('../dist/memory/memory-governance-tenant-scope.js');
const { readCase14FixtureEvidenceInTx } = require('../dist/memory/case14-fixture-evidence.js');
const prisma = new PrismaService();
await prisma.$connect();
const authorization = new MemoryAuthorizationService(prisma);
let sanitized;
const ROLLBACK = Object.freeze({ case14RollbackSentinel: true });
try {
  await runWithMemoryGovernanceTenant(T1, () =>
    prisma.withTenantUser(T1, PRIYA, async tx => {
      // Exact same scoped transaction: explicitly fetch only tenant slug and
      // settings_jsonb #> '{meriFoundationFixture,pendingMemorySetups,14}'.
      // Validate exactly one tenant and exact slug. Keep only operation
      // presence/status and validated locator/hash fields; discard raw JSON.
      const op = await readCase14OperationProjection(tx, T1);
      // First independently validate exact active Priya membership,
      // Clerk ID and user_admin role. Scope/switch mismatch is a blocked error.
      // If op key is absent, prepare sanitized {owner:'absent'} only after
      // recording that precise scoped finding; never infer this from null.
      const owner = op.status === 'SETUP_COMPLETE'
        ? await readCase14FixtureEvidenceInTx(tx, exactPriyaContext, authorization)
        : null;
      sanitized = allowlistAndOmitTextAndSettings(op, owner);
      // Even null/absence must pass through this sentinel: transaction rollback
      // is mandatory for every path after beginning the scoped read.
      throw ROLLBACK;
    }),
  );
  throw new Error('ROLLBACK_SENTINEL_NOT_OBSERVED');
} catch (e) {
  if (e !== ROLLBACK) throw allowlistedFailure(e);
  // Emit/write the already-sanitized result only after confirming rollback.
} finally {
  await prisma.$disconnect();
}
```

`readCase14OperationProjection` above is explanatory SQL pseudocode, not a claim that such an existing helper exists. Use parameterized SQL on `tx`, scoped by tenant ID and slug, selecting only `slug` and `settings_jsonb #> '{meriFoundationFixture,pendingMemorySetups,14}'`. Do not do a READ ONLY transaction: the owner path calls lock-taking checks. The sentinel must be thrown from inside `withTenantUser`, after gathering the result, and caught outside so Prisma rolls the transaction back; do not return normally and commit. If rollback/sentinel identity cannot be confirmed, report blocked and emit no successful read receipt. Do not weaken/drop the source locks.

### Minimal compiled paths

From the API working directory, the four required direct compiled module paths are exactly:

- `../dist/prisma/prisma.service.js`
- `../dist/memory/memory-authorization.service.js`
- `../dist/memory/memory-governance-tenant-scope.js`
- `../dist/memory/case14-fixture-evidence.js`

The evidence module dynamically loads the fixed source owner relative to its compiled `__dirname` and imports its guard/helper dependencies itself. No full Nest `AppModule`, pending setup `execute`/`read`, recall binding/installer, budget installer, provider, conversation, or journal module is needed. `PrismaService.withTenantUser` sets tenant and current-user GUCs in an interactive transaction; using the provided `tx` throughout is essential. The script's catch-all error handler is unsuitable for this review receipt because it discards stage/code distinctions.

## Output allowlist (do not dump content/settings)

Emit only a schema/version, Case14, exact tenant/client/proposer/reviewer/candidate IDs where validated, owner status (`absent`, `pending`, `approved`, or `blocked`), fixture namespace/version/instance, manifest/recipe/plan/setup/current-verification hashes, candidate/item row versions and hashes, and for approved state the committed item/Clio IDs plus exact transition-audit ID and actor/decision. For pending state include no item/decision. Include an allowlisted failure stage/code only. **Drop `text`** from `Case14MemoryEvidence`; do not serialize the returned object verbatim. Never include `settings_jsonb`, locator/recipe body, fixture payload, proposal text, SQL, credentials, arbitrary exception messages, or raw rows. The current source owner reads full settings JSON internally (`case14-memory-owner.mjs:30-35`) to resolve the stored locator; the wrapper must still strictly constrain what it emits.

## Mock/local source-check cases for the execution owner

These can be exercised in a local harness with mocked transaction/ports, without a live DB; this review did not run them:

- Exact scope + absent Case14 settings key => null/absent classification; existing `CLAIMED`, incomplete, or missing locator => blocked/reconciliation, not absence.
- Wrong namespace, tenant ID/slug, role, disabled review switch, wrong reviewer/user/Clerk membership, duplicate/missing membership, or reviewer equal to proposer => blocked and no owner result.
- Exact completed recipe, omitted candidate ID, exact valid pending row => pending proof; assert guard/preflight calls and that no write/decision is made. Wrong supplied candidate (if testing optional arg) => null, not absent.
- Pending candidate altered in ownership/payload/provenance/scope/client/status/revision/row version or denied client wall/access => owner-required/guard failure; no successful result.
- Exact approved state/item/projection/authorization/audit => approved proof; missing, duplicate, mismatched actor/client/audit/item/hash/source version => blocked, never relabel as pending.
- All success, null and failure paths throw the outer rollback sentinel after read; assert the sentinel is caught only outside the interactive transaction. Simulate query/rollback errors and ensure no successful sanitized receipt is emitted.
- Output contract test rejects `text`, `settings`, recipe/locator bodies, SQL, arbitrary errors, and fields outside the allowlist.

## Blockers and limits

- This review could not establish current DB fixture presence, absence, state, exact operation locator, or rollback behavior; no live invocation was performed. No acceptance, approval, fixture readiness, or Case14 identity derived from Case17 is claimed.
- The source provides no distinct typed error for all causes of owner `null`; the extra narrow settings-path projection plus independent scope/membership checks is needed to safely label absence. A completed operation with owner `null` must remain blocked/ambiguous absent further verified reason.
- The owner returns proposal `text`, so an explicit output sanitizer is mandatory. Its internally broad settings read is a source behavior; only sanitized output is permitted here.
- A source-level passing review is not acceptance. Root owns the protected native read, transaction/rollback proof, task cleanup, integration, tests, journal and any release; no release or implementation change is authorized by this review.
