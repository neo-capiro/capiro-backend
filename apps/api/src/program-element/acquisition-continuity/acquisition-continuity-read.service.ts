import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

export type AcquisitionContinuitySubject =
  | { programId: string; peCode?: never; procurementLineId?: never }
  | { peCode: string; programId?: never; procurementLineId?: never }
  | { procurementLineId: string; programId?: never; peCode?: never };

export type AcquisitionContinuityStatusFilter = 'all' | 'accepted' | 'candidate' | 'unresolved';
export type AcquisitionContinuityRelationshipStatus = 'accepted' | 'candidate' | 'unresolved';
export type AcquisitionContinuityCoverageState = 'complete' | 'partial' | 'unsupported';

export interface AcquisitionContinuityEvidence {
  kind: string;
  sourceUrl: string | null;
  sourceNativeId: string | null;
  sourceVersion: string | null;
  pageNumber: number | null;
  quote: string | null;
  contentHash: string | null;
}

export type AcquisitionFinancialClass =
  | 'source_stated_financial_allocation'
  | 'deterministic_financial_allocation'
  | 'reviewed_association'
  | 'inferred_relevance'
  | 'unresolved'
  | 'negative_action'
  | 'corrected_action'
  | 'not_an_allocation';

export interface AcquisitionContinuityFinancialFact {
  classification: AcquisitionFinancialClass;
  reviewState: 'verified' | 'candidate' | 'unreviewed' | 'rejected' | 'not_applicable';
  /** Source amount is retained as an observation; it is not automatically an allocation. */
  sourceAmountUsd: string | null;
  actionEffect: 'ordinary' | 'negative' | 'corrected' | 'reversal' | 'unknown';
  evidencePresent: boolean;
}

export interface AcquisitionContinuityRelationshipRow {
  /** Stable, unique, source-independent order key. The repository sorts by this key. */
  stableKey: string;
  relationshipId: string;
  relationshipKind: string;
  status: AcquisitionContinuityRelationshipStatus;
  from: { entityType: string; id: string | null; sourceNativeId: string | null; label: string | null };
  to: { entityType: string; id: string | null; sourceNativeId: string | null; label: string | null };
  /** Provider and source-native identities along the path, including parent vehicle/order IDs. */
  sourceNativeIds: Record<string, string | null>;
  path: Array<{ entityType: string; id: string | null; sourceNativeId: string | null; label: string | null }>;
  parent: { entityType: string; id: string | null; sourceNativeId: string | null; label: string | null } | null;
  validity: {
    validFromFy: number | null;
    validToFy: number | null;
    knownFrom: string | null;
    knownTo: string | null;
  };
  evidence: AcquisitionContinuityEvidence[];
  unresolvedReasons: string[];
  financialFact: AcquisitionContinuityFinancialFact;
  /** Computed by this service; never trusted from storage. */
  authoritativeAmountUsd: string | null;
}

export interface AcquisitionContinuitySourceFreshness {
  source: string;
  sourceAsOf: string | null;
  lastObservedAt: string | null;
  state: 'current' | 'stale' | 'unknown' | 'unavailable';
}

export interface AcquisitionContinuityCoverage {
  state: AcquisitionContinuityCoverageState;
  supportedRelationshipKinds: string[];
  unsupportedRelationshipKinds: string[];
  unresolvedReasons: Array<{ code: string; count: number | null; detail: string | null }>;
  sourceFreshness: AcquisitionContinuitySourceFreshness[];
}

export type AcquisitionContinuityReadInput = AcquisitionContinuitySubject & {
  asOfFy: number;
  knownAt?: string;
  status?: AcquisitionContinuityStatusFilter;
  limit?: number;
  cursor?: string;
};

/** Query to the persistence adapter. It contains no tenant identity: this is a global source read. */
export interface AcquisitionContinuityRepositoryQuery {
  subject: { type: 'program' | 'pe' | 'procurement_line'; id: string };
  asOfFy: number;
  knownAt: Date;
  statuses: AcquisitionContinuityRelationshipStatus[];
  afterStableKey: string | null;
  take: number;
}

export interface AcquisitionContinuityRepositoryPage {
  rows: AcquisitionContinuityRelationshipRow[];
  coverage: AcquisitionContinuityCoverage;
}

/** Storage-independent boundary implemented later by a Prisma/query adapter. */
export interface AcquisitionContinuityReadRepository {
  readPage(query: AcquisitionContinuityRepositoryQuery): Promise<AcquisitionContinuityRepositoryPage>;
}

export const ACQUISITION_CONTINUITY_READ_REPOSITORY = Symbol('ACQUISITION_CONTINUITY_READ_REPOSITORY');

export interface AcquisitionContinuityReadResponse {
  subject: { type: 'program' | 'pe' | 'procurement_line'; id: string };
  asOfFy: number;
  knownAt: string;
  accepted: AcquisitionContinuityRelationshipRow[];
  candidates: AcquisitionContinuityRelationshipRow[];
  unresolved: AcquisitionContinuityRelationshipRow[];
  page: { limit: number; hasMore: boolean; nextCursor: string | null };
  coverage: AcquisitionContinuityCoverage;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const VALID_STATUSES: AcquisitionContinuityRelationshipStatus[] = ['accepted', 'candidate', 'unresolved'];

@Injectable()
export class AcquisitionContinuityReadService {
  constructor(
    @Inject(ACQUISITION_CONTINUITY_READ_REPOSITORY)
    private readonly repository: AcquisitionContinuityReadRepository,
  ) {}

