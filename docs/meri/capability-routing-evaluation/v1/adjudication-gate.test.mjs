import test from 'node:test';
import assert from 'node:assert/strict';
import { familyFreezeSha256, promotionGate, scoreReport, splitMembershipSha256, validateAdjudication } from './adjudication-gate.mjs';

const hash = 'a'.repeat(64);
function fixtureFamilyFreeze(familyIds = ['family-1', 'family-2', 'family-3', 'family-4', 'family-5', 'family-6']) {
  return { version: 'promotion.v1', frozenAt: '2026-09-25T11:00:00Z', reference: 'protected-evaluation-record-v1', familyIds };
}
function frozenFamilyOptions(familyIds) {
  const familyFreeze = fixtureFamilyFreeze(familyIds);
  return { familyFreeze, trustedFamilyFreezeSha256: Array.isArray(familyFreeze.familyIds) ? familyFreezeSha256(familyFreeze) : hash };
}
function fixtureRecord() {
  const cases = Array.from({ length: 300 }, (_, i) => ({
    caseId: `R-${String(i + 1).padStart(3, '0')}`,
    naturalLanguage: true,
    familyIds: [`family-${Math.floor(i / 50) + 1}`],
    split: ['development', 'calibration', 'locked_holdout'][i % 3],
    source: { kind: 'reviewed_traffic', reference: `source-${i + 1}`, contentSha256: hash, reviewerId: `source-reviewer-${i}` },
    annotations: [
      { annotatorId: `ann-a-${i}`, independent: true, acceptableRoutes: ['route-a'], acceptableSequences: [], notes: '' },
      { annotatorId: `ann-b-${i}`, independent: true, acceptableRoutes: ['route-a'], acceptableSequences: [], notes: '' },
    ],
    adjudication: { reviewerId: `adj-${i}`, resolution: 'agreement', acceptableRoutes: ['route-a'], acceptableSequences: [] },
    oracles: {
      execution: { status: 'available', reference: `exec-${i}`, version: 'exec.v1', sha256: hash },
      factual: { status: 'available', reference: `facts-${i}`, version: 'facts.v1', sha256: hash },
    },
  }));
  return {
    schemaVersion: 'meri-capability-routing-adjudication.v1', datasetId: 'reviewed-v1', datasetSha256: hash, catalogVersion: 'catalog.v1',
    splitPlan: { version: 'split.v1', frozenAt: '2026-09-25T12:00:00Z', membershipSha256: splitMembershipSha256(cases) },
    cases,
    runs: cases.filter((item) => item.split === 'development').map((item) => ({ caseId: item.caseId, split: item.split, scores: { routing: 'correct', execution: 'usable_evidence', answer: 'supported', accuracy: 'reference_verified', coverage: 'complete_for_declared_scope', cost: 0.01, latency: 100 } })),
  };
}

test('synthetic 300-case record satisfies the total cohort and family gates across all splits', () => {
  const result = promotionGate(fixtureRecord(), { mode: 'development', ...frozenFamilyOptions() });
  assert.equal(result.evidenceReady, true, result.errors.join('\n'));
  assert.equal(result.promotionAllowed, false);
  assert.equal(result.report.dimensions.routing.counts.correct, 100);
});

test('seed-sized/incomplete evidence cannot promote', () => {
  const record = fixtureRecord();
  record.cases.length = 24;
  record.runs.length = 24;
  record.cases[0].oracles.factual.status = 'not_applicable';
  const errors = validateAdjudication(record, frozenFamilyOptions(['family-1']));
  assert.ok(errors.some((e) => e.includes('at least 300')));
  assert.ok(errors.some((e) => e.includes('promotion requires an available')));
});

test('an otherwise complete record cannot pass without a frozen family manifest and trusted digest', () => {
  const record = fixtureRecord();
  const noFreeze = promotionGate(record);
  assert.equal(noFreeze.evidenceReady, false);
  assert.equal(noFreeze.promotionAllowed, false);
  assert.ok(noFreeze.errors.some((e) => e.startsWith('familyFreeze:')));

  const familyFreeze = fixtureFamilyFreeze();
  const untrusted = promotionGate(record, { familyFreeze });
  assert.equal(untrusted.evidenceReady, false);
  assert.ok(untrusted.errors.some((e) => e.startsWith('trustedFamilyFreezeSha256:')));
});

