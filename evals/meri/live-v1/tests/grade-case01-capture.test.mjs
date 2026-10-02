import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './case01-authority.test.mjs';
import {
  gradeCase01CapturedOutcome,
  inspectCase01SavedEvidence,
  inspectCase01HumanAdjudication,
} from '../grade-case01-capture.mjs';
import { sha256Bytes } from '../artifact-collector.mjs';

// Pure UNIT data only. This does not create the process-owned LIVE capability.
function unit() {
  const { joins } = fixture();
  joins.answer = 'Monthly briefs by FY and budget stage with citations and an action owner.';
  joins.authority.answerSha256 = sha256Bytes(joins.answer);
  return joins;
}
test('case01 accepts exact facts plus actual physical/version citation without logical fixture alias in prose', () => {
  const inputs = unit();
  assert.equal(inputs.answer.includes('MA1-v2'), false);
  assert.deepEqual(inspectCase01SavedEvidence(inputs).defects, []);
  assert.equal(inspectCase01SavedEvidence(inputs).status, 'SAVED_CHECKS_ONLY');
});
for (const [name, mutate] of [
  [
    'no actual citation',
    (v) => {
      v.citations = [];
    },
  ],
  [
    'foreign physical citation',
    (v) => {
      v.citations[0].id = 'foreign';
    },
  ],
  [
    'wrong version',
    (v) => {
      v.citations[0].source.version = 'memory-version:old';
    },
  ],
])
  test(`case01 calibrated grading rejects ${name}`, () => {
    const inputs = unit();
    mutate(inputs);
    assert.throws(() => inspectCase01SavedEvidence(inputs), /CASE01_CITATION/);
  });
for (const fact of ['Monthly', 'FY', 'budget stage', 'citations', 'action owner'])
  test(`case01 still requires ${fact}`, () => {
    const inputs = unit();
    inputs.answer = inputs.answer.replace(fact, 'omitted');
    inputs.authority.answerSha256 = sha256Bytes(inputs.answer);
    assert.ok(inspectCase01SavedEvidence(inputs).defects.length);
  });
test('serialized UNIT lookalikes cannot be graded as LIVE even with a manual-looking rubric', () => {
  for (const fake of [
    { status: 'CAPTURE_COMPLETE', caseId: '01', evidence: unit() },
    { provenance: 'LIVE_CAPTURE' },
  ])
    assert.throws(
      () => gradeCase01CapturedOutcome(fake, { humanAdjudication: { reviewer: 'person' } }),
      /AUTHENTICATED_OUTCOME_REQUIRED/,
    );
});
const binding = {
  captureRunId: 'run',
  caseId: '01',
  turnId: 'turn',
  answerSha256: 'a'.repeat(64),
  evidenceSha256: 'b'.repeat(64),
  completedAt: 1_000_000,
};
const human = () => ({
  schemaVersion: 1,
  kind: 'meri-case01-human-adjudication',
  reviewer: 'human reviewer',
  rationale: 'Reviewed all five dimensions against the saved answer and cited source.',
  reviewedAt: new Date(1_000_100).toISOString(),
  ...binding,
  scores: {
    factual_support: 2,
    evidence_coverage_citation_validity: 2,
    client_relevance: 2,
    directness_clarity: 1,
    actionable_judgment: 1,
  },
});
test('manual rubric requires >=8 and no zero, preserves exact immutable evidence binding', () => {
  assert.equal(inspectCase01HumanAdjudication(human(), binding, 1_000_200).meetsRubric, true);
  const low = human();
  low.scores.factual_support = 0;
  assert.equal(inspectCase01HumanAdjudication(low, binding, 1_000_200).meetsRubric, false);
});
for (const [name, mutate] of [
  [
    'wrong evidence',
    (v) => {
      v.evidenceSha256 = 'c'.repeat(64);
    },
  ],
  [
    'wrong turn',
    (v) => {
      v.turnId = 'another';
    },
  ],
  [
    'missing dimension',
    (v) => {
      delete v.scores.client_relevance;
    },
  ],
  [
    'fractional score',
    (v) => {
      v.scores.client_relevance = 1.5;
    },
  ],
  [
    'blank reviewer',
    (v) => {
      v.reviewer = ' ';
    },
  ],
  [
    'before capture',
    (v) => {
      v.reviewedAt = new Date(1).toISOString();
    },
  ],
  [
    'future review',
    (v) => {
      v.reviewedAt = new Date(2_000_000).toISOString();
    },
  ],
])
  test(`manual rubric rejects ${name}`, () => {
    const value = human();
    mutate(value);
    assert.throws(() => inspectCase01HumanAdjudication(value, binding, 1_000_200));
  });
