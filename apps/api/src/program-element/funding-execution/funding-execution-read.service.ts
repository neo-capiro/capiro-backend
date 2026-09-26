import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

export type FundingExecutionAuthorityState = 'enacted' | 'proposed';
export type FundingExecutionMeasure = 'cumulative_snapshot' | 'transaction_delta' | 'transfer_leg' | 'allocation' | 'residual';

export interface FundingExecutionEvidence {
  sourceFamily: string;
  sourceNativeId: string | null;
  sourceUrl: string | null;
  sourceVersion: string | null;
  contentHash: string | null;
  quote: string | null;
}

export interface FundingExecutionFact {
  stableKey: string;
  factId: string;
  authorityState: FundingExecutionAuthorityState;
  measure: FundingExecutionMeasure;
  fiscalYear: number;
  validFromFy: number | null;
  validToFy: number | null;
  availabilityStart: string | null;
  availabilityEnd: string | null;
  recordedAt: string;
  accountId: string | null;
  snapshotGroupId: string | null;
  amountUsd: string | null;
  /** Source-qualified amount semantics; retained through every read projection. */
  amountBasis: 'snapshot' | 'period_delta' | 'transaction_delta' | 'legacy_unspecified' | null;
  executionMetric: 'obligations' | 'outlays' | null;
  asOfDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  /** Transfer identity is source-native; legs are never paired by amount/text. */
  transferGroupId: string | null;
  transferLeg: 'outflow' | 'inflow' | null;
  allocationCertification: 'certified' | 'candidate' | 'unsupported' | 'not_applicable';
  reviewState: 'verified' | 'candidate' | 'unreviewed' | 'rejected' | 'not_applicable';
  exactAccountLevel: boolean;
  evidence: FundingExecutionEvidence[];
  unresolvedReasons: string[];
  authoritativeAmountUsd: string | null;
}

export interface FundingExecutionCoverage {
  state: 'complete' | 'partial' | 'unsupported';
  unresolvedReasons: Array<{ code: string; count: number | null; detail: string | null }>;
  sourceFreshness: Array<{ source: string; sourceAsOf: string | null; state: 'current' | 'unknown' | 'unavailable' }>;
}

export type FundingExecutionSubject =
  | { programId: string; peCode?: never }
  | { peCode: string; programId?: never };

export interface FundingExecutionRepositoryQuery {
  subject: { type: 'program' | 'pe'; id: string };
  asOfFy: number;
  knownAt: Date;
  afterStableKey: string | null;
  take: number;
}

export interface FundingExecutionRepositoryPage {
  /** Repository returns temporal heads only; the read service preserves transfer pairs at page boundaries. */
  rows: FundingExecutionFact[];
  coverage: FundingExecutionCoverage;
}

export interface FundingExecutionReadRepository {
  readPage(query: FundingExecutionRepositoryQuery): Promise<FundingExecutionRepositoryPage>;
}

export const FUNDING_EXECUTION_READ_REPOSITORY = Symbol('FUNDING_EXECUTION_READ_REPOSITORY');

/** Fail-closed fallback for isolated module tests that do not register the store. */
@Injectable()
export class UnsupportedFundingExecutionReadRepository implements FundingExecutionReadRepository {
  async readPage(_query: FundingExecutionRepositoryQuery): Promise<FundingExecutionRepositoryPage> {
    return {
      rows: [],
      coverage: {
        state: 'unsupported',
        unresolvedReasons: [{
          code: 'funding_execution_store_not_integrated',
          count: null,
          detail: 'No source-qualified funding/execution repository is registered.',
        }],
        sourceFreshness: [],
      },
    };
  }
}

export type FundingExecutionReadInput = FundingExecutionSubject & {
  asOfFy: number;
  knownAt?: string;
  limit?: number;
  cursor?: string;
};

export interface FundingExecutionBucket {
  cumulativeSnapshots: FundingExecutionFact[];
  transactionDeltas: FundingExecutionFact[];
  transferLegs: FundingExecutionFact[];
  totals: { cumulativeSnapshotUsd: string | null; transactionDeltaUsd: string | null };
}

export interface FundingExecutionReadResponse {
  subject: { type: 'program' | 'pe'; id: string };
  asOfFy: number;
  knownAt: string;
  enacted: FundingExecutionBucket;
  proposed: FundingExecutionBucket;
  transferPairs: Array<{
    transferGroupId: string;
    authorityState: FundingExecutionAuthorityState;
    outflow: FundingExecutionFact | null;
    inflow: FundingExecutionFact | null;
    state: 'paired' | 'unresolved';
    unresolvedReason: string | null;
  }>;
  allocations: FundingExecutionFact[];
  residuals: FundingExecutionFact[];
  page: { limit: number; hasMore: boolean; nextCursor: string | null };
  coverage: FundingExecutionCoverage;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

@Injectable()
export class FundingExecutionReadService {
  constructor(@Inject(FUNDING_EXECUTION_READ_REPOSITORY) private readonly repository: FundingExecutionReadRepository) {}

