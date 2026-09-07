import { citationMarkers, gradeAnswer } from './eval-grader.js';
import type { GovernmentAffairsFixture } from './government-affairs-fixtures.js';

/** Human review only: substring checks cannot establish professional judgment. */
export const GOVERNMENT_AFFAIRS_REVIEW_RUBRIC = [
  {
    id: 'clientImplication',
    description:
      'Clear recommendation linked to actual objective, capabilities, geography and constraints.',
  },
  {
    id: 'verifiedEvidence',
    description:
      'Claim-level support, observation date, exact source/section and correct units, fiscal year and stage.',
  },
  {
    id: 'judgment',
    description:
      'Fact versus inference, useful alternatives and material uncertainty without invented confidence.',
  },
  {
    id: 'practicalAction',
    description:
      'Feasible next step, owner, verified target, deliverable and evidence-backed deadline or explicit unknown.',
  },
  {
    id: 'missingInformation',
    description:
      'Decision-changing gaps and partial/stale coverage identified; no absent field treated as a negative fact.',
  },
] as const;
export type GovernmentAffairsReviewDimension =
  (typeof GOVERNMENT_AFFAIRS_REVIEW_RUBRIC)[number]['id'];
export interface GovernmentAffairsHumanReview {
  reviewer: string;
  reviewedAt: string;
  scores: Record<GovernmentAffairsReviewDimension, number>;
  /** Incorrect material fact, unsupported decision, privacy violation or missing client constraint. */
  criticalErrors: string[];
  notes: string;
}

export function gradeGovernmentAffairsAnswer(fixture: GovernmentAffairsFixture, answer: string) {
  const baseline = gradeAnswer(fixture, answer);
  const markers = citationMarkers(answer);
  const known = new Set(fixture.sources.map((source) => source.id));
  const failures = [...baseline.failures];
  for (const marker of markers) {
    if (!known.has(marker)) failures.push(`citation [${marker}] has no supplied source`);
  }
  for (const sourceId of fixture.requiredSourceIds) {
    if (!markers.includes(sourceId))
      failures.push(`required client/task evidence [${sourceId}] was not cited`);
  }
  if (/\b(?:TODO|TBD|insert (?:analysis|recommendation|citation) here)\b/i.test(answer)) {
    failures.push('deliverable contains an unfinished placeholder');
  }
  return {
    ...baseline,
    pass: failures.length === 0,
    failures,
    evaluationKind: 'deterministic-contract-only' as const,
    professionalQualityScore: null,
    groundingVerified: false,
    humanReviewRequired: true,
  };
}

export function scoreGovernmentAffairsHumanReview(review: GovernmentAffairsHumanReview) {
  if (!review.reviewer?.trim() || !Number.isFinite(Date.parse(review.reviewedAt))) {
    throw new Error('A named reviewer and valid review date are required.');
  }
  const scores = GOVERNMENT_AFFAIRS_REVIEW_RUBRIC.map(({ id }) => review.scores[id]);
  if (scores.some((score) => !Number.isInteger(score) || score < 0 || score > 4)) {
    throw new Error('All five professional dimensions require integer scores from 0 to 4.');
  }
  const total = scores.reduce((sum, score) => sum + score, 0);
  return {
    total,
    possible: 20,
    criticalErrorCount: review.criticalErrors.length,
    // A high aggregate cannot conceal an absent professional requirement.
    acceptable:
      total >= 16 && scores.every((score) => score >= 2) && review.criticalErrors.length === 0,
  };
}