test('empty, duplicate, and malformed promoted family lists fail closed', () => {
  const record = fixtureRecord();
  for (const familyIds of [[], ['family-1', 'family-1'], ['family-1', ''], ['family-1', ' family-2'], ['family-1', 0], 'family-1', null]) {
    const result = promotionGate(record, frozenFamilyOptions(familyIds));
    assert.equal(result.evidenceReady, false, JSON.stringify(familyIds));
    assert.equal(result.promotionAllowed, false);
    assert.ok(result.errors.some((e) => e.startsWith('familyFreeze.familyIds')), JSON.stringify(result.errors));
  }
});

test('malformed freeze metadata fails closed even with a matching local digest', () => {
  const options = frozenFamilyOptions();
  options.familyFreeze.frozenAt = 'yesterday';
  options.familyFreeze.unreviewed = true;
  options.trustedFamilyFreezeSha256 = familyFreezeSha256(options.familyFreeze);
  const result = promotionGate(fixtureRecord(), options);
  assert.equal(result.evidenceReady, false);
  assert.ok(result.errors.some((e) => e.startsWith('familyFreeze.frozenAt:')));
  assert.ok(result.errors.some((e) => e.startsWith('familyFreeze.unreviewed:')));
});

test('an impossible UTC freeze date fails even with a matching manifest digest', () => {
  const options = frozenFamilyOptions();
  options.familyFreeze.frozenAt = '2026-02-30T11:00:00Z';
  options.trustedFamilyFreezeSha256 = familyFreezeSha256(options.familyFreeze);
  const result = promotionGate(fixtureRecord(), options);
  assert.equal(result.evidenceReady, false);
  assert.ok(result.errors.some((error) => error.startsWith('familyFreeze.frozenAt:')));
});

test('a changed family freeze or fewer than 50 cases for a promoted family blocks evidence readiness', () => {
  const record = fixtureRecord();
  const options = frozenFamilyOptions();
  options.familyFreeze.familyIds[0] = 'family-7';
  const changed = promotionGate(record, options);
  assert.equal(changed.evidenceReady, false);
  assert.ok(changed.errors.some((e) => e.includes('does not match the promoted family freeze')));

  const underFloor = promotionGate(record, frozenFamilyOptions(['family-7']));
  assert.equal(underFloor.evidenceReady, false);
  assert.ok(underFloor.errors.some((e) => e.includes('requires at least 50 cases; found 0')));
});

test('a case without two distinct independent labels and a separate adjudicator blocks promotion', () => {
  const record = fixtureRecord();
  record.cases[0].annotations[1].annotatorId = record.cases[0].annotations[0].annotatorId;
  record.cases[0].adjudication.reviewerId = record.cases[0].annotations[0].annotatorId;
  const errors = validateAdjudication(record);
  assert.ok(errors.some((e) => e.includes('annotator must be distinct')));
  assert.ok(errors.some((e) => e.includes('adjudicator must be independent')));
});

test('development reporting rejects locked holdout outcomes instead of leaking them', () => {
  const record = fixtureRecord();
  record.cases[0].split = 'locked_holdout';
  record.runs[0].split = 'locked_holdout';
  const result = promotionGate(record, { mode: 'development' });
  assert.equal(result.evidenceReady, false);
  assert.ok(result.errors.some((e) => e.includes('while reporting development')));
  assert.equal(scoreReport(record, 'development').cases, 99);
});

test('changing split membership after the recorded freeze hash fails closed', () => {
  const record = fixtureRecord();
  record.cases[0].split = 'locked_holdout';
  assert.ok(validateAdjudication(record).some((e) => e.includes('actual case-to-split assignment')));
});

test('score report keeps routing, execution, answer, accuracy, coverage, cost, and latency independent', () => {
  const record = fixtureRecord();
  record.runs[0].scores.execution = 'failed';
  record.runs[0].scores.answer = 'appropriately_limited';
  const report = scoreReport(record);
  assert.equal(report.dimensions.routing.counts.correct, 100);
  assert.equal(report.dimensions.execution.counts.failed, 1);
  assert.equal(report.dimensions.answer.counts.appropriately_limited, 1);
  assert.equal(report.dimensions.accuracy.counts.reference_verified, 100);
  assert.equal(report.dimensions.coverage.counts.complete_for_declared_scope, 100);
  assert.ok(Math.abs(report.dimensions.cost.mean - 0.01) < 1e-12);
  assert.equal(report.dimensions.latency.p95, 100);
});

test('finite high-value scores keep finite mean and p95', () => {
  const record = fixtureRecord();
  for (const run of record.runs) {
    run.scores.cost = Number.MAX_VALUE;
    run.scores.latency = Number.MAX_VALUE;
  }
  const result = promotionGate(record, frozenFamilyOptions());
  assert.equal(result.evidenceReady, true, result.errors.join('\n'));
  for (const dimension of ['cost', 'latency']) {
    assert.equal(result.report.dimensions[dimension].mean, Number.MAX_VALUE);
    assert.equal(result.report.dimensions[dimension].p95, Number.MAX_VALUE);
  }
});

