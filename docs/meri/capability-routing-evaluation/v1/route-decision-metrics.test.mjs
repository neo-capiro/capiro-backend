import test from 'node:test';
import assert from 'node:assert/strict';
import { familyFreezeSha256, splitMembershipSha256 } from './adjudication-gate.mjs';
import { routeDecisionCatalogSha256, routeDecisionMetricsPreflight } from './route-decision-metrics.mjs';

const H = 'a'.repeat(64);
function syntheticFixture() {
  const catalog = { version: 'catalog.test.v1', toolIds: ['tool-a', 'tool-b', 'create_client', 'lookup_client_registry'] };
  const familyFreeze = {
    version: 'families.test.v1', frozenAt: '2026-09-25T11:00:00Z', reference: 'synthetic-protected-record',
    familyIds: ['family-1', 'family-2', 'family-3', 'family-4', 'family-5', 'family-6'],
  };
  const cases = Array.from({ length: 300 }, (_, index) => ({
    caseId: `R-${String(index + 1).padStart(3, '0')}`,
    naturalLanguage: true,
    familyIds: [`family-${Math.floor(index / 50) + 1}`],
    split: ['locked_holdout', 'development', 'calibration'][index % 3],
    source: { kind: 'authoritative_fixture', reference: `source-${index}`, contentSha256: H, reviewerId: `source-reviewer-${index}` },
    annotations: [
      { annotatorId: `annotator-a-${index}`, independent: true, acceptableRoutes: ['tool-a'], acceptableSequences: [['tool-a']], notes: '' },
      { annotatorId: `annotator-b-${index}`, independent: true, acceptableRoutes: ['tool-a'], acceptableSequences: [['tool-a']], notes: '' },
    ],
    adjudication: { reviewerId: `adjudicator-${index}`, resolution: 'agreement', acceptableRoutes: ['tool-a'], acceptableSequences: [['tool-a']] },
    oracles: {
      execution: { status: 'available', reference: `execution-${index}`, version: 'synthetic.v1', sha256: H },
      factual: { status: 'available', reference: `factual-${index}`, version: 'synthetic.v1', sha256: H },
    },
  }));
  const holdout = cases.filter((item) => item.split === 'locked_holdout');
  const record = {
    schemaVersion: 'meri-capability-routing-adjudication.v1', datasetId: 'synthetic-only', datasetSha256: H,
    catalogVersion: catalog.version,
    splitPlan: { version: 'synthetic.v1', frozenAt: '2026-09-25T12:00:00Z', membershipSha256: splitMembershipSha256(cases) },
    cases,
    runs: holdout.map((item) => ({
      caseId: item.caseId, split: item.split,
      scores: {
        routing: 'correct', execution: 'usable_evidence', answer: 'supported', accuracy: 'reference_verified',
        coverage: 'complete_for_declared_scope', cost: 0.01, latency: 100,
      },
    })),
  };
  const options = {
    mode: 'locked_holdout', familyFreeze, trustedFamilyFreezeSha256: familyFreezeSha256(familyFreeze),
    catalog, trustedCatalogSha256: routeDecisionCatalogSha256(catalog),
    trustedCandidateManifest: {
      version: 'synthetic-candidate.v1', sha256: H, frozenAt: '2026-09-25T12:30:00Z',
      reference: 'synthetic-protected-candidate-freeze', evaluationBatchId: 'synthetic-batch-001',
      catalogSha256: routeDecisionCatalogSha256(catalog),
    },
  };
  const receiptSet = {
    schemaVersion: 'meri-route-decision-receipts.v1', datasetId: record.datasetId, datasetSha256: record.datasetSha256,
    catalogVersion: record.catalogVersion, catalogSha256: options.trustedCatalogSha256,
    splitMembershipSha256: record.splitPlan.membershipSha256, familyFreezeSha256: options.trustedFamilyFreezeSha256,
    candidateManifestVersion: options.trustedCandidateManifest.version,
    candidateManifestSha256: options.trustedCandidateManifest.sha256,
    evaluationBatchId: options.trustedCandidateManifest.evaluationBatchId,
    mode: 'locked_holdout',
    decisions: holdout.map((item) => ({
      caseId: item.caseId, split: item.split, producerId: 'synthetic-runner',
      reference: `synthetic-decision-${item.caseId}`, contentSha256: H, capturedAt: '2026-09-25T13:00:00Z',
      candidateManifestVersion: options.trustedCandidateManifest.version,
      candidateManifestSha256: options.trustedCandidateManifest.sha256,
      evaluationBatchId: options.trustedCandidateManifest.evaluationBatchId,
      disposition: 'accepted', proposal: { label: 'tool-a', sequence: ['tool-a'] },
      selection: { label: 'tool-a', sequence: ['tool-a'] },
      candidateExposedToolIds: ['tool-a'], fallbackReason: null,
    })),
    requiredCapabilityOracles: holdout.map((item) => ({
      caseId: item.caseId, reviewerId: `required-reviewer-${item.caseId}`,
      reference: `synthetic-required-${item.caseId}`, version: 'synthetic.v1', contentSha256: H,
      requiredToolIds: ['tool-a'],
    })),
  };
  return { record, receiptSet, options };
}

