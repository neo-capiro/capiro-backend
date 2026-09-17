import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  OPPORTUNITY_SOURCES_V2,
  type OpportunitySearchCriteriaV2,
  type OpportunitySearchResponseV2,
} from '@capiro/shared';
import {
  FUNDING_OPPORTUNITIES_PIPELINE_FEATURE,
  type PipelineBoardView,
} from '../../pages/funding-opportunities/funding-opportunities-domain.js';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import { formatSourceDate } from '../../pages/funding-opportunities/funding-opportunities-domain.js';
import {
  FUNDING_OPPORTUNITY_V2_SOURCE_PRESENTATION,
  getFundingOpportunityDeadlinePresentation,
} from '../../pages/funding-opportunities/funding-opportunities-v2-detail-types.js';
import { createFundingOpportunityV2Api } from '../../pages/funding-opportunities/FundingOpportunitiesV2Adapter.js';
import { opportunityQueryKeys } from '../../pages/funding-opportunities/opportunity-query-cache.js';

export const FUNDING_OPPORTUNITIES_FEATURE = 'funding_opportunities';

export interface ClientFundingOpportunitiesV2 {
  criteria: OpportunitySearchCriteriaV2;
  search: ReturnType<typeof useQuery<OpportunitySearchResponseV2>>;
  pipeline: ReturnType<typeof useQuery<PipelineBoardView>>;
  feature: { enabled: boolean; ready: boolean };
  pipelineFeature: { enabled: boolean; ready: boolean };
}

export function useClientFundingOpportunitiesV2(clientId: string): ClientFundingOpportunitiesV2 {
  const api = useApi();
  const feature = useIntelFeature(FUNDING_OPPORTUNITIES_FEATURE);
  const pipelineFeature = useIntelFeature(FUNDING_OPPORTUNITIES_PIPELINE_FEATURE);
  const v2 = useMemo(() => createFundingOpportunityV2Api(api), [api]);
  const criteria = useMemo<OpportunitySearchCriteriaV2>(
    () => ({
      schemaVersion: 2,
      mode: 'matched',
      clientId: clientId || null,
      query: '',
      sources: [...OPPORTUNITY_SOURCES_V2],
      types: [],
      lifecycle: ['active'],
      agencies: [],
      sectors: [],
      naicsCodes: [],
      pscCodes: [],
      setAsideCodes: [],
      eligibility: [],
      posted: [],
      geography: [],
      applicantTypes: [],
      funding: [],
      costShare: [],
      methods: [],
      disbursement: [],
      grantPrerequisites: [],
      codes: [],
      deadlineWindow: 'any',
      deadlineFrom: null,
      deadlineTo: null,
      sort: 'deadline',
      direction: 'asc',
      page: 1,
      pageSize: 20,
    }),
    [clientId],
  );
  const enabled = Boolean(clientId) && feature.ready && feature.enabled;
  const search = useQuery<OpportunitySearchResponseV2>({
    queryKey: opportunityQueryKeys.search(criteria),
    queryFn: ({ signal }) => v2.search(criteria, signal),
    enabled,
    staleTime: 2 * 60_000,
    retry: 1,
  });
  const rawPipeline = useQuery<PipelineBoardView>({
    queryKey: opportunityQueryKeys.pipeline(clientId || null),
    queryFn: async () =>
      (
        await api.get<PipelineBoardView>(
          `/api/intelligence/clients/${encodeURIComponent(clientId)}/pipeline`,
        )
      ).data,
    enabled: enabled && pipelineFeature.ready && pipelineFeature.enabled,
    staleTime: 2 * 60_000,
    retry: 1,
  });
  const pipelineEnabled = enabled && pipelineFeature.ready && pipelineFeature.enabled;
  const pipeline = pipelineEnabled
    ? rawPipeline
    : ({ ...rawPipeline, data: undefined, isSuccess: false } as typeof rawPipeline);
  const visibleSearch = enabled
    ? search
    : ({ ...search, data: undefined, isSuccess: false } as typeof search);
  return { criteria, search: visibleSearch, pipeline, feature, pipelineFeature };
}

