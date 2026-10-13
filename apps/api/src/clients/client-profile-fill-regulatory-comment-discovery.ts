import type { TenantContext } from '@capiro/shared';
import { asRecord, asString } from './client-profile-fill.helpers.js';
import type {
  AdvocacyBackfillStatus,
  AdvocacySourceBackfillState,
} from './client-profile-fill-advocacy-health.js';
import { deriveRegulatoryCommentSubmitterLabel } from './client-profile-fill-advocacy-mapping.js';
import {
  ClientProfileFillRegulatoryCommentSource,
  REGULATORY_COMMENT_SEARCH_PAGE_SIZE,
  type RegulatoryCommentDetail,
  type RegulatoryCommentReporter,
} from './client-profile-fill-regulatory-comment-source.js';

const REGULATORY_COMMENT_MAX_SEARCH_RESULTS = 250;
const REGULATORY_COMMENT_INTEL_MAPPING_SOURCE = 'regulatory_comment';

interface DiscoveryFinding {
  externalKey: string;
  isConfirmed: boolean;
  confidence: number;
  proposedValue: unknown;
  evidence: unknown[];
}

export interface RegulatoryCommentDiscoveryPorts extends RegulatoryCommentReporter {
  resolveClientName(ctx: TenantContext, clientId: string): Promise<string | null>;
  confirmedMappingKeys(ctx: TenantContext, clientId: string, source: string): Promise<Set<string>>;
  emitFinding(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    input: DiscoveryFinding,
  ): Promise<boolean>;
}

interface SearchPage {
  commentIds: string[];
  hitCount: number;
  totalElements: number | null;
  error: string | null;
}

interface PageProgress {
  count: number;
  processedSearchHits: number;
  detailFailures: number;
}

type BuildBackfill = (
  status: AdvocacyBackfillStatus,
  examined: number,
  candidates: number,
  checkpoint: Record<string, unknown> | null,
  lastError?: string | null,
  limitation?: string | null,
) => AdvocacySourceBackfillState;

/** Source-specific traversal; tenant reads and finding persistence remain with completion. */
export class ClientProfileFillRegulatoryCommentDiscovery {
  constructor(
    private readonly source: ClientProfileFillRegulatoryCommentSource,
    private readonly ports: RegulatoryCommentDiscoveryPorts,
    private readonly findingLimit: number,
  ) {}

  async gather(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
    priorState: Record<string, unknown>,
  ): Promise<{ count: number; backfill: AdvocacySourceBackfillState }> {
    const startedAt = asString(priorState.startedAt) ?? new Date().toISOString();
    const priorCheckpoint = asRecord(priorState.checkpoint);
    const pageNumber = Math.max(1, Number(priorCheckpoint.nextPage ?? 1));
    const pageOffset = Math.max(0, Number(priorCheckpoint.offset ?? 0));
    const state = this.backfillState(priorState, startedAt);
    if (currentCount >= this.findingLimit) {
      return {
        count: 0,
        backfill: state('in_progress', 0, 0, priorCheckpoint),
      };
    }
    const apiKey = process.env.REGULATIONS_GOV_API_KEY;
    if (!apiKey) {
      const lastError = 'REGULATIONS_GOV_API_KEY not configured';
      this.ports.warn(`Regulatory comment discovery rail unavailable: ${lastError}`);
      return {
        count: 0,
        backfill: state('partial', 0, 0, priorCheckpoint, lastError),
      };
    }
    const clientName = await this.ports.resolveClientName(ctx, clientId);
    if (!clientName) return { count: 0, backfill: state('complete', 0, 0, null) };
    const confirmedCommentIds = await this.ports.confirmedMappingKeys(
      ctx,
      clientId,
      REGULATORY_COMMENT_INTEL_MAPPING_SOURCE,
    );
    const search = await this.searchComments(apiKey, clientName, pageNumber);
    if (search.error !== null && confirmedCommentIds.size === 0) {
      return {
        count: 0,
        backfill: state('partial', 0, 0, priorCheckpoint, search.error),
      };
    }
    const remainingSearchIds = search.commentIds
      .slice(pageOffset)
      .filter((id) => !confirmedCommentIds.has(id));
    const progress = await this.emitCandidates(
      ctx,
      clientId,
      runId,
      currentCount,
      apiKey,
      confirmedCommentIds,
      [...confirmedCommentIds, ...remainingSearchIds],
    );
    return {
      count: progress.count,
      backfill: this.finishPage(
        state,
        pageNumber,
        pageOffset,
        search,
        remainingSearchIds.length,
        progress,
      ),
    };
  }

  private backfillState(priorState: Record<string, unknown>, startedAt: string): BuildBackfill {
    return (status, examined, candidates, checkpoint, lastError = null, limitation = null) => ({
      status,
      startedAt,
      completedAt: status === 'complete' ? new Date().toISOString() : undefined,
      checkpoint,
      historyStart: null,
      examined: Number(priorState.examined ?? 0) + examined,
      candidates: Number(priorState.candidates ?? 0) + candidates,
      lastError,
      limitation,
    });
  }

