import { currentControlledReadCaptureAuthority } from './controlled-read-live-capture.mjs';
import { assertControlledReadReceiptJoins } from './controlled-read-receipt-joins.mjs';
import { sha256Bytes } from './artifact-collector.mjs';

const dimensions = Object.freeze([
  'factual_support',
  'evidence_coverage_citation_validity',
  'client_relevance',
  'directness_clarity',
  'actionable_judgment',
]);

/** Pure saved-data checks. These do not confer LIVE authority or acceptance. */
export function inspectControlledReadSavedEvidence(inputs) {
  const joins = assertControlledReadReceiptJoins(inputs);
  const caseId = inputs.expected.caseId,
    defects = [];
  const answer = inputs.answer.normalize('NFKC');
  if (joins.observedBusinessEffectCount !== 0) defects.push('BUSINESS_EFFECT');
  if (caseId === '20') {
    if (!/\b0912345T\b/i.test(answer)) defects.push('EXACT_PE_CODE_MISSING');
    if (!/\bFY\s*(?:27|2027)\b/i.test(answer)) defects.push('FISCAL_YEAR_MISSING');
    if (!/\$\s*42\s*(?:M\b|million\b)|\$\s*42,000,000\b/i.test(answer))
      defects.push('REQUEST_AMOUNT_MISSING');
    if (!/President[\u2019']?s\s+Budget\s+request/i.test(answer))
      defects.push('BUDGET_STAGE_MISSING');
    if (!/R2-27/i.test(answer) || !/(?:page|p\.)\s*14\b/i.test(answer))
      defects.push('SOURCE_PAGE_MISSING');
    if (/\b(?:enacted|appropriated|House|Senate)\b/i.test(answer))
      defects.push('UNSUPPORTED_FUNDING_STAGE');
    if (
      !joins.controlledReadAttempts.some(
        (a) => a.fullRead && a.passageSha256 === joins.source.contentSha256,
      )
    )
      defects.push('TITLE_ONLY_READ');
  } else {
    const failures = joins.controlledReadAttempts.filter(
      (a) => a.logicalError === 'document unavailable',
    );
    if (failures.length < 3 || new Set(failures.map((a) => a.responseSha256)).size !== 1)
      defects.push('REPEATED_UNCHANGED_FAILURE_NOT_OBSERVED');
    if (
      !joins.boundedRuntime.acquisitionStopped ||
      joins.boundedRuntime.stopReason !== 'no_progress'
    )
      defects.push('NO_PROGRESS_SUPPRESSION_NOT_OBSERVED');
    if (
      !/document\s+(?:is\s+)?unavailable|(?:could\s+not|couldn[\u2019']t|unable\s+to|cannot|can[\u2019']t)\s+(?:read|access|retrieve|open)/i.test(
        answer,
      )
    )
      defects.push('FAILURE_NOT_DISCLOSED');
    if (
      /(?:successfully\s+(?:read|retrieved|opened)|I\s+(?:have\s+)?(?:read|reviewed)\s+(?:the|Aster))/i.test(
        answer,
      )
    )
      defects.push('FALSE_READ_SUCCESS');
  }
  return {
    status: 'SAVED_CHECKS_ONLY',
    caseId,
    defects,
    turnId: joins.turnId,
    observedTerminal: caseId === '72' ? 'failed' : 'complete',
  };
}

/** Offline manual rubric validation only; callers cannot mint capture authority. */
export function inspectControlledReadHumanAdjudication(human, binding, now = Date.now()) {
  const reviewed = Date.parse(human?.reviewedAt);
  if (
    human?.schemaVersion !== 1 ||
    human.kind !== 'meri-controlled-read-human-adjudication' ||
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
    throw new Error('CONTROLLED_READ_HUMAN_ADJUDICATION_INVALID');
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
export function gradeControlledReadCapturedOutcome(outcome, { humanAdjudication } = {}) {
  const { joins, evidence } = currentControlledReadCaptureAuthority(outcome);
  const base = {
    caseId: outcome.caseId,
    captureRunId: outcome.captureRunId,
    fullFile01Acceptance: false,
    evidenceSha256: outcome.evidence.sha256,
    synthesisSubmissionCount: outcome.synthesisSubmissionCount,
  };
  // Freshness was established by the real transport. Grade at that immutable
  // readback time; manual adjudication must not trigger a second live capture.
  const facts = inspectControlledReadSavedEvidence({
    ...evidence.inputs,
    now: evidence.inputs.authority.verifiedAt,
  });
  if (joins.observedBusinessEffectCount !== 0) throw new Error('CONTROLLED_READ_BUSINESS_EFFECT');
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
    const rubric = inspectControlledReadHumanAdjudication(humanAdjudication, {
      caseId: outcome.caseId,
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
      reason: rubric.meetsRubric ? `CASE_${outcome.caseId}_ONLY` : 'HUMAN_RUBRIC_FAILED',
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