export function countOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function sumKnown(
  left: number | null | undefined,
  right: number | null | undefined,
): number | null {
  const a = countOrNull(left);
  const b = countOrNull(right);
  return a == null || b == null ? null : a + b;
}

export function pursuingCount(pipeline: PipelineBoardView | undefined): number | null {
  const stage = pipeline?.counts?.stages?.find((item) => item.stage === 'pursuing')?.count;
  return countOrNull(stage);
}

export function clientOpportunityDetailPath(
  clientId: string,
  source: string,
  sourceRecordId: string,
): string {
  return `/intelligence/opportunities/${encodeURIComponent(source)}/${encodeURIComponent(sourceRecordId)}?client=${encodeURIComponent(clientId)}`;
}

export function sourceLabel(source: string): string {
  return (
    FUNDING_OPPORTUNITY_V2_SOURCE_PRESENTATION[
      source as keyof typeof FUNDING_OPPORTUNITY_V2_SOURCE_PRESENTATION
    ]?.label ?? source.replaceAll('_', ' ')
  );
}
export function opportunityTypeLabel(type: string): string {
  return type.replaceAll('_', ' ');
}

export function deadlineLabel(value: string | null): string {
  return formatSourceDate(value, 'No deadline stated');
}
export function opportunityDeadline(
  value: string | null,
  workflowStatus: string | null,
  lifecycle: OpportunitySearchResponseV2['criteria']['lifecycle'][number] = 'active',
) {
  return getFundingOpportunityDeadlinePresentation({
    deadline: value,
    lifecycle: lifecycle === 'post_award' ? 'closed' : lifecycle,
    workflowStatus,
    now: new Date(),
  });
}
export function opportunityValueLabel(value: number | null, basis: string): string {
  if (value == null || basis !== 'source_backed') return 'Value not stated';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

export function freshnessLabel(source: OpportunitySearchResponseV2['freshness'][number]): string {
  const label = sourceLabel(source.source);
  switch (source.state) {
    case 'unavailable':
      return `${label}: unavailable`;
    case 'not_enabled':
      return `${label}: not enabled`;
    case 'never_synced':
      return `${label}: not yet synced`;
    case 'initial_partial':
      return `${label}: initial sync is partial${source.lastSyncedAt ? `; last observed ${deadlineLabel(source.lastSyncedAt)}` : ''}`;
    case 'unknown':
      return `${label}: freshness unknown${source.lastSyncedAt ? `; last known ${deadlineLabel(source.lastSyncedAt)}` : ''}`;
    case 'error_cached':
      return `${label}: degraded after sync error${source.lastSyncedAt ? `; last observed ${deadlineLabel(source.lastSyncedAt)}` : ''}`;
    case 'stale':
      return `${label}: stale${source.lastSyncedAt ? `; last observed ${deadlineLabel(source.lastSyncedAt)}` : ''}`;
    case 'degraded':
      return `${label}: degraded${source.lastSyncedAt ? `; last observed ${deadlineLabel(source.lastSyncedAt)}` : ''}`;
    case 'current':
      return `${label}: current to ${source.lastSyncedAt ? deadlineLabel(source.lastSyncedAt) : 'unknown'}`;
  }
}
export function emptyExplanation(response: OpportunitySearchResponseV2): string {
  if (response.profileGaps?.items.length)
    return (
      response.profileGaps.items[0]?.body ??
      'The client profile needs more information for matching.'
    );
  if (
    response.freshness.some((item) => item.state === 'never_synced' || item.state === 'unavailable')
  ) {
    return 'No matches are available from one or more opportunity sources yet; source health is shown below.';
  }
  if (response.emptyReason)
    return 'No active opportunities matched this client profile in the available sources.';
  return 'No active opportunities matched this client profile in the available sources.';
}
