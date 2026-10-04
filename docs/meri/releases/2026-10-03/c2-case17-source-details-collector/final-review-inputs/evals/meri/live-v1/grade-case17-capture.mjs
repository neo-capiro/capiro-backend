import { currentCase17CaptureAuthority } from './case17-live-capture.mjs';
import { inspectCase17SavedEvidence } from './case17-saved-checks.mjs';
import { sha256Stable } from './lib/stable.mjs';

/** Manual visual review must refer to the saved synthetic cards, not a new run. */
export function inspectCase17VisualReview(review, evidence, evidenceSha256, now = Date.now()) {
  const hashes = evidence.rounds
    .flatMap((round) => round.cards.map((card) => card.screenshot.sha256))
    .sort();
  const reviewed = Date.parse(review?.reviewedAt);
  if (
    review?.schemaVersion !== 1 ||
    review.kind !== 'meri-case17-visual-review' ||
    review.caseId !== '17' ||
    review.captureRunId !== evidence.captureRunId ||
    review.evidenceSha256 !== evidenceSha256 ||
    typeof review.reviewer !== 'string' ||
    !review.reviewer.trim() ||
    typeof review.reference !== 'string' ||
    !review.reference.trim() ||
    typeof review.rationale !== 'string' ||
    !review.rationale.trim() ||
    !Number.isFinite(reviewed) ||
    reviewed < evidence.completedAt ||
    reviewed > now ||
    !Array.isArray(review.screenshotSha256s) ||
    sha256Stable([...review.screenshotSha256s].sort()) !== sha256Stable(hashes) ||
    typeof review.allSixCardsVisibleWithCorrectScopeAndProvenance !== 'boolean' ||
    typeof review.allSixActionsVisibleAfterReload !== 'boolean'
  )
    throw new Error('CASE17_VISUAL_REVIEW_INVALID');
  return {
    status: 'VISUAL_CHECK_ONLY',
    passed:
      review.allSixCardsVisibleWithCorrectScopeAndProvenance &&
      review.allSixActionsVisibleAfterReload,
  };
}

/** Offline only: no browser, HTTP, provider or turn is submitted while grading. */
export function gradeCase17CapturedOutcome(outcome, { visualReview } = {}) {
  const { evidence, descriptor } = currentCase17CaptureAuthority(outcome);
  inspectCase17SavedEvidence(evidence);
  const base = {
    caseId: '17',
    captureRunId: outcome.captureRunId,
    evidenceSha256: descriptor.sha256,
    deterministicStatus: 'PASS',
    synthesisSubmissionCount: 0,
    applicationWrites: 0,
    fullFile01Acceptance: false,
  };
  if (!visualReview) return { ...base, status: 'NOT_RUN', reason: 'SAVED_VISUAL_REVIEW_REQUIRED' };
  try {
    const visual = inspectCase17VisualReview(visualReview, evidence, descriptor.sha256);
    return {
      ...base,
      status: visual.passed ? 'PASS' : 'FAIL',
      reason: visual.passed ? 'CASE17_ONLY' : 'VISUAL_REVIEW_FAILED',
    };
  } catch {
    return { ...base, status: 'BLOCKED', reason: 'SAVED_VISUAL_REVIEW_INVALID' };
  }
}
