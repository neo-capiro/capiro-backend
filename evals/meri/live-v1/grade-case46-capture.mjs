import { currentCase46CaptureAuthority } from './case46-live-capture.mjs';
import { assertCase46ReceiptJoins } from './case46-receipt-joins.mjs';
import { sha256Stable } from './artifact-collector.mjs';

const DIMENSIONS = ['factual_support', 'evidence_coverage_citation_validity', 'client_relevance',
  'directness_clarity', 'actionable_judgment'];

/** Offline rubric validation. This pure function does not issue capture authority. */
export function inspectCase46HumanAdjudication(human, binding, now = Date.now()) {
  const reviewed = Date.parse(human?.reviewedAt);
  const invalid = () => { throw new Error('CASE46_HUMAN_ADJUDICATION_INVALID'); };
  if (human?.schemaVersion !== 1 || human.kind !== 'meri-case46-human-adjudication' || human.caseId !== '46' ||
    ['captureRunId', 'turnId', 'answerSha256', 'evidenceSha256'].some(key => human[key] !== binding[key]) ||
    typeof human.reviewer !== 'string' || !human.reviewer.trim() || typeof human.rationale !== 'string' || !human.rationale.trim() ||
    typeof human.reference !== 'string' || !human.reference.trim() || !Number.isFinite(reviewed) ||
    reviewed < binding.completedAt || reviewed > now || !Array.isArray(human.screenshotSha256s) ||
    sha256Stable([...human.screenshotSha256s].sort()) !== sha256Stable([...binding.screenshotSha256s].sort()) ||
    typeof human.approvalAndReceiptVisible !== 'boolean' || typeof human.downloadAndReloadVisible !== 'boolean' ||
    !human.scores || Object.keys(human.scores).sort().join('|') !== [...DIMENSIONS].sort().join('|') ||
    DIMENSIONS.some(key => !Number.isInteger(human.scores[key]) || human.scores[key] < 0 || human.scores[key] > 2)) invalid();
  const total = DIMENSIONS.reduce((sum, key) => sum + human.scores[key], 0);
  return { status: 'RUBRIC_CHECK_ONLY', total, meetsRubric: total >= 8 && DIMENSIONS.every(key => human.scores[key] >= 1) &&
    human.approvalAndReceiptVisible && human.downloadAndReloadVisible };
}

/** Same process and immutable native artifacts only; never submits another turn or approval. */
export function gradeCase46CapturedOutcome(outcome, { humanAdjudication } = {}) {
  const { evidence } = currentCase46CaptureAuthority(outcome);
  const joins = assertCase46ReceiptJoins({ ...evidence.inputs, now: evidence.inputs.now });
  const base = { caseId: '46', captureRunId: outcome.captureRunId, evidenceSha256: outcome.evidence.sha256,
    deterministicStatus: 'PASS', synthesisSubmissionCount: outcome.synthesisSubmissionCount,
    approvalSubmissions: 1, artifactEffects: 1, fullFile01Acceptance: false };
  if (!humanAdjudication) return { ...base, status: 'NOT_RUN', reason: 'HUMAN_AND_VISUAL_ADJUDICATION_REQUIRED' };
  try {
    const rubric = inspectCase46HumanAdjudication(humanAdjudication, { caseId: '46', captureRunId: outcome.captureRunId,
      turnId: joins.turnId, answerSha256: evidence.inputs.after.assistant.bodySha256, evidenceSha256: outcome.evidence.sha256,
      completedAt: evidence.completedAt, screenshotSha256s: [evidence.approvalScreenshot.sha256,
        ...evidence.inputs.ui.rounds.map(r => r.screenshot.sha256)] });
    return { ...base, status: rubric.meetsRubric ? 'PASS' : 'FAIL', humanRubricTotal: rubric.total,
      reason: rubric.meetsRubric ? 'CASE46_ONLY' : 'HUMAN_RUBRIC_FAILED' };
  } catch { return { ...base, status: 'BLOCKED', reason: 'HUMAN_ADJUDICATION_INVALID' }; }
}
