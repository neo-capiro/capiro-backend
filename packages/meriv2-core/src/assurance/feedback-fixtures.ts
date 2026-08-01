import { createHash, randomUUID } from 'node:crypto';

/**
 * CANONICAL reason vocabulary — the LIVE apps/api spelling.
 *
 * These two lists had drifted: apps/api (meri-feedback.helpers.ts) persists
 * `wrong_tone_or_format` / `tool_or_action_failed` into
 * `clio_message.metadata.feedback`, while this module used `wrong_tone_format` /
 * `tool_action_failed`. `isFeedbackReason` silently filtered the LIVE spellings
 * out, so a thumbs-down carrying only one of them made
 * `createFeedbackFixtureCandidate` throw "At least one valid feedback reason is
 * required" instead of producing a candidate.
 *
 * Resolution: adopt the LIVE spelling as canonical (renaming the apps/api codes
 * would orphan rows already persisted in clio_message.metadata) and ACCEPT the
 * legacy meriv2-core spelling as an alias, normalizing on the way in. Nothing
 * that was previously accepted is rejected now.
 */
export const CANONICAL_FEEDBACK_REASON_CODES = [
  'factually_wrong',
  'outdated',
  'wrong_client_context',
  'missed_source',
  'unsupported_claim',
  'too_generic',
  'bad_recommendation',
  'wrong_tone_or_format',
  'compliance_concern',
  'tool_or_action_failed',
] as const;

export type FeedbackReasonCode = (typeof CANONICAL_FEEDBACK_REASON_CODES)[number];

/** Accepted-but-deprecated spellings, mapped to their canonical code. */
export const FEEDBACK_REASON_ALIASES: Readonly<Record<string, FeedbackReasonCode>> = {
  wrong_tone_format: 'wrong_tone_or_format',
  tool_action_failed: 'tool_or_action_failed',
};

/** Every spelling accepted on input (canonical + alias). */
export type FeedbackReasonCodeInput = FeedbackReasonCode | keyof typeof FEEDBACK_REASON_ALIASES;

/**
 * Normalize one reason code to its canonical spelling, or null when it is not a
 * recognized code. Never throws — an unknown code is a filtered input, not an
 * exception.
 */
export function normalizeFeedbackReason(value: unknown): FeedbackReasonCode | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if ((CANONICAL_FEEDBACK_REASON_CODES as readonly string[]).includes(trimmed)) {
    return trimmed as FeedbackReasonCode;
  }
  return FEEDBACK_REASON_ALIASES[trimmed] ?? null;
}

export type FeedbackFixtureCandidateStatus = 'pending_review' | 'accepted' | 'rejected';

export interface FeedbackFixtureCandidate {
  id: string;
  status: FeedbackFixtureCandidateStatus;
  reasonCodes: FeedbackReasonCode[];
  surface: string;
  traceId?: string;
  contextPacketId?: string;
  claimLedgerHash?: string;
  /** Bounded, reviewer-facing description. Never full prompt/context. */
  summary?: string;
  createdAt: string;
  createdByUserId: string;
  anonymized: boolean;
  anonymizationVersion?: string;
  reviewedByUserId?: string;
  reviewedAt?: string;
  reviewReason?: string;
  fixtureId?: string;
}

export interface AcceptedRegressionFixture {
  id: string;
  sourceCandidateId: string;
  datasetVersion: string;
  category: FeedbackReasonCode;
  surface: string;
  traceRef?: string;
  contextPacketRef?: string;
  claimLedgerHash?: string;
  anonymizationVersion: string;
  acceptedByUserId: string;
  acceptedAt: string;
}