  async read(input: FundingExecutionReadInput): Promise<FundingExecutionReadResponse> {
    const subjectEntries = [['program', input.programId], ['pe', input.peCode]] as const;
    const selected = subjectEntries.filter(([, id]) => typeof id === 'string' && id.trim().length > 0);
    if (selected.length !== 1) throw new BadRequestException('Exactly one non-empty programId or peCode is required.');
    const [type, rawId] = selected[0]!;
    const subject = { type, id: rawId!.trim() };
    if (!Number.isInteger(input.asOfFy) || input.asOfFy < 1900 || input.asOfFy > 2200) {
      throw new BadRequestException('asOfFy must be a four-digit fiscal year.');
    }
    const limit = input.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1) throw new BadRequestException('limit must be a positive integer.');
    const boundedLimit = Math.min(limit, MAX_LIMIT);
    const pinnedKnownAt = input.cursor ? cursorKnownAt(input.cursor) : undefined;
    const knownAtDate = new Date(input.knownAt ?? pinnedKnownAt ?? new Date().toISOString());
    if (!Number.isFinite(knownAtDate.getTime())) throw new BadRequestException('knownAt must be a valid ISO date/time.');
    const knownAt = knownAtDate.toISOString();
    const queryFingerprint = fingerprint({ subject, asOfFy: input.asOfFy, knownAt, limit: boundedLimit });
    const afterStableKey = input.cursor ? decodeCursor(input.cursor, queryFingerprint) : null;
    const result = await this.repository.readPage({
      subject,
      asOfFy: input.asOfFy,
      knownAt: knownAtDate,
      afterStableKey,
      // Two lookahead rows allow an explicit two-leg transfer to remain atomic
      // when its first leg lands at the ordinary page boundary.
      take: boundedLimit + 2,
    });
    const sorted = [...result.rows].sort((a, b) => a.stableKey.localeCompare(b.stableKey));
    if (sorted.length > boundedLimit + 2) throw new Error('Funding/execution repository exceeded the requested bounded page.');
    if (sorted.some((row, index) => !row.stableKey || (index > 0 && row.stableKey === sorted[index - 1]!.stableKey))) {
      throw new Error('Funding/execution repository returned missing or duplicate stable keys.');
    }
    if (afterStableKey && sorted.some((row) => row.stableKey <= afterStableKey)) {
      throw new Error('Funding/execution repository returned a row before the requested cursor.');
    }
    let pageEnd = Math.min(sorted.length, boundedLimit);
    const boundary = sorted[pageEnd - 1];
    const lookahead = sorted[pageEnd];
    if (
      boundary?.measure === 'transfer_leg' && boundary.transferGroupId &&
      lookahead?.measure === 'transfer_leg' && lookahead.transferGroupId === boundary.transferGroupId
    ) pageEnd += 1;
    const hasMore = sorted.length > pageEnd || sorted.length === boundedLimit + 2;
    const selectedRows = sorted.slice(0, pageEnd).map(sanitizeAllocation);
    const enactedRows = selectedRows.filter((row) => row.authorityState === 'enacted');
    const proposedRows = selectedRows.filter((row) => row.authorityState === 'proposed');
    const transferPairs = pairTransfers(selectedRows);
    const residuals = selectedRows.filter((row) => row.measure === 'residual' || row.unresolvedReasons.length > 0);
    const allocations = selectedRows.filter((row) => row.measure === 'allocation');
    const last = selectedRows.at(-1);
    return {
      subject,
      asOfFy: input.asOfFy,
      knownAt,
      enacted: bucket(enactedRows),
      proposed: bucket(proposedRows),
      transferPairs,
      allocations,
      residuals,
      page: {
        limit: boundedLimit,
        hasMore,
        nextCursor: hasMore && last ? encodeCursor(last.stableKey, queryFingerprint, knownAt) : null,
      },
      coverage: failClosedCoverage(result.coverage),
    };
  }
}

function sanitizeAllocation(row: FundingExecutionFact): FundingExecutionFact {
  let authoritativeAmountUsd: string | null = null;
  if (
    row.measure === 'allocation' && row.authorityState === 'enacted' &&
    row.allocationCertification === 'certified' && row.reviewState === 'verified' &&
    row.exactAccountLevel && row.accountId && row.amountUsd !== null &&
    parseCents(row.amountUsd) !== null && parseCents(row.amountUsd)! >= 0n && row.evidence.length > 0
  ) authoritativeAmountUsd = formatCents(parseCents(row.amountUsd)!);
  return { ...row, authoritativeAmountUsd };
}

function bucket(rows: FundingExecutionFact[]): FundingExecutionBucket {
  const cumulativeSnapshots = rows.filter((row) => row.measure === 'cumulative_snapshot');
  const transactionDeltas = rows.filter((row) => row.measure === 'transaction_delta');
  const transferLegs = rows.filter((row) => row.measure === 'transfer_leg');
  return {
    cumulativeSnapshots,
    transactionDeltas,
    transferLegs,
    totals: {
      // Snapshot identities are an explicit non-overlapping accounting grain;
      // ambiguous duplicate groups stay visible but do not produce a total.
      cumulativeSnapshotUsd: totalSnapshots(cumulativeSnapshots),
      transactionDeltaUsd: totalAmounts(transactionDeltas),
    },
  };
}

function totalSnapshots(rows: FundingExecutionFact[]): string | null {
  const groups = rows.map((row) => row.snapshotGroupId);
  if (groups.some((id) => !id) || new Set(groups).size !== groups.length) return null;
  return totalAmounts(rows);
}

function totalAmounts(rows: FundingExecutionFact[]): string | null {
  let total = 0n;
  for (const row of rows) {
    const cents = row.amountUsd === null ? null : parseCents(row.amountUsd);
    if (cents === null) return null;
    total += cents;
  }
  return formatCents(total);
}

function pairTransfers(rows: FundingExecutionFact[]): FundingExecutionReadResponse['transferPairs'] {
  const groups = new Map<string, FundingExecutionFact[]>();
  for (const row of rows.filter((item) => item.measure === 'transfer_leg')) {
    if (!row.transferGroupId) continue;
    groups.set(row.transferGroupId, [...(groups.get(row.transferGroupId) ?? []), row]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([transferGroupId, legs]) => {
    const outflows = legs.filter((leg) => leg.transferLeg === 'outflow');
    const inflows = legs.filter((leg) => leg.transferLeg === 'inflow');
    const outflow = outflows.length === 1 ? outflows[0]! : null;
    const inflow = inflows.length === 1 ? inflows[0]! : null;
    const sameAuthority = outflow && inflow && outflow.authorityState === inflow.authorityState;
    const state = legs.length === 2 && outflow && inflow && sameAuthority ? 'paired' as const : 'unresolved' as const;
    return {
      transferGroupId,
      authorityState: outflow?.authorityState ?? inflow?.authorityState ?? legs[0]!.authorityState,
      outflow,
      inflow,
      state,
      unresolvedReason: state === 'paired' ? null : 'transfer_pair_incomplete_or_ambiguous',
    };
  });
}

function failClosedCoverage(coverage: FundingExecutionCoverage): FundingExecutionCoverage {
  if (coverage.state !== 'complete') return coverage;
  if (coverage.unresolvedReasons.length > 0) return { ...coverage, state: 'partial' };
  if (coverage.sourceFreshness.length === 0 || coverage.sourceFreshness.some((item) => item.state !== 'current' || !item.sourceAsOf)) {
    return {
      ...coverage,
      state: 'partial',
      unresolvedReasons: [...coverage.unresolvedReasons, {
        code: 'source_freshness_unverified',
        count: null,
        detail: 'Complete coverage requires at least one source with a known current freshness timestamp.',
      }],
    };
  }
  return coverage;
}

function parseCents(value: string): bigint | null {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const fraction = (match[3] ?? '').padEnd(2, '0');
  const cents = BigInt(match[2]!) * 100n + BigInt(fraction || '0');
  return match[1] ? -cents : cents;
}

function formatCents(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 24);
}

function encodeCursor(afterStableKey: string, queryFingerprint: string, knownAt: string): string {
  return Buffer.from(JSON.stringify({ v: 1, afterStableKey, queryFingerprint, knownAt }), 'utf8').toString('base64url');
}

function cursorKnownAt(cursor: string): string {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const knownAt = parsed && typeof parsed === 'object' ? (parsed as { knownAt?: unknown }).knownAt : undefined;
    if ((parsed as { v?: unknown } | null)?.v !== 1 || typeof knownAt !== 'string' || !Number.isFinite(new Date(knownAt).getTime())) throw new Error();
    return new Date(knownAt).toISOString();
  } catch {
    throw new BadRequestException('cursor is malformed or does not match this query.');
  }
}

function decodeCursor(cursor: string, expectedFingerprint: string): string {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      !parsed || typeof parsed !== 'object' || (parsed as { v?: unknown }).v !== 1 ||
      typeof (parsed as { afterStableKey?: unknown }).afterStableKey !== 'string' ||
      !(parsed as { afterStableKey: string }).afterStableKey ||
      (parsed as { queryFingerprint?: unknown }).queryFingerprint !== expectedFingerprint
    ) throw new Error();
    return (parsed as { afterStableKey: string }).afterStableKey;
  } catch {
    throw new BadRequestException('cursor is malformed or does not match this query.');
  }
}