test('synthetic structural fixture reports recomputed rates but never promotes', () => {
  const { record, receiptSet, options } = syntheticFixture();
  const result = routeDecisionMetricsPreflight(record, receiptSet, options);
  assert.equal(result.structuralReady, true, result.errors.join('\n'));
  assert.equal(result.metricInputsComplete, true, result.blockers.join('\n'));
  assert.equal(result.evidenceAuthenticated, false);
  assert.equal(result.promotionAllowed, false);
  assert.deepEqual(result.report.overall, { cases: 100, acceptableWorkflows: 100, rate: 1 });
  assert.deepEqual(result.report.acceptedDecisionPrecision, { accepted: 100, acceptable: 100, rate: 1 });
  assert.deepEqual(result.report.requiredCapabilityRecall, { required: 100, retained: 100, rate: 1 });
});

test('fallback is not an accepted correct route or retained candidate capability', () => {
  const { record, receiptSet, options } = syntheticFixture();
  receiptSet.decisions[0].disposition = 'fallback';
  receiptSet.decisions[0].proposal = null;
  receiptSet.decisions[0].selection = null;
  receiptSet.decisions[0].candidateExposedToolIds = [];
  receiptSet.decisions[0].fallbackReason = 'provider_unavailable';
  record.runs[0].scores.routing = 'incorrect';
  const result = routeDecisionMetricsPreflight(record, receiptSet, options);
  assert.equal(result.structuralReady, true, result.errors.join('\n'));
  assert.equal(result.report.overall.acceptableWorkflows, 99);
  assert.equal(result.report.acceptedDecisionPrecision.accepted, 99);
  assert.equal(result.report.fallback.count, 1);
  assert.deepEqual(result.report.requiredCapabilityRecall, { required: 100, retained: 99, rate: 0.99 });
});

test('missing independent required-capability oracle leaves recall null with a blocker', () => {
  const { record, receiptSet, options } = syntheticFixture();
  receiptSet.requiredCapabilityOracles.shift();
  const result = routeDecisionMetricsPreflight(record, receiptSet, options);
  assert.equal(result.structuralReady, true, result.errors.join('\n'));
  assert.equal(result.metricInputsComplete, false);
  assert.equal(result.report.requiredCapabilityRecall.rate, null);
  assert.ok(result.blockers.some((item) => item.startsWith('independent_required_capability_oracle_missing:')));
});