export function createFeedbackFixtureCandidate(input: {
  /** Canonical or legacy spellings; normalized to canonical here. */
  reasonCodes: readonly FeedbackReasonCodeInput[];
  surface: string;
  traceId?: string;
  contextPacketId?: string;
  claimLedgerHash?: string;
  summary?: string;
  createdByUserId: string;
  createdAt?: string | Date;
}): FeedbackFixtureCandidate {
  // Normalize BEFORE de-duplicating so `wrong_tone_format` and
  // `wrong_tone_or_format` in the same payload collapse to one canonical code.
  const reasonCodes = [
    ...new Set(
      input.reasonCodes
        .map((value) => normalizeFeedbackReason(value))
        .filter((value): value is FeedbackReasonCode => value !== null),
    ),
  ];
  if (!reasonCodes.length) throw new Error('At least one valid feedback reason is required.');
  return {
    id: randomUUID(),
    status: 'pending_review',
    reasonCodes,
    surface: bounded(input.surface, 64),
    ...(input.traceId ? { traceId: bounded(input.traceId, 160) } : {}),
    ...(input.contextPacketId ? { contextPacketId: bounded(input.contextPacketId, 160) } : {}),
    ...(input.claimLedgerHash ? { claimLedgerHash: bounded(input.claimLedgerHash, 128) } : {}),
    ...(input.summary ? { summary: bounded(input.summary, 1000) } : {}),
    createdAt: iso(input.createdAt ?? new Date()),
    createdByUserId: input.createdByUserId,
    anonymized: false,
  };
}

/**
 * Feedback never becomes golden truth automatically. Acceptance requires a named
 * reviewer plus completed anonymization; rejection retains the audit trail.
 */
export function reviewFeedbackFixtureCandidate(
  candidate: FeedbackFixtureCandidate,
  input:
    | {
        decision: 'accept';
        reviewerUserId: string;
        reviewReason: string;
        anonymizationVersion: string;
        datasetVersion: string;
        at?: string | Date;
      }
    | {
        decision: 'reject';
        reviewerUserId: string;
        reviewReason: string;
        at?: string | Date;
      },
): { candidate: FeedbackFixtureCandidate; fixture?: AcceptedRegressionFixture } {
  if (candidate.status !== 'pending_review')
    throw new Error('Feedback candidate is already decided.');
  if (!input.reviewerUserId) throw new Error('A named reviewer is required.');
  if (!input.reviewReason.trim()) throw new Error('A review reason is required.');
  const at = iso(input.at ?? new Date());
  if (input.decision === 'reject') {
    return {
      candidate: {
        ...candidate,
        status: 'rejected',
        reviewedByUserId: input.reviewerUserId,
        reviewedAt: at,
        reviewReason: bounded(input.reviewReason, 1000),
      },
    };
  }
  if (!input.anonymizationVersion.trim()) {
    throw new Error('Accepted feedback must be anonymized before it becomes an eval fixture.');
  }
  if (!input.datasetVersion.trim()) throw new Error('A dataset version is required.');
  const fixtureId = `feedback-${createHash('sha256')
    .update(`${candidate.id}:${input.datasetVersion}`)
    .digest('hex')
    .slice(0, 20)}`;
  const accepted: FeedbackFixtureCandidate = {
    ...candidate,
    status: 'accepted',
    anonymized: true,
    anonymizationVersion: bounded(input.anonymizationVersion, 80),
    reviewedByUserId: input.reviewerUserId,
    reviewedAt: at,
    reviewReason: bounded(input.reviewReason, 1000),
    fixtureId,
  };
  return {
    candidate: accepted,
    fixture: {
      id: fixtureId,
      sourceCandidateId: candidate.id,
      datasetVersion: bounded(input.datasetVersion, 120),
      category: candidate.reasonCodes[0]!,
      surface: candidate.surface,
      ...(candidate.traceId ? { traceRef: candidate.traceId } : {}),
      ...(candidate.contextPacketId ? { contextPacketRef: candidate.contextPacketId } : {}),
      ...(candidate.claimLedgerHash ? { claimLedgerHash: candidate.claimLedgerHash } : {}),
      anonymizationVersion: accepted.anonymizationVersion!,
      acceptedByUserId: input.reviewerUserId,
      acceptedAt: at,
    },
  };
}

/** Does this value resolve to a recognized reason code (canonical or alias)? */
export function isFeedbackReason(value: unknown): value is FeedbackReasonCodeInput {
  return normalizeFeedbackReason(value) !== null;
}

function bounded(value: string, max: number): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function iso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid timestamp.');
  return date.toISOString();
}
