import {
  currentCase14ApprovalAuthority,
  currentCase14RecallUiAuthority,
} from './case14-approval-capture.mjs';
import { currentCase14RecallAuthority } from './case01-live-capture.mjs';
import { sha256Stable } from './artifact-collector.mjs';

/** Grading consumes the same owned bytes and submits no turn or decision. */
export function gradeCase14CapturedOutcome({
  approvalOutcome,
  recallOutcome,
  recallUiOutcome,
  visualReview,
}) {
  const approval = currentCase14ApprovalAuthority(approvalOutcome),
    recall = currentCase14RecallAuthority(recallOutcome),
    ui = currentCase14RecallUiAuthority(recallUiOutcome);
  const source = recall.joins.source,
    owner = approval.after.fixtureEvidence,
    authority = recall.evidence.inputs.authority;
  if (
    approval.captureRunId !== recallOutcome.captureRunId ||
    ui.captureRunId !== recallOutcome.captureRunId ||
    owner.item.id !== source.physicalId ||
    owner.item.sourceVersion !== source.sourceVersion ||
    owner.decision.transitionAuditId !== authority.fixture.decision.transitionAuditId ||
    owner.reviewerUserId !== authority.actorUserId ||
    ui.conversationId !== authority.conversationId ||
    ui.answerSha256 !== authority.answerSha256 ||
    !recall.evidence.inputs.answer.includes(owner.text) ||
    recall.evidence.synthesisSubmissionCount !== 1 ||
    ui.visible !== true ||
    ui.sessionRevoked !== true ||
    ui.applicationWrites !== 0 ||
    ui.synthesisSubmissionCount !== 0
  )
    throw new Error('CASE14_APPROVAL_RECALL_JOIN_FAILED');
  const evidenceSha256 = sha256Stable({
    approval: approvalOutcome.evidence,
    recall: recallOutcome.evidence,
    ui: recallUiOutcome.evidence,
  });
  const base = {
    caseId: '14',
    captureRunId: recallOutcome.captureRunId,
    evidenceSha256,
    deterministicStatus: 'PASS',
    approvalSubmissions: 1,
    synthesisSubmissionCount: 1,
    fullFile01Acceptance: false,
  };
  if (!visualReview) return { ...base, status: 'NOT_RUN', reason: 'SAVED_VISUAL_REVIEW_REQUIRED' };
  const hashes = [...approval.screenshots.map((x) => x.sha256), ui.screenshot.sha256].sort();
  const reviewed = Date.parse(visualReview.reviewedAt);
  if (
    visualReview.kind !== 'meri-case14-visual-review' ||
    visualReview.caseId !== '14' ||
    visualReview.captureRunId !== recallOutcome.captureRunId ||
    visualReview.evidenceSha256 !== evidenceSha256 ||
    typeof visualReview.reviewer !== 'string' ||
    !visualReview.reviewer.trim() ||
    typeof visualReview.reference !== 'string' ||
    !visualReview.reference.trim() ||
    typeof visualReview.rationale !== 'string' ||
    !visualReview.rationale.trim() ||
    !Number.isFinite(reviewed) ||
    reviewed < Math.max(approval.completedAt, ui.completedAt) ||
    reviewed > Date.now() ||
    !Array.isArray(visualReview.screenshotSha256s) ||
    sha256Stable([...visualReview.screenshotSha256s].sort()) !== sha256Stable(hashes) ||
    typeof visualReview.approvalAndDurableReceiptVisibleInMeri !== 'boolean' ||
    typeof visualReview.nextTurnRecallAndCitationVisible !== 'boolean'
  )
    return { ...base, status: 'BLOCKED', reason: 'SAVED_VISUAL_REVIEW_INVALID' };
  return {
    ...base,
    status:
      visualReview.approvalAndDurableReceiptVisibleInMeri &&
      visualReview.nextTurnRecallAndCitationVisible
        ? 'PASS'
        : 'FAIL',
    reason: 'CASE14_ONLY',
  };
}
