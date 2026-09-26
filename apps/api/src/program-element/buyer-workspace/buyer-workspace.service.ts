import { BadRequestException, Injectable } from '@nestjs/common';
import { AcquisitionContinuityReadService } from '../acquisition-continuity/acquisition-continuity-read.service.js';
import { FundingExecutionReadService } from '../funding-execution/funding-execution-read.service.js';
import { FederalEvidenceReadService } from '../federal-evidence/federal-evidence-read.service.js';

export interface BuyerWorkspaceInput {
  peCode: string;
  asOfFy: number;
  knownAt: string;
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
    // The two source-backed readers independently enforce the same temporal scope.
    // Their rows, evidence, review state, and accounting classifications are kept intact.
    const [acquisition, funding, mentions, lifecycle] = await Promise.all([
      this.acquisition.read(scope),
      this.funding.read(scope),
      this.federalEvidence.currentQualifiedMentions(peCode, {
        knownAt, limit: 100, cursor: input.mentionsCursor,
      }),
      this.federalEvidence.lifecycleTimeline({ peCode }, {
        knownAt, limit: 100, cursor: input.lifecycleCursor,
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
      acquisition: {
        state: acquisition.coverage.state,
        data: acquisition,
        coverage: acquisition.coverage,
        freshness: acquisition.coverage.sourceFreshness,
      },
      fundingExecution: {
        state: funding.coverage.state,
        data: funding,
        coverage: funding.coverage,
        freshness: funding.coverage.sourceFreshness,
      },
    };
  }
}
