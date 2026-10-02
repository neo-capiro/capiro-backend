import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createControlledBudgetDefinition,
  CONTROLLED_BUDGET_CASES,
} from '../fixture-provisioning/controlled-budget-definitions.mjs';
import { frozenFixture } from '../fixture.mjs';
import { sha256Bytes, sha256Stable } from '../artifact-collector.mjs';
import { AUTHORIZED_TENANTS } from '../fixture-provisioning/contract.mjs';
const input = {
  tenantId: AUTHORIZED_TENANTS.T1.id,
  clientId: '11111111-1111-4111-8111-111111111111',
  captureRunId: '22222222-2222-4222-8222-222222222222',
};
for (const caseId of CONTROLLED_BUDGET_CASES)
  test(`budget${caseId} preserves frozen facts, distinct physical identities and complete passages`, () => {
    const d = createControlledBudgetDefinition({ ...input, caseId });
    assert.deepEqual(d, createControlledBudgetDefinition({ ...input, caseId }));
    assert.equal(d.physicalMapSha256, sha256Stable(d.sourceMap));
    assert.equal(new Set(d.reads.map((r) => r.physicalId)).size, d.reads.length);
    for (const r of d.reads) {
      assert.deepEqual(r.facts, frozenFixture.sources[r.logicalId].facts);
      assert.equal(r.contentSha256, sha256Bytes(r.content));
      assert.equal(d.sourceMap[r.logicalId].clientPhysicalId, null);
      assert.equal(d.sourceMap[r.logicalId].frozenFixtureId, r.logicalId);
      assert.throws(() => {
        r.facts.amountUsd = 0;
      });
    }
    const other = createControlledBudgetDefinition({
      ...input,
      caseId,
      captureRunId: '33333333-3333-4333-8333-333333333333',
    });
    assert.notEqual(other.physicalMapSha256, d.physicalMapSha256);
  });
test('row26 invents neither fiscal year nor stage nor committee; row22 preserves exact report wording', () => {
  const d = createControlledBudgetDefinition({ ...input, caseId: '26' });
  assert.deepEqual(
    d.reads.map((r) => r.facts.naturalKey),
    ['cost-category-a', 'cost-category-b'],
  );
  assert.equal(
    d.reads.reduce((sum, r) => sum + r.facts.amountUsd, 0),
    8989000,
  );
  assert.ok(d.reads.every((r) => !/FY|enacted|request|committee/i.test(r.content)));
  const reports = createControlledBudgetDefinition({ ...input, caseId: '22' });
  assert.ok(reports.reads.every((r) => !/appropriat|armed services|page/i.test(r.content)));
});
test('absence is explicit complete frozen coverage, not a missing response', () => {
  const stage = createControlledBudgetDefinition({ ...input, caseId: '23' });
  assert.equal(stage.coverage.enactedSourcePresent, false);
  assert.equal(stage.coverage.complete, true);
  assert.deepEqual(
    stage.coverage.sourceIds,
    stage.reads.map((r) => r.physicalId),
  );
  const index = createControlledBudgetDefinition({ ...input, caseId: '27' });
  assert.deepEqual(index.coverage, {
    kind: 'budget_index',
    complete: true,
    fiscalYear: 2027,
    service: 'Navy',
    queriedPeCode: '0999999Z',
    matchCount: 0,
    sourceIds: [index.reads[0].physicalId],
  });
});
for (const bad of [
  { caseId: '25' },
  { tenantId: AUTHORIZED_TENANTS.T2.id },
  { clientId: 'other' },
  { captureRunId: 'stale' },
])
  test(`budget definition fails closed ${JSON.stringify(bad)}`, () =>
    assert.throws(() => createControlledBudgetDefinition({ ...input, caseId: '21', ...bad })));
