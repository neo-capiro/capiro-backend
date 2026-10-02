import { currentCase01CaptureAuthority } from './case01-live-capture.mjs';
import { assertCase01ReceiptJoins } from './case01-receipt-joins.mjs';
import { evaluateCase01SavedFacts } from './deterministic-predicates.mjs';
import { sha256Bytes } from './artifact-collector.mjs';
import { cases } from './cases.mjs';

const dimensions = Object.freeze([
  'factual_support',
  'evidence_coverage_citation_validity',
  'client_relevance',
  'directness_clarity',
  'actionable_judgment',
]);
const row = cases.find((item) => item.id === '01');

/** Pure saved-data checks. These do not confer LIVE authority or acceptance. */
export function inspectCase01SavedEvidence(inputs) {
  const joins = assertCase01ReceiptJoins(inputs);
  if (joins.observedBusinessEffectCount !== 0) throw new Error('CASE01_BUSINESS_EFFECT');
  const { defects } = evaluateCase01SavedFacts({
    answer: inputs.answer,
    passage: inputs.sourceReadback.text,
    testCase: row,
  });
  return { status: 'SAVED_CHECKS_ONLY', defects, turnId: joins.turnId };
}

/** Offline manual rubric validation only; callers cannot mint capture authority. */
export function inspectCase01HumanAdjudication(human, binding, now = Date.now()) {
  const reviewed = Date.parse(human?.reviewedAt);
  if (
    human?.schemaVersion !== 1 ||
    human.kind !== 'meri-case01-human-adjudication' ||
    typeof human.reviewer !== 'string' ||
    !human.reviewer.trim() ||
    typeof human.rationale !== 'string' ||
    !human.rationale.trim() ||
    !Number.isFinite(reviewed) ||
    reviewed > now ||
    reviewed < binding.completedAt ||
    !Number.isSafeInteger(binding.completedAt) ||
    binding.completedAt <= 0 ||
    ['captureRunId', 'caseId', 'turnId', 'answerSha256', 'evidenceSha256'].some(
      (key) => human[key] !== binding[key],
    ) ||
    !human.scores ||
    Object.keys(human.scores).sort().join('|') !== [...dimensions].sort().join('|') ||
    dimensions.some(
      (key) =>
        !Number.isInteger(human.scores[key]) || human.scores[key] < 0 || human.scores[key] > 2,
    )
  )
    throw new Error('CASE01_HUMAN_ADJUDICATION_INVALID');
  const total = dimensions.reduce((sum, key) => sum + human.scores[key], 0);
  return {
    status: 'RUBRIC_CHECK_ONLY',
    total,
    meetsRubric: total >= 8 && dimensions.every((key) => human.scores[key] >= 1),
  };
}

/** Grades the already captured turn. No HTTP, provider, auth, or synthesis call.
 * The process-owned immutable artifact capability must remain open for this read.
 */
export function gradeCase01CapturedOutcome(outcome, { humanAdjudication } = {}) {
  const { joins, evidence } = currentCase01CaptureAuthority(outcome);
  const base = {
    caseId: '01',
    captureRunId: outcome.captureRunId,
    fullFile01Acceptance: false,
    evidenceSha256: outcome.evidence.sha256,
    synthesisSubmissionCount: outcome.synthesisSubmissionCount,
  };
  // Freshness was established by the real transport. Grade at that immutable
  // readback time; manual adjudication must not trigger a second live capture.
  const facts = inspectCase01SavedEvidence({
    ...evidence.inputs,
    now: evidence.inputs.authority.verifiedAt,
  });
  if (joins.observedBusinessEffectCount !== 0) throw new Error('CASE01_BUSINESS_EFFECT');
  if (facts.defects.length)
    return { ...base, status: 'FAIL', deterministicStatus: 'FAIL', defects: facts.defects };
  if (!humanAdjudication)
    return {
      ...base,
      status: 'NOT_RUN',
      deterministicStatus: 'PASS',
      reason: 'HUMAN_ADJUDICATION_REQUIRED',
    };
  try {
    const rubric = inspectCase01HumanAdjudication(humanAdjudication, {
      caseId: '01',
      captureRunId: outcome.captureRunId,
      turnId: joins.turnId,
      answerSha256: sha256Bytes(evidence.inputs.answer),
      evidenceSha256: outcome.evidence.sha256,
      completedAt: evidence.inputs.envelope.receipt.completedAt,
    });
    return {
      ...base,
      status: rubric.meetsRubric ? 'PASS' : 'FAIL',
      deterministicStatus: 'PASS',
      humanRubricTotal: rubric.total,
      reason: rubric.meetsRubric ? 'CASE01_ONLY' : 'HUMAN_RUBRIC_FAILED',
    };
  } catch {
    return {
      ...base,
      status: 'BLOCKED',
      deterministicStatus: 'PASS',
      reason: 'HUMAN_ADJUDICATION_INVALID',
    };
  }
}