test('a route label alone cannot pass a required prerequisite sequence', () => {
  const { record, receiptSet, options } = syntheticFixture();
  const item = record.cases[0];
  for (const annotation of item.annotations) {
    annotation.acceptableRoutes = ['create_client'];
    annotation.acceptableSequences = [['lookup_client_registry', 'create_client']];
  }
  item.adjudication.acceptableRoutes = ['create_client'];
  item.adjudication.acceptableSequences = [['lookup_client_registry', 'create_client']];
  receiptSet.requiredCapabilityOracles[0].requiredToolIds = ['lookup_client_registry', 'create_client'];
  receiptSet.decisions[0].proposal = { label: 'create_client', sequence: ['create_client'] };
  receiptSet.decisions[0].selection = { label: 'create_client', sequence: ['create_client'] };
  receiptSet.decisions[0].candidateExposedToolIds = ['create_client'];
  record.runs[0].scores.routing = 'incorrect';
  const result = routeDecisionMetricsPreflight(record, receiptSet, options);
  assert.equal(result.structuralReady, true, result.errors.join('\n'));
  assert.equal(result.report.overall.acceptableWorkflows, 99);
  assert.deepEqual(result.report.requiredCapabilityRecall, { required: 101, retained: 100, rate: 100 / 101 });

  // An oracle that omits the registry prerequisite cannot shrink the recall
  // denominator and claim 100% recall for the incomplete candidate set.
  receiptSet.requiredCapabilityOracles[0].requiredToolIds = ['create_client'];
  const omittedPrerequisite = routeDecisionMetricsPreflight(record, receiptSet, options);
  assert.equal(omittedPrerequisite.structuralReady, false);
  assert.equal(omittedPrerequisite.report.requiredCapabilityRecall.rate, null);
  assert.ok(omittedPrerequisite.errors.some((item) => item.includes('must exactly match tools common')));
});

test('ordered alternatives are compared exactly, not as an unordered tool set', () => {
  const { record, receiptSet, options } = syntheticFixture();
  const item = record.cases[0];
  for (const annotation of item.annotations) {
    annotation.acceptableRoutes = ['multi_intent'];
    annotation.acceptableSequences = [['tool-a', 'tool-b']];
  }
  item.adjudication.acceptableRoutes = ['multi_intent'];
  item.adjudication.acceptableSequences = [['tool-a', 'tool-b']];
  receiptSet.requiredCapabilityOracles[0].requiredToolIds = ['tool-a', 'tool-b'];
  receiptSet.decisions[0].proposal = { label: 'multi_intent', sequence: ['tool-b', 'tool-a'] };
  receiptSet.decisions[0].selection = { label: 'multi_intent', sequence: ['tool-b', 'tool-a'] };
  receiptSet.decisions[0].candidateExposedToolIds = ['tool-a', 'tool-b'];
  record.runs[0].scores.routing = 'incorrect';
  const result = routeDecisionMetricsPreflight(record, receiptSet, options);
  assert.equal(result.structuralReady, true, result.errors.join('\n'));
  assert.equal(result.report.overall.acceptableWorkflows, 99);
});

test('disjunctive tool-set alternatives keep workflow metrics but block recall', () => {
  const { record, receiptSet, options } = syntheticFixture();
  const item = record.cases[0];
  const alternatives = [['tool-a', 'tool-b'], ['tool-a', 'create_client']];
  for (const annotation of item.annotations) {
    annotation.acceptableRoutes = ['multi_intent'];
    annotation.acceptableSequences = alternatives;
  }
  item.adjudication.acceptableRoutes = ['multi_intent'];
  item.adjudication.acceptableSequences = alternatives;
  receiptSet.requiredCapabilityOracles[0].requiredToolIds = ['tool-a'];
  receiptSet.decisions[0].proposal = { label: 'multi_intent', sequence: ['tool-a'] };
  receiptSet.decisions[0].selection = { label: 'multi_intent', sequence: ['tool-a'] };
  receiptSet.decisions[0].candidateExposedToolIds = ['tool-a'];
  record.runs[0].scores.routing = 'incorrect';
  const result = routeDecisionMetricsPreflight(record, receiptSet, options);
  assert.equal(result.structuralReady, true, result.errors.join('\n'));
  assert.equal(result.metricInputsComplete, false);
  assert.equal(result.report.overall.acceptableWorkflows, 99);
  assert.deepEqual(result.report.requiredCapabilityRecall, { required: null, retained: null, rate: null });
  assert.ok(result.blockers.some((blocker) => blocker.startsWith('disjunctive_required_capability_coverage_oracle_missing:')));
});