  async read(input: AcquisitionContinuityReadInput): Promise<AcquisitionContinuityReadResponse> {
    const subject = normalizeSubject(input);
    const asOfFy = input.asOfFy;
    if (!Number.isInteger(asOfFy) || asOfFy < 1900 || asOfFy > 2200) {
      throw new BadRequestException('asOfFy must be a four-digit fiscal year.');
    }
    const cursorKnownAt = input.cursor ? knownAtFromCursor(input.cursor) : undefined;
    const requestedKnownAt = input.knownAt ?? cursorKnownAt ?? new Date().toISOString();
    const knownAtDate = new Date(requestedKnownAt);
    if (!Number.isFinite(knownAtDate.getTime())) {
      throw new BadRequestException('knownAt must be a valid ISO date/time.');
    }
    const knownAt = knownAtDate.toISOString();
    const status = input.status ?? 'all';
    if (!['all', 'accepted', 'candidate', 'unresolved'].includes(status)) {
      throw new BadRequestException('status must be all, accepted, candidate, or unresolved.');
    }
    const limit = normalizeLimit(input.limit);
    const statuses = status === 'all' ? VALID_STATUSES : [status];
    const queryFingerprint = fingerprint({ subject, asOfFy, knownAt, statuses, limit });
    const afterStableKey = input.cursor ? decodeCursor(input.cursor, queryFingerprint) : null;

    const result = await this.repository.readPage({
      subject,
      asOfFy,
      knownAt: knownAtDate,
      statuses,
      afterStableKey,
      take: limit + 1,
    });

    const sorted = [...result.rows].sort((a, b) => (a.stableKey < b.stableKey ? -1 : a.stableKey > b.stableKey ? 1 : 0));
    if (sorted.some((row, index) => !row.stableKey || (index > 0 && row.stableKey === sorted[index - 1]!.stableKey))) {
      throw new Error('Acquisition continuity repository returned missing or duplicate stable keys.');
    }
    if (afterStableKey && sorted.some((row) => row.stableKey <= afterStableKey)) {
      throw new Error('Acquisition continuity repository returned a row before the requested cursor.');
    }
    const hasMore = sorted.length > limit;
    const selected = sorted.slice(0, limit).map(sanitizeFinancialFact);
    const accepted = selected.filter((row) => row.status === 'accepted');
    const candidates = selected.filter((row) => row.status === 'candidate');
    const unresolved = selected.filter((row) => row.status === 'unresolved');
    const last = selected[selected.length - 1];

    return {
      subject,
      asOfFy,
      knownAt,
      accepted,
      candidates,
      unresolved,
      page: {
        limit,
        hasMore,
        nextCursor: hasMore && last ? encodeCursor(last.stableKey, queryFingerprint, knownAt) : null,
      },
      coverage: result.coverage,
    };
  }
}

function normalizeSubject(input: AcquisitionContinuitySubject): AcquisitionContinuityRepositoryQuery['subject'] {
  const values = [
    ['program', input.programId],
    ['pe', input.peCode],
    ['procurement_line', input.procurementLineId],
  ] as const;
  const selected = values.filter(([, id]) => typeof id === 'string' && id.trim().length > 0);
  if (selected.length !== 1) {
    throw new BadRequestException('Exactly one non-empty programId, peCode, or procurementLineId is required.');
  }
  const [type, id] = selected[0]!;
  return { type, id: id!.trim() };
}

function normalizeLimit(raw: number | undefined): number {
  if (raw !== undefined && (!Number.isInteger(raw) || raw < 1)) {
    throw new BadRequestException('limit must be a positive integer.');
  }
  return Math.min(raw ?? DEFAULT_LIMIT, MAX_LIMIT);
}

function sanitizeFinancialFact(row: AcquisitionContinuityRelationshipRow): AcquisitionContinuityRelationshipRow {
  const fact = row.financialFact;
  let authoritativeAmountUsd: string | null = null;
  if (
    (fact.classification === 'source_stated_financial_allocation' ||
      fact.classification === 'deterministic_financial_allocation') &&
    row.status === 'accepted' &&
    fact.reviewState === 'verified' &&
    fact.evidencePresent &&
    fact.actionEffect === 'ordinary' &&
    fact.sourceAmountUsd !== null
  ) {
    if (/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(fact.sourceAmountUsd)) {
      authoritativeAmountUsd = fact.sourceAmountUsd;
    }
  }
  return { ...row, authoritativeAmountUsd };
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 24);
}

function encodeCursor(afterStableKey: string, queryFingerprint: string, knownAt: string): string {
  return Buffer.from(JSON.stringify({ v: 2, afterStableKey, queryFingerprint, knownAt }), 'utf8').toString('base64url');
}

function knownAtFromCursor(cursor: string): string {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const value = decoded && typeof decoded === 'object' ? (decoded as { knownAt?: unknown }).knownAt : undefined;
    if ((decoded as { v?: unknown } | null)?.v !== 2 || typeof value !== 'string' || !Number.isFinite(new Date(value).getTime())) {
      throw new Error('invalid cursor');
    }
    return new Date(value).toISOString();
  } catch {
    throw new BadRequestException('cursor is malformed or does not match this query.');
  }
}

function decodeCursor(cursor: string, expectedFingerprint: string): string {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      !decoded ||
      typeof decoded !== 'object' ||
      (decoded as { v?: unknown }).v !== 2 ||
      typeof (decoded as { afterStableKey?: unknown }).afterStableKey !== 'string' ||
      (decoded as { afterStableKey: string }).afterStableKey.length === 0 ||
      (decoded as { queryFingerprint?: unknown }).queryFingerprint !== expectedFingerprint
    ) {
      throw new Error('invalid cursor');
    }
    return (decoded as { afterStableKey: string }).afterStableKey;
  } catch {
    throw new BadRequestException('cursor is malformed or does not match this query.');
  }
}
