import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHistoricalQaIntake } from './intake-historical-qa.mjs';

function fixture() {
  const readResults = Array.from({ length: 81 }, (_, index) => ({
    testId: `MRO-${String(index + 1).padStart(3, '0')}`,
    feature: 'synthetic_feature_id',
    prompt: `PRIVATE_READ_PROMPT_${index}`,
    displayedContent: `PRIVATE_DISPLAYED_${index}`,
    actualResult: `PRIVATE_RESULT_${index}`,
    status: index === 0 ? 'PASS' : 'FAIL',
  }));
  const actionResults = Array.from({ length: 23 }, (_, index) => ({
    testId: `MWR-${String(index + 1).padStart(3, '0')}`,
    category: 'Meri Approval Actions',
    safetyMode: index % 2 ? 'MUTATION_APPROVAL' : 'MUTATION_IMMEDIATE',
    title: `PRIVATE_ACTION_TITLE_${index}`,
    evidence: `PRIVATE_ACTION_EVIDENCE_${index}`,
    status: 'PASS',
  }));
  return {
    read: { results: readResults },
    updated: { results: [...actionResults, { testId: 'OTHER-001', category: 'Security' }] },
    readBytes: Buffer.from('read source bytes'),
    updatedBytes: Buffer.from('updated source bytes'),
  };
}

test('intake contains only cohort IDs/source hashes and aggregates, never QA content or verdicts', () => {
  const input = fixture();
  const report = buildHistoricalQaIntake(input.read, input.updated, input.readBytes, input.updatedBytes);
  assert.deepEqual(report.cohorts.map(({ id, recordCount }) => ({ id, recordCount })), [
    { id: 'historic_read_qa', recordCount: 81 },
    { id: 'historic_action_safety_qa', recordCount: 23 },
  ]);
  assert.deepEqual(report.cohorts[1].safetyModeCounts, { MUTATION_APPROVAL: 11, MUTATION_IMMEDIATE: 12 });
  assert.equal(report.cohorts.reduce((sum, cohort) => sum + cohort.caseIds.length, 0), 104);
  assert.ok(report.cohorts.every((cohort) => cohort.caseIds.length === cohort.recordCount));
  assert.ok(report.cohorts.flatMap(({ caseIds }) => caseIds).every((id) => /^(MRO|MWR)-[0-9]{3}$/.test(id)));
  const serialized = JSON.stringify(report);
  for (const row of [...input.read.results, ...input.updated.results]) {
    for (const secretKey of ['prompt', 'displayedContent', 'actualResult', 'title', 'evidence', 'status']) {
      if (secretKey in row) assert.equal(serialized.includes(String(row[secretKey])), false);
    }
  }
  assert.deepEqual(report.separation, {
    routingCases: 0,
    independentlyAdjudicated: false,
    statusLabelsIncluded: false,
    promptsOrDisplayedContentIncluded: false,
    rawEvidenceIncluded: false,
    passLabelsAreNotFactualOrRoutingPasses: true,
    separateFromSyntheticRoutingSeed: true,
  });
});

test('rejects cohort drift, wrong IDs, duplicate IDs, and unknown write safety modes', () => {
  const input = fixture();
  const missingFeature = structuredClone(input.read);
  delete missingFeature.results[0].feature;
  assert.throws(() => buildHistoricalQaIntake(missingFeature, input.updated, input.readBytes, input.updatedBytes), /without its expected feature identifier/);

  const wrongId = structuredClone(input.read);
  wrongId.results[0].testId = 'MWR-001';
  assert.throws(() => buildHistoricalQaIntake(wrongId, input.updated, input.readBytes, input.updatedBytes), /invalid case ID/);

  const duplicate = structuredClone(input.read);
  duplicate.results[1].testId = duplicate.results[0].testId;
  assert.throws(() => buildHistoricalQaIntake(duplicate, input.updated, input.readBytes, input.updatedBytes), /duplicate case IDs/);

  const unsafeMode = structuredClone(input.updated);
  unsafeMode.results[0].safetyMode = 'READ_ONLY';
  assert.throws(() => buildHistoricalQaIntake(input.read, unsafeMode, input.readBytes, input.updatedBytes), /unexpected safety mode/);
});