test('ordering-only alternatives retain a known required-tool denominator', () => {
  const { record, receiptSet, options } = syntheticFixture();
  const item = record.cases[0];
  const alternatives = [['tool-a', 'tool-b'], ['tool-b', 'tool-a']];
  for (const annotation of item.annotations) {
    annotation.acceptableRoutes = ['multi_intent'];
    annotation.acceptableSequences = alternatives;
  }
  item.adjudication.acceptableRoutes = ['multi_intent'];
  item.adjudication.acceptableSequences = alternatives;
  receiptSet.requiredCapabilityOracles[0].requiredToolIds = ['tool-a', 'tool-b'];
  receiptSet.decisions[0].proposal = { label: 'multi_intent', sequence: ['tool-a', 'tool-b'] };
  receiptSet.decisions[0].selection = { label: 'multi_intent', sequence: ['tool-a', 'tool-b'] };
  receiptSet.decisions[0].candidateExposedToolIds = ['tool-a', 'tool-b'];
  const result = routeDecisionMetricsPreflight(record, receiptSet, options);
  assert.equal(result.structuralReady, true, result.errors.join('\n'));
  assert.equal(result.metricInputsComplete, true, result.blockers.join('\n'));
  assert.deepEqual(result.report.requiredCapabilityRecall, { required: 101, retained: 101, rate: 1 });
});

test('unpaired multi-label route and sequence alternatives cannot score a cross-product', () => {
  const { record, receiptSet, options } = syntheticFixture();
  const item = record.cases[0];
  for (const annotation of item.annotations) {
    annotation.acceptableRoutes = ['tool-a', 'tool-b'];
    annotation.acceptableSequences = [['tool-a'], ['tool-b']];
  }
  item.adjudication.acceptableRoutes = ['tool-a', 'tool-b'];
  item.adjudication.acceptableSequences = [['tool-a'], ['tool-b']];
  receiptSet.requiredCapabilityOracles[0].requiredToolIds = [];
  receiptSet.decisions[0].proposal = { label: 'tool-a', sequence: ['tool-b'] };
  receiptSet.decisions[0].selection = { label: 'tool-a', sequence: ['tool-b'] };
  receiptSet.decisions[0].candidateExposedToolIds = ['tool-a', 'tool-b'];
  const result = routeDecisionMetricsPreflight(record, receiptSet, options);
  assert.equal(result.structuralReady, false);
  assert.ok(result.errors.some((item) => item.includes('route labels and sequences are unpaired')));
});

test('a single executable route cannot be paired with a sequence that omits it', () => {
  const { record, receiptSet, options } = syntheticFixture();
  const item = record.cases[0];
  for (const annotation of item.annotations) {
    annotation.acceptableRoutes = ['create_client'];
    annotation.acceptableSequences = [['lookup_client_registry']];
  }
  item.adjudication.acceptableRoutes = ['create_client'];
  item.adjudication.acceptableSequences = [['lookup_client_registry']];
  receiptSet.requiredCapabilityOracles[0].requiredToolIds = ['lookup_client_registry'];
  receiptSet.decisions[0].proposal = { label: 'create_client', sequence: ['lookup_client_registry'] };
  receiptSet.decisions[0].selection = { label: 'create_client', sequence: ['lookup_client_registry'] };
  receiptSet.decisions[0].candidateExposedToolIds = ['create_client', 'lookup_client_registry'];
  const result = routeDecisionMetricsPreflight(record, receiptSet, options);
  assert.equal(result.structuralReady, false);
  assert.ok(result.errors.some((item) => item.includes('executable route label must appear')));
});

test('repeated tool IDs in an ordered sequence match the v1 adjudication contract', () => {
  const { record, receiptSet, options } = syntheticFixture();
  const item = record.cases[0];
  for (const annotation of item.annotations) annotation.acceptableSequences = [['tool-a', 'tool-a']];
  item.adjudication.acceptableSequences = [['tool-a', 'tool-a']];
  receiptSet.decisions[0].proposal.sequence = ['tool-a', 'tool-a'];
  receiptSet.decisions[0].selection.sequence = ['tool-a', 'tool-a'];
  const result = routeDecisionMetricsPreflight(record, receiptSet, options);
  assert.equal(result.structuralReady, true, result.errors.join('\n'));
  assert.equal(result.report.overall.acceptableWorkflows, 100);
});

