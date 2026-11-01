import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { canonicalWorkspaceSnapshot } from '@capiro/shared';
import { isUUID } from 'class-validator';

export const LINK_REVIEW_ACTION = 'analyst.link.review';
export const LINK_REVIEW_KINDS = ['provision', 'sam'] as const;
export type LinkReviewKind = (typeof LINK_REVIEW_KINDS)[number];
export type LinkReviewStatus = 'candidate' | 'quarantined' | 'accepted' | 'rejected';
export type LinkReviewInput = {
  requestId: string;
  expectedVersion: string;
  decision: 'accept' | 'reject';
  reason: string;
};
export function linkReviewKind(raw: string): LinkReviewKind {
  if (raw !== 'provision' && raw !== 'sam') throw new BadRequestException('Unknown review queue');
  return raw;
}
export function linkReviewInput(raw: LinkReviewInput): LinkReviewInput {
  if (
    !raw ||
    !isUUID(raw.requestId) ||
    !/^[a-f0-9]{64}$/.test(raw.expectedVersion) ||
    !['accept', 'reject'].includes(raw.decision) ||
    typeof raw.reason !== 'string' ||
    !raw.reason.trim() ||
    raw.reason.length > 4000
  )
    throw new BadRequestException(
      'A request, exact candidate version, decision and reason are required',
    );
  return {
    requestId: raw.requestId.toLowerCase(),
    expectedVersion: raw.expectedVersion,
    decision: raw.decision,
    reason: raw.reason.trim(),
  };
}
/** Version includes the reviewed evidence and target, not only the link timestamp. */
export function linkReviewHash(value: unknown): string {
  const json = JSON.parse(JSON.stringify(value));
  return createHash('sha256').update(canonicalWorkspaceSnapshot(json)).digest('hex');
}

export type LinkReviewReceipt = {
  schemaVersion: 1;
  requestId: string;
  kind: LinkReviewKind;
  candidateId: string;
  expectedVersion: string;
  resultingVersion: string;
  decision: 'accept' | 'reject';
  status: 'accepted' | 'rejected' | 'refused';
  refusal: 'REVIEW_SOURCE_STALE' | 'REVIEW_TARGET_UNAVAILABLE' | null;
  reason: string;
  reviewerId: string;
  decidedAt: string;
};