  private async searchComments(
    apiKey: string,
    clientName: string,
    pageNumber: number,
  ): Promise<SearchPage> {
    const commentIds: string[] = [];
    let hitCount = 0;
    let totalElements: number | null = null;
    let error: string | null = null;
    try {
      const body = await this.source.searchComments(apiKey, clientName, pageNumber);
      hitCount = body.data?.length ?? 0;
      totalElements = Number.isFinite(Number(body.meta?.totalElements))
        ? Number(body.meta?.totalElements)
        : null;
      for (const hit of body.data ?? []) commentIds.push(hit.id);
    } catch (caught) {
      error = this.ports.safeError(caught);
      this.ports.warn(`Regulatory comment search rail unavailable: ${error}`);
    }
    return { commentIds, hitCount, totalElements, error };
  }

  private async emitCandidates(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
    apiKey: string,
    confirmedCommentIds: Set<string>,
    candidateCommentIds: string[],
  ): Promise<PageProgress> {
    let count = 0;
    let processedSearchHits = 0;
    let detailFailures = 0;
    for (const commentId of candidateCommentIds) {
      if (currentCount + count >= this.findingLimit) break;
      const isConfirmed = confirmedCommentIds.has(commentId);
      if (!isConfirmed) processedSearchHits += 1;
      const detail = await this.source.getDetail(commentId, apiKey);
      if (!detail) {
        detailFailures += 1;
        continue;
      }
      const input = this.buildFinding(commentId, isConfirmed, detail);
      const inserted = await this.ports.emitFinding(ctx, clientId, runId, input);
      if (inserted) count += 1;
    }
    return { count, processedSearchHits, detailFailures };
  }

  private buildFinding(
    commentId: string,
    isConfirmed: boolean,
    detail: RegulatoryCommentDetail,
  ): DiscoveryFinding {
    const confidence = isConfirmed ? 1 : 0.75;
    const externalKey = `regulatory-comment:${commentId}`;
    const submitterLabel = deriveRegulatoryCommentSubmitterLabel(
      detail.firstName,
      detail.lastName,
      detail.organization,
    );
    const proposedValue = {
      externalKey,
      recordType: 'regulatory_comment',
      title: `Public comment — ${submitterLabel} on ${detail.docketId ?? detail.commentId}`,
      summary: detail.commentText?.slice(0, 500) ?? null,
      activityDate: detail.postedDate?.toISOString() ?? null,
      status: null,
      outcome: null,
      sourceType: 'regulatory_comment',
      sourceId: commentId,
      sourceUrl: detail.sourceUrl,
      evidenceClass: 'PUBLIC_VERIFIED',
      confidence,
      metadata: {
        commentId,
        docketId: detail.docketId,
        agencyId: detail.agencyId,
        organization: detail.organization,
        firstName: detail.firstName,
        lastName: detail.lastName,
        city: detail.city,
        stateProvince: detail.stateProvince,
        country: detail.country,
        clientMatch: {
          method: isConfirmed ? 'confirmed_client_intel_mapping' : 'full_text_search',
          confidence,
        },
      },
    };
    return {
      externalKey,
      isConfirmed,
      confidence,
      proposedValue,
      evidence: [
        {
          label: proposedValue.title,
          source: 'Regulations.gov public comment',
          metadata: { commentId, docketId: detail.docketId },
        },
      ],
    };
  }

  private finishPage(
    state: BuildBackfill,
    pageNumber: number,
    pageOffset: number,
    search: SearchPage,
    remainingSearchCount: number,
    progress: PageProgress,
  ): AdvocacySourceBackfillState {
    const { count, processedSearchHits, detailFailures } = progress;
    const { hitCount: searchHitCount, totalElements, error: searchError } = search;
    const examinedThrough = pageNumber * REGULATORY_COMMENT_SEARCH_PAGE_SIZE;
    const pageFullyExamined = processedSearchHits === remainingSearchCount;
    const capped = totalElements != null && totalElements > REGULATORY_COMMENT_MAX_SEARCH_RESULTS;
    const reachedEnd =
      pageFullyExamined &&
      (searchHitCount < REGULATORY_COMMENT_SEARCH_PAGE_SIZE ||
        (totalElements != null && examinedThrough >= totalElements));
    const reachedCap =
      pageFullyExamined && examinedThrough >= REGULATORY_COMMENT_MAX_SEARCH_RESULTS;
    const detailError =
      detailFailures > 0 ? `${detailFailures} comment detail request(s) unavailable` : null;
    const status: AdvocacyBackfillStatus =
      searchError || detailError
        ? 'partial'
        : capped && reachedCap
          ? 'partial'
          : reachedEnd
            ? 'complete'
            : 'in_progress';
    const limitation =
      capped && reachedCap
        ? `Exact-phrase search capped at ${REGULATORY_COMMENT_MAX_SEARCH_RESULTS} of ${totalElements} results`
        : null;
    return state(
      status,
      processedSearchHits,
      count,
      status === 'complete' || reachedCap
        ? null
        : pageFullyExamined
          ? { nextPage: pageNumber + 1, offset: 0 }
          : { nextPage: pageNumber, offset: pageOffset + processedSearchHits },
      searchError ?? detailError,
      limitation,
    );
  }
}