test('a valid clarification route needs no executable sequence, while execution remains separate', () => {
  const { record, receiptSet, options } = syntheticFixture();
  const item = record.cases[0];
  for (const annotation of item.annotations) {
    annotation.acceptableRoutes = ['needs_context'];
    annotation.acceptableSequences = [];
  }
  item.adjudication.acceptableRoutes = ['needs_context'];
  item.adjudication.acceptableSequences = [];
  receiptSet.requiredCapabilityOracles[0].requiredToolIds = [];
  receiptSet.decisions[0].proposal = { label: 'needs_context', sequence: [] };
  receiptSet.decisions[0].selection = { label: 'needs_context', sequence: [] };
  receiptSet.decisions[0].candidateExposedToolIds = [];
  record.runs[0].scores.routing = 'clarification_required';
  record.runs[0].scores.execution = 'not_exercised';
  const result = routeDecisionMetricsPreflight(record, receiptSet, options);
  assert.equal(result.structuralReady, true, result.errors.join('\n'));
  assert.equal(result.report.overall.acceptableWorkflows, 100);

  const permissionDenied = syntheticFixture();
  permissionDenied.record.runs[0].scores.execution = 'failed';
  permissionDenied.record.runs[0].scores.answer = 'appropriately_limited';
  const separate = routeDecisionMetricsPreflight(permissionDenied.record, permissionDenied.receiptSet, permissionDenied.options);
  assert.equal(separate.structuralReady, true, separate.errors.join('\n'));
  assert.equal(separate.report.overall.acceptableWorkflows, 100);
});

test('self-reported correct score cannot contradict a fallback or wrong sequence', () => {
  const { record, receiptSet, options } = syntheticFixture();
  receiptSet.decisions[0].selection.sequence = ['tool-b'];
  receiptSet.decisions[0].proposal.sequence = ['tool-b'];
  receiptSet.decisions[0].candidateExposedToolIds = ['tool-a', 'tool-b'];
  const result = routeDecisionMetricsPreflight(record, receiptSet, options);
  assert.equal(result.structuralReady, false);
  assert.ok(result.errors.some((item) => item.includes('claimed success contradicts')));
  assert.equal(result.report.overall.rate, null);
});

test('missing, duplicate, cross-split, and unbound receipts fail closed', () => {
  const cases = [
    (fixture) => { fixture.receiptSet.decisions.pop(); },
    (fixture) => { fixture.receiptSet.decisions.push(fixture.receiptSet.decisions[0]); },
    (fixture) => { fixture.receiptSet.decisions[0].split = 'development'; },
    (fixture) => { fixture.receiptSet.datasetSha256 = 'b'.repeat(64); },
    (fixture) => { fixture.receiptSet.catalogSha256 = 'b'.repeat(64); },
    (fixture) => { fixture.receiptSet.familyFreezeSha256 = 'b'.repeat(64); },
    (fixture) => { fixture.receiptSet.splitMembershipSha256 = 'b'.repeat(64); },
    (fixture) => { fixture.receiptSet.candidateManifestSha256 = 'b'.repeat(64); },
    (fixture) => { fixture.receiptSet.decisions[0].candidateManifestVersion = 'other-candidate'; },
    (fixture) => { fixture.receiptSet.decisions[0].candidateManifestSha256 = 'b'.repeat(64); },
    (fixture) => { fixture.receiptSet.decisions[0].evaluationBatchId = 'other-batch'; },
    (fixture) => { fixture.receiptSet.decisions[0].evaluationBatchId = ' synthetic-batch-001 '; },
    (fixture) => { fixture.receiptSet.decisions[0].reference = '   '; },
    (fixture) => { fixture.receiptSet.decisions[0].contentSha256 = 'not-a-hash'; },
    (fixture) => { fixture.receiptSet.decisions[0].capturedAt = '2026-02-30T00:00:00Z'; },
    (fixture) => { fixture.receiptSet.decisions[0].capturedAt = '2026-09-25T12:29:59Z'; },
    (fixture) => { fixture.receiptSet.decisions[0].disposition = 'fallback'; fixture.receiptSet.decisions[0].fallbackReason = 'unsupported'; },
    (fixture) => { fixture.receiptSet.requiredCapabilityOracles[0].reviewerId = 'synthetic-runner'; },
  ];
  for (const mutate of cases) {
    const fixture = syntheticFixture();
    mutate(fixture);
    const result = routeDecisionMetricsPreflight(fixture.record, fixture.receiptSet, fixture.options);
    assert.equal(result.structuralReady, false);
    assert.equal(result.promotionAllowed, false);
  }
});

