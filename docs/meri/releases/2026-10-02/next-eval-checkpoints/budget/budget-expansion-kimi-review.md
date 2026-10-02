I'll conduct an independent source review of this Meri budget21/22/23/24/26/27 extension based on the provided source material. This is a review-only task with no tool calls or file inspections required.

## Independent Source Review: Budget Expansion Cases 21/22/23/24/26/27

### Scope Understanding
This is a **strictly bounded extension** of reviewed20/72 controlled read infrastructure:
- **Not live**: Server explicitly gates with `controlled_budget_expansion_not_live_qualified`
- **Source-ready only**: Definitions, joins, predicate logic, and tests are implemented
- **No production writes/model/config/routing changes**: Document confirms this
- **One real HTTP call, multiple passages**: New `sourceReads` array captures multiple sources per HTTP response

---

### Critical Path Verification

#### 1. **Tenant/Actor/Source Proof Verification**

**meri-controlled-read-fixture.ts:50-52**
```typescript
type ControlledReadCase = '20' | '21' | '22' | '23' | '24' | '26' | '27' | '72';
export function isMeriControlledReadCase(caseId: unknown): caseId is ControlledReadCase {
  return (
    typeof caseId === 'string' && ['20', '21', '22', '23', '24', '26', '27', '72'].includes(caseId)
  );
}
```
✅ **Correct**: enumerated set rejects arbitrary case IDs; type guard safe

**controlled-read-definitions.mjs:26-27**
```javascript
export function createControlledReadDefinition({ caseId, tenantId, clientId, captureRunId }) {
  if (CONTROLLED_BUDGET_CASES.includes(caseId))
    return createControlledBudgetDefinition({ caseId, tenantId, clientId, captureRunId });
```
✅ **Correct**: budget cases delegated to separate definition module

**controlled-budget-definitions.mjs:29-34**
```javascript
if (
  !CONTROLLED_BUDGET_CASES.includes(caseId) ||
  tenantId !== AUTHORIZED_TENANTS.T1.id ||
  !UUID.test(clientId ?? '') ||
  !UUID.test(captureRunId ?? '')
)
  fail();
```
✅ **Correct**: tenant-scoped to T1, UUID validation on both clientId and captureRunId

#### 2. **Immutable Frozen Stage Facts (no invented committee/year)**

**controlled-budget-definitions.mjs:63-70** - Row22 verification:
```javascript
reports.reads.every((r) => !/appropriat|armed services|page/i.test(r.content))
```
✅ **Correct**: row22 excludes committee names (hasc/sasc/hac-d/sac-d), page numbers

**controlled-budget-definitions.mjs:71-78** - Row26 verification:
```javascript
assert.ok(d.reads.every((r) => !/FY|enacted|request|committee/i.test(r.content)));
assert.deepEqual(
  d.reads.map((r) => r.facts.naturalKey),
  ['cost-category-a', 'cost-category-b'],
);
```
✅ **Correct**: row26 preserves natural keys without inventing fiscal year/stage

#### 3. **Signed Joins Verification**

**controlled-read-receipt-joins.mjs:141-143**
```javascript
need(
  definition.physicalMapSha256 === expected.physicalMapSha256,
  'CONTROLLED_READ_FROZEN_MAP_MISMATCH',
);
```
✅ **Correct**: definition re-derived from canonical factory at join time, compared to expected

**controlled-read-receipt-joins.mjs:175-183** - Multi-source loop:
```javascript
definition.reads.every((read) => {
  const s = byId.get(read.physicalId);
  return (
    s &&
    s.logicalId === read.logicalId &&
    s.tenantId === expected.tenantId &&
    s.clientId === (isBudget ? null : expected.clientId) &&
    ...
  );
})
```
✅ **Correct**: every canonical read has matching physical source with matching SHA256

#### 4. **Negative Complete Coverage (23/27)**

**controlled-budget-definitions.mjs:92-105**
```javascript
const coverage =
  caseId === '23'
    ? {
        kind: 'budget_stage_catalog',
        complete: true,
        peCode: '0912345T',
        fiscalYear: 2027,
        enactedSourcePresent: false,
        sourceIds,
      }
    : caseId === '27'
      ? {
          kind: 'budget_index',
          complete: true,
          fiscalYear: 2027,
          service: 'Navy',
          queriedPeCode: '0999999Z',
          matchCount: 0,
          sourceIds,
        }
      : null;
```
✅ **Correct**: explicit `enactedSourcePresent: false` for 23, `matchCount: 0` for 27

**controlled-budget-predicates.mjs:89-92** - Predicate enforcement:
```javascript
if (joined.coverage?.enactedSourcePresent !== false)
  defects.push('ABSENCE_COVERAGE_NOT_OBSERVED');
```
✅ **Correct**: verification fails if absence not explicitly marked

#### 5. **Raw Bytes/Hash Verification**

**controlled-read-observations.ts:89-93**
```javascript
const actualHash = createHash('sha256').update(row.text, 'utf8').digest('hex');
if (actualHash !== source.contentSha256 || row.contentSha256 !== actualHash)
  throw new Error('Controlled read source set passage hash mismatch.');
```
✅ **Correct**: actual text hashed and compared to signed contentSha256 in provenance

#### 6. **Regular20/72 Non-Regression**

**meri-server-readonly-capture.ts:118-121**
```typescript
if (['21', '22', '23', '24', '26', '27'].includes(conversation?.captureBinding.caseId ?? ''))
  throw captureDenied('controlled_budget_expansion_not_live_qualified');
```
✅ **Correct**: new cases blocked at capture policy issuance; 20/72 unaffected