test('agreement requires identical route sets and ordered sequences across independent labels and adjudication', () => {
  const routeDisagreement = fixtureRecord();
  routeDisagreement.cases[0].annotations[1].acceptableRoutes = ['route-b'];
  const routeResult = promotionGate(routeDisagreement, frozenFamilyOptions());
  assert.equal(routeResult.evidenceReady, false);
  assert.ok(routeResult.errors.some((error) => error.startsWith('cases[0].adjudication.resolution:')));

  const sequenceDisagreement = fixtureRecord();
  sequenceDisagreement.cases[0].annotations[0].acceptableSequences = [['route-a', 'route-b']];
  sequenceDisagreement.cases[0].annotations[1].acceptableSequences = [['route-b', 'route-a']];
  sequenceDisagreement.cases[0].adjudication.acceptableSequences = [['route-a', 'route-b']];
  assert.ok(promotionGate(sequenceDisagreement, frozenFamilyOptions()).errors.some((error) => error.startsWith('cases[0].adjudication.resolution:')));

  const adjudicatorMismatch = fixtureRecord();
  adjudicatorMismatch.cases[0].adjudication.acceptableRoutes = ['route-b'];
  assert.ok(promotionGate(adjudicatorMismatch, frozenFamilyOptions()).errors.some((error) => error.startsWith('cases[0].adjudication.resolution:')));

  routeDisagreement.cases[0].adjudication.resolution = 'resolved_disagreement';
  const resolved = promotionGate(routeDisagreement, frozenFamilyOptions());
  assert.equal(resolved.evidenceReady, true, resolved.errors.join('\n'));

  const unorderedRouteSets = fixtureRecord();
  unorderedRouteSets.cases[0].annotations[0].acceptableRoutes = ['route-a', 'route-b'];
  unorderedRouteSets.cases[0].annotations[1].acceptableRoutes = ['route-b', 'route-a'];
  unorderedRouteSets.cases[0].adjudication.acceptableRoutes = ['route-b', 'route-a'];
  const equivalent = promotionGate(unorderedRouteSets, frozenFamilyOptions());
  assert.equal(equivalent.evidenceReady, true, equivalent.errors.join('\n'));
});

test('missing or unverified score dimensions block promotion', () => {
  const record = fixtureRecord();
  record.runs[0].scores.accuracy = 'unverified';
  assert.ok(validateAdjudication(record).some((e) => e.includes('missing or unverified outcomes')));
});

test('duplicate family tags cannot inflate the 50-case family minimum', () => {
  const record = fixtureRecord();
  for (const item of record.cases) item.familyIds = ['family-1', 'family-1'];
  const errors = validateAdjudication(record, frozenFamilyOptions(['family-2']));
  assert.ok(errors.some((e) => e.includes('distinct non-empty family IDs')));
  assert.ok(errors.some((e) => e.includes('family.family-2')));
});

test('outcome labels must match the versioned score schema', () => {
  const record = fixtureRecord();
  record.runs[0].scores.routing = 'perfect';
  assert.ok(validateAdjudication(record).some((e) => e.includes('unknown outcome label')));
});