test('one protected decision reference cannot be reused for another case or conflicting digest', () => {
  const { record, receiptSet, options } = syntheticFixture();
  receiptSet.decisions[1].reference = receiptSet.decisions[0].reference;
  receiptSet.decisions[1].contentSha256 = 'b'.repeat(64);
  const result = routeDecisionMetricsPreflight(record, receiptSet, options);
  assert.equal(result.structuralReady, false);
  assert.equal(result.evidenceAuthenticated, false);
  assert.ok(result.errors.some((item) => item.includes('duplicate protected decision receipt reference')));
  assert.equal(result.report.overall.rate, null);
});

test('one protected required-tool oracle reference cannot be reused across cases', () => {
  const { record, receiptSet, options } = syntheticFixture();
  receiptSet.requiredCapabilityOracles[1].reference = receiptSet.requiredCapabilityOracles[0].reference;
  const result = routeDecisionMetricsPreflight(record, receiptSet, options);
  assert.equal(result.structuralReady, false);
  assert.equal(result.evidenceAuthenticated, false);
  assert.ok(result.errors.some((item) => item.includes('duplicate protected required-capability oracle reference')));
  assert.equal(result.report.requiredCapabilityRecall.rate, null);
});

test('unreviewed executable sequence and inconsistent independent required labels fail closed', () => {
  const unreviewed = syntheticFixture();
  unreviewed.record.cases[0].adjudication.acceptableSequences = [];
  for (const annotation of unreviewed.record.cases[0].annotations) annotation.acceptableSequences = [];
  const missingSequence = routeDecisionMetricsPreflight(unreviewed.record, unreviewed.receiptSet, unreviewed.options);
  assert.equal(missingSequence.structuralReady, false);
  assert.ok(missingSequence.errors.some((item) => item.includes('executable workflow has no sequence oracle')));

  const inconsistent = syntheticFixture();
  inconsistent.receiptSet.requiredCapabilityOracles[0].requiredToolIds = ['tool-b'];
  const badRequired = routeDecisionMetricsPreflight(inconsistent.record, inconsistent.receiptSet, inconsistent.options);
  assert.equal(badRequired.structuralReady, false);
  assert.ok(badRequired.errors.some((item) => item.includes('must exactly match tools common')));
});

test('missing protected catalog digest or an independently reviewed denominator blocks metric claims', () => {
  const untrusted = syntheticFixture();
  delete untrusted.options.trustedCatalogSha256;
  assert.equal(routeDecisionMetricsPreflight(untrusted.record, untrusted.receiptSet, untrusted.options).structuralReady, false);

  const noRequired = syntheticFixture();
  for (const item of noRequired.record.cases.filter((candidate) => candidate.split === 'locked_holdout')) {
    for (const annotation of item.annotations) {
      annotation.acceptableRoutes = ['needs_context'];
      annotation.acceptableSequences = [];
    }
    item.adjudication.acceptableRoutes = ['needs_context'];
    item.adjudication.acceptableSequences = [];
  }
  for (const item of noRequired.record.runs) item.scores.routing = 'clarification_required';
  for (const item of noRequired.receiptSet.decisions) {
    item.proposal = { label: 'needs_context', sequence: [] };
    item.selection = { label: 'needs_context', sequence: [] };
    item.candidateExposedToolIds = [];
  }
  for (const item of noRequired.receiptSet.requiredCapabilityOracles) item.requiredToolIds = [];
  const result = routeDecisionMetricsPreflight(noRequired.record, noRequired.receiptSet, noRequired.options);
  assert.equal(result.structuralReady, true, result.errors.join('\n'));
  assert.equal(result.report.requiredCapabilityRecall.rate, null);
  assert.ok(result.blockers.includes('no_required_capability_denominator'));
});

test('development and calibration mode cannot load this full-record preflight', () => {
  for (const mode of ['development', 'calibration']) {
    const record = { get cases() { throw new Error('holdout record must not be read'); } };
    const result = routeDecisionMetricsPreflight(record, {}, { mode });
    assert.equal(result.structuralReady, false);
    assert.ok(result.errors.some((item) => item.includes('restricted to protected locked_holdout review')));
  }
});
