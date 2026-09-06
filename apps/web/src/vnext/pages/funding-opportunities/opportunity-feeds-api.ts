import type {
  InboxDibbsFacts,
  InboxForecastFacts,
  InboxSbirFacts,
  OpportunityDecision,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';

export type TangoOpportunityFeed = 'agency_forecast' | 'dibbs' | 'sbir_sttr';
/** Mirrors FundingFeedRecord; these remain source-specific records, not solicitations. */
export interface FundingFeedRecord {
  source: TangoOpportunityFeed;
  sourceRecordId: string;
  title: string;
  description: string | null;
  agency: string | null;
  sourceUrl: string | null;
  responseDeadline: string | null;
  anticipatedAwardDate: string | null;
  status: string | null;
  isActive: boolean | null;
  naicsCode: string | null;
  lastSyncedAt: string;
  sourceUpdatedAt: string | null;
  facts: InboxForecastFacts | InboxDibbsFacts | InboxSbirFacts;
  workflow: {
    id: string;
    status: string;
    notes?: string | null;
    ownerUserId?: string | null;
    nextAction?: string | null;
    nextActionDueAt?: string | null;
  } | null;
  decision: OpportunityDecision | null;
  clientId: string | null;
}
export interface FundingFeedResponse {
  source: TangoOpportunityFeed;
  clientId: string | null;
  rows: FundingFeedRecord[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  freshness: {
    state: 'not_synced' | 'current' | 'stale' | 'failed' | 'unknown';
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastRunStatus: string | null;
  };
  generatedAt: string;
}
export function fundingFeedPath(source: TangoOpportunityFeed, id?: string) {
  return `/api/intelligence/opportunities/feeds/${source}${id ? `/${encodeURIComponent(id)}` : ''}`;
}