test('schema-invalid truthy values and unknown fields cannot make evidence ready', () => {
  const mutations = [
    ['non-string dataset ID', (record) => { record.datasetId = {}; }, 'datasetId:'],
    ['non-string catalog version', (record) => { record.catalogVersion = {}; }, 'catalogVersion:'],
    ['non-string digest with unsafe coercion', (record) => { record.datasetSha256 = { toString: 'not-callable' }; }, 'datasetSha256:'],
    ['invalid split freeze time', (record) => { record.splitPlan.frozenAt = 'yesterday'; }, 'splitPlan.frozenAt:'],
    ['invalid calendar date', (record) => { record.splitPlan.frozenAt = '2026-02-30T12:00:00Z'; }, 'splitPlan.frozenAt:'],
    ['unknown record field', (record) => { record.unreviewed = true; }, 'record.unreviewed:'],
    ['unknown split field', (record) => { record.splitPlan.unreviewed = true; }, 'splitPlan.unreviewed:'],
    ['unknown case field', (record) => { record.cases[0].unreviewed = true; }, 'cases[0].unreviewed:'],
    ['non-string case ID with unsafe coercion', (record) => { record.cases[0].caseId = { toString: 'not-callable' }; }, 'cases[0].caseId:'],
    ['non-string source reference', (record) => { record.cases[0].source.reference = {}; }, 'cases[0].source.reference:'],
    ['non-string source reviewer', (record) => { record.cases[0].source.reviewerId = {}; }, 'cases[0].source.reviewerId:'],
    ['unknown source field', (record) => { record.cases[0].source.unreviewed = true; }, 'cases[0].source.unreviewed:'],
    ['object annotation route', (record) => { record.cases[0].annotations[0].acceptableRoutes = [{}]; }, 'cases[0].annotations[0].acceptableRoutes[0]:'],
    ['sparse annotation route', (record) => { record.cases[0].annotations[0].acceptableRoutes = Array(1); }, 'cases[0].annotations[0].acceptableRoutes[0]:'],
    ['object annotation sequence route', (record) => { record.cases[0].annotations[0].acceptableSequences = [[{}]]; }, 'cases[0].annotations[0].acceptableSequences[0][0]:'],
    ['empty annotation sequence', (record) => { record.cases[0].annotations[0].acceptableSequences = [[]]; }, 'cases[0].annotations[0].acceptableSequences[0]:'],
    ['unknown annotation field', (record) => { record.cases[0].annotations[0].unreviewed = true; }, 'cases[0].annotations[0].unreviewed:'],
    ['object adjudicated route', (record) => { record.cases[0].adjudication.acceptableRoutes = [{}]; }, 'cases[0].adjudication.acceptableRoutes[0]:'],
    ['object adjudicated sequence route', (record) => { record.cases[0].adjudication.acceptableSequences = [[{}]]; }, 'cases[0].adjudication.acceptableSequences[0][0]:'],
    ['unknown adjudication field', (record) => { record.cases[0].adjudication.unreviewed = true; }, 'cases[0].adjudication.unreviewed:'],
    ['non-string oracle reference', (record) => { record.cases[0].oracles.factual.reference = {}; }, 'cases[0].oracles.factual.reference:'],
    ['non-string oracle version', (record) => { record.cases[0].oracles.execution.version = {}; }, 'cases[0].oracles.execution.version:'],
    ['unknown oracles container field', (record) => { record.cases[0].oracles.unreviewed = true; }, 'cases[0].oracles.unreviewed:'],
    ['unknown oracle field', (record) => { record.cases[0].oracles.factual.unreviewed = true; }, 'cases[0].oracles.factual.unreviewed:'],
    ['unknown score field', (record) => { record.runs[0].scores.unreviewed = true; }, 'runs[0].scores.unreviewed:'],
    ['non-string run split with unsafe coercion', (record) => { record.runs[0].split = { toString: 'not-callable' }; }, 'runs[0].split:'],
    ['unknown run field', (record) => { record.runs[0].unreviewed = true; }, 'runs[0].unreviewed:'],
    ['null run', (record) => { record.runs[0] = null; }, 'runs[0]:'],
  ];
  for (const [name, mutate, expectedPath] of mutations) {
    const record = fixtureRecord();
    mutate(record);
    const result = promotionGate(record, frozenFamilyOptions());
    assert.equal(result.evidenceReady, false, name);
    assert.equal(result.promotionAllowed, false, name);
    assert.ok(result.errors.some((error) => error.startsWith(expectedPath)), `${name}: ${result.errors.join('\n')}`);
  }
});

test('malformed reporting mode fails closed without coercion', () => {
  for (const mode of [null, undefined, { toString: 'not-callable' }]) {
    const result = promotionGate(fixtureRecord(), { mode, ...frozenFamilyOptions() });
    assert.equal(result.evidenceReady, false);
    assert.ok(result.errors.some((error) => error.startsWith('mode:')));
  }
});

test('missing nested schema fields fail closed', () => {
  const record = fixtureRecord();
  delete record.cases[0].annotations[0].notes;
  delete record.cases[0].adjudication.acceptableSequences;
  delete record.cases[0].oracles.execution.version;
  delete record.runs[0].scores.cost;
  const result = promotionGate(record, frozenFamilyOptions());
  assert.equal(result.evidenceReady, false);
  for (const path of [
    'cases[0].annotations[0].notes:',
    'cases[0].adjudication.acceptableSequences:',
    'cases[0].oracles.execution.version:',
    'runs[0].scores.cost:',
  ]) assert.ok(result.errors.some((error) => error.startsWith(path)), path);
});

test('malformed records fail closed with a report instead of crashing', () => {
  const result = promotionGate({ cases: [null], runs: null });
  assert.equal(result.evidenceReady, false);
  assert.equal(result.promotionAllowed, false);
  assert.equal(result.report.cases, 0);
});