**controlled-read-observations.ts:13**
```typescript
const enabled = (p: MeriServerReadonlyCapturePolicy | null): p is MeriServerReadonlyCapturePolicy =>
  !!p && ['20', '21', '22', '23', '24', '26', '27', '72'].includes(p.caseId ?? '');
```
⚠️ **OBSERVATION**: The list includes new cases, but since capture policy cannot be issued for them, `observeControlledReadHttpResponse` will never be called with 21-24/26/27 in practice. The code is defensively correct.

#### 7. **Tool Allowlist (Budget vs Memo)**

**meri-controlled-read-fixture.ts:159-163**
```typescript
export function controlledReadToolAllowed(caseId: string | null, tool: string): boolean {
  return isMeriControlledReadCase(caseId) && caseId !== '72'
    ? ['search_program_elements', 'get_program_element', 'get_pe_budget_timeline'].includes(tool)
    : caseId === '72' && tool === 'read_client_documents';
}
```
✅ **Correct**: budget tools for all non-72 controlled read cases; memo tool only for 72

#### 8. **One HTTP Call, Multiple Passages**

**meri-controlled-read-fixture.ts:75-78**
```typescript
if (policy.caseId !== '20' && policy.caseId !== '72') {
  result = createControlledBudgetToolResult(proof, tool, input, provenance);
```
✅ **Correct**: budget result creates ONE result with `sourceReads` array

**meri-controlled-budget-result.ts:30-44**
```typescript
const sourceReads = reads.map((read) => ({
  sourceId: read.physicalId,
  logicalSourceId: read.logicalId,
  ...
}));
```
✅ **Correct**: multiple sources in one response

**controlled-read-observations.ts:137-139**
```typescript
sourceReads = sources.map(...)
...
passageSha256 = sourceReads[0]!.passageSha256;
```
✅ **Correct**: legacy scalar fields preserved (back-compat with case20), `sourceReads` array added

#### 9. **Multi-Source Observation Rejection Logic**

**controlled-read-observations.spec.ts:198-230**
```typescript
test.each(['duplicate', 'missing', 'hash', 'foreign', 'coverage'])(
  'multi-source observation refuses %s before recording anything',
  async (fault) => {
```
✅ **Correct**: comprehensive fault injection tests verify rejection before state mutation

#### 10. **PostgreSQL Integration (Real DB)**

**controlled-budget.postgres.test.mjs:15-18**
```javascript
await withOwnedApprovedMemory(
  process.env.MERI_APPROVED_MEMORY_PG_CONFIG,
  async ({ deps, tx }) => {
```
✅ **Correct**: uses real Postgres transaction with rollback

**Line 100-103**
```javascript
const actual = createControlledBudgetToolResult(proof, tool, input, ...);
assert.equal(actual.records.length, proof.definition.reads.length);
assert.equal(actual.controlledRead.sourceReads.length, actual.records.length);
```
✅ **Correct**: actual typed function from API package exercised against real database fixture

**Line 142-144**
```javascript
await assert.rejects(qualifyControlledReadInTx(tx, { ...ctx, userId: randomUUID() }, args));
await assert.rejects(
  qualifyControlledReadInTx(tx, { ...ctx, tenantId: AUTHORIZED_TENANTS.T2.id }, args),
);
```
✅ **Correct**: access control verified against wrong user and wrong tenant

---

### Issue Severity Classification

| Path | Line | Issue | Severity |
|------|------|-------|----------|
| N/A | N/A | No critical issues found | - |

### Human Eval Rubric Compliance

**controlled-budget-predicates.mjs** - Human eval predicates (per case):
- **21**: `FY.*26.*enacted.*\$.*37`, `FY.*27.*request.*\$.*42`, increase \$5M required
- **22**: House \$48M, Senate \$45M, \$3M difference required
- **23**: FY27 scope mention, enactment not established required, rejects "zero was enacted"
- **24**: Same as 21 plus premise correction language required
- **26**: All three amounts (6.178, 2.811, 8.989), natural key preservation
- **27**: Exact PE 0999999Z, Navy, FY27, rejection phrasing, complete coverage with matchCount 0

✅ **Correct**: rubric requires >=8/10 with no 0 scores; predicates enforce minimal content requirements

---

### Verification Summary

**Delegated Work**: None - this is review-only
**Parent-Relevant Work**: Static analysis complete

| Criterion | Status |
|-----------|--------|
| Current tenant/actor/source proof | ✓ PASS |
| One HTTP call/multiple passages | ✓ PASS |
| Immutable frozen stage facts | ✓ PASS |
| Signed joins | ✓ PASS |
| Negative complete coverage | ✓ PASS |
| Raw bytes/hashing | ✓ PASS |
| Regular20/72 non-regression | ✓ PASS |
| Tool allowlist | ✓ PASS |
| PostgreSQL real integration | ✓ PASS |
| Human eval predicates | ✓ PASS |

---

## FINAL VERDICT: **PASS**

The implementation correctly extends the controlled read infrastructure to budget cases 21/22/23/24/26/27 while:
- Maintaining strict tenant/actor/scope isolation
- Preserving frozen immutable source definitions
- Implementing multi-source receipts with proper joins
- Enforcing coverage semantics for negative cases (23/27)
- Keeping new cases gated from live activation pending deployed20 qualification
- Requiring human evaluation (>=8/10, no 0) before case acceptance

The existing tests (Node125 passing, orchestrator22 passing) plus the new budget-specific tests provide correct static verification. Live activation is intentionally and correctly blocked.