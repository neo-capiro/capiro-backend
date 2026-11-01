import { BadRequestException, Injectable } from '@nestjs/common';
import { AcquisitionContinuityReadService } from '../acquisition-continuity/acquisition-continuity-read.service.js';
import { FundingExecutionReadService } from '../funding-execution/funding-execution-read.service.js';
import { FederalEvidenceReadService } from '../federal-evidence/federal-evidence-read.service.js';

export interface BuyerWorkspaceInput {
  peCode: string;
  asOfFy: number;
  knownAt: string;
  acquisitionCursor?: string;
  fundingCursor?: string;
  mentionsCursor?: string;
  lifecycleCursor?: string;
}

/** A section is never promoted to complete by the composite read. */
export type WorkspaceSection<T> =
  | { state: 'complete' | 'partial'; data: T; coverage: unknown; freshness: unknown }
  | { state: 'unsupported'; data: null; coverage: { unresolvedReasons: Array<{ code: string; detail: string }> }; freshness: null };

export function unsupportedSection(code: string, detail: string): WorkspaceSection<never> {
  return { state: 'unsupported', data: null, coverage: { unresolvedReasons: [{ code, detail }] }, freshness: null };
}

export function buyerWorkspaceCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.trim() !== value)
    throw new BadRequestException('Buyer workspace cursor must be an exact non-empty continuation of at most 4096 characters.');
  return value;
}

/** Source coverage describes the source, while this section may contain only
 * one page. Preserve the reader's data and never upgrade unsupported coverage. */
function pagedSection<T extends {
  page: { hasMore: boolean };
  coverage: {
    state: 'complete' | 'partial' | 'unsupported';
    unresolvedReasons: Array<{ code: string; count: number | null; detail: string | null }>;
    sourceFreshness: unknown;
  };
}>(data: T, section: 'acquisition' | 'funding') {
  const state = data.page.hasMore && data.coverage.state === 'complete' ? 'partial' : data.coverage.state;
  const coverage = data.page.hasMore ? {
    ...data.coverage, state, unresolvedReasons: [...data.coverage.unresolvedReasons, {
      code: section + '_page_incomplete', count: null,
      detail: 'More rows remain; follow this section’s next cursor with the same fiscal year and knowledge timestamp.',
    }],
  } : data.coverage;
  const freshness: T['coverage']['sourceFreshness'] = data.coverage.sourceFreshness;
  return { state, data, coverage, freshness };
}

@Injectable()
export class BuyerWorkspaceService {
  constructor(
    private readonly acquisition: AcquisitionContinuityReadService,
    private readonly funding: FundingExecutionReadService,
    private readonly federalEvidence: FederalEvidenceReadService,
  ) {}

  async read(input: BuyerWorkspaceInput) {
    const peCode = input.peCode?.trim().toUpperCase();
    if (!peCode) throw new BadRequestException('peCode is required.');
    if (!Number.isInteger(input.asOfFy) || input.asOfFy < 1900 || input.asOfFy > 2200) {
      throw new BadRequestException('asOfFy must be a four-digit fiscal year.');
    }
    if (!input.knownAt || !/^\d{4}-\d{2}-\d{2}T/.test(input.knownAt)) {
      throw new BadRequestException('knownAt must be an ISO date/time.');
    }
    const date = new Date(input.knownAt);
    if (!Number.isFinite(date.getTime())) throw new BadRequestException('knownAt must be a valid ISO date/time.');
    const knownAt = date.toISOString();
    const scope = { peCode, asOfFy: input.asOfFy, knownAt };
    const acquisitionCursor = buyerWorkspaceCursor(input.acquisitionCursor);
    const fundingCursor = buyerWorkspaceCursor(input.fundingCursor);
    const mentionsCursor = buyerWorkspaceCursor(input.mentionsCursor);
    const lifecycleCursor = buyerWorkspaceCursor(input.lifecycleCursor);
    // The two source-backed readers independently enforce the same temporal scope.
    // Their rows, evidence, review state, and accounting classifications are kept intact.
    const [acquisition, funding, mentions, lifecycle] = await Promise.all([
      this.acquisition.read({ ...scope, cursor: acquisitionCursor }),
      this.funding.read({ ...scope, cursor: fundingCursor }),
      this.federalEvidence.currentQualifiedMentions(peCode, {
        knownAt, limit: 100, cursor: mentionsCursor,
      }),
      this.federalEvidence.lifecycleTimeline({ peCode }, {
        knownAt, limit: 100, cursor: lifecycleCursor,
      }),
    ]);
    if (acquisition.asOfFy !== input.asOfFy || acquisition.knownAt !== knownAt ||
        funding.asOfFy !== input.asOfFy || funding.knownAt !== knownAt) {
      throw new Error('Buyer workspace temporal scope mismatch.');
    }
    return {
      subject: { type: 'pe' as const, id: peCode },
      asOfFy: input.asOfFy,
      knownAt,
      // The canonical PE/budget endpoint lacks a pinned knownAt read.
      budget: unsupportedSection('budget_temporal_read_unavailable', 'Canonical PE budget read does not support pinned knownAt.'),
      federalEvidence: {
        state: mentions.hasMore || lifecycle.hasMore ? 'partial' as const : 'complete' as const,
        data: { mentions, lifecycle },
        coverage: {
          state: mentions.hasMore || lifecycle.hasMore ? 'partial' as const : 'complete' as const,
          unresolvedReasons: mentions.hasMore || lifecycle.hasMore
            ? [{ code: 'federal_evidence_page_incomplete', detail: 'More qualified evidence or lifecycle events remain; follow section cursors.' }]
            : [],
        },
        freshness: { knownAt, sourceAsOf: null },
      },
      acquisition: pagedSection(acquisition, 'acquisition'),
      fundingExecution: pagedSection(funding, 'funding'),
    };
  }
}
