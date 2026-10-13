export declare const OPPORTUNITY_SEARCH_MODES: readonly ["matched", "all"];
export type OpportunitySearchMode = (typeof OPPORTUNITY_SEARCH_MODES)[number];
export declare const OPPORTUNITY_SOURCES_V2: readonly ["grants_gov", "sam_gov", "agency_forecast", "dibbs", "sbir_sttr", "ca_portal"];
export type OpportunitySourceV2 = (typeof OPPORTUNITY_SOURCES_V2)[number];
export declare const OPPORTUNITY_LIFECYCLES_V2: readonly ["active", "forecast", "closed", "post_award"];
export type OpportunityLifecycleV2 = (typeof OPPORTUNITY_LIFECYCLES_V2)[number];
export declare const OPPORTUNITY_TYPES_V2: readonly ["grant", "cooperative_agreement", "loan_assistance", "contract", "solicitation", "task_order_vehicle", "presolicitation", "sources_sought", "forecast", "award", "other"];
export type OpportunityTypeV2 = (typeof OPPORTUNITY_TYPES_V2)[number];
export declare const OPPORTUNITY_SORTS_V2: readonly ["deadline", "relevance", "title", "posted", "value", "agency", "updated"];
export type OpportunitySortV2 = (typeof OPPORTUNITY_SORTS_V2)[number];
export type OpportunitySortDirectionV2 = 'asc' | 'desc';
export declare const OPPORTUNITY_QUERY_MATCHES_V2: readonly ["keywords", "phrase"];
export type OpportunityQueryMatchV2 = (typeof OPPORTUNITY_QUERY_MATCHES_V2)[number];
export declare const MAX_OPPORTUNITY_KEYWORD_TERMS = 100;
export type SearchVisibilityV2 = 'private' | 'tenant';
export type OpportunityEligibilityV2 = 'eligible' | 'ineligible' | 'needs_review' | 'unknown';
export interface OpportunityClientCapabilityV2 {
    state: OpportunityEligibilityV2;
    allowed: boolean;
    reason: string;
}
export interface OpportunityProfileGapV2 {
    title: string;
    tag: string;
    tone: 'warn' | 'muted';
    body: string;
}
export interface OpportunityProfileGapsV2 {
    items: OpportunityProfileGapV2[];
    actualUnscoredCount: number | null;
    profileLink: string;
}
export type OpportunityPostedV2 = 'last_7_days' | 'last_30_days' | 'last_90_days' | 'this_fiscal_year' | 'any';
export type OpportunityDeadlineWindowV2 = 'any' | '14d' | '30d' | '90d' | '180d';
export interface OpportunitySearchCriteriaV2 {
    schemaVersion: 2;
    mode: OpportunitySearchMode;
    clientId: string | null;
    query: string;
    /** Explicit new-search semantics. Omitted preserves legacy literal phrase matching. */
    queryMatch?: OpportunityQueryMatchV2;
    /** Independent search terms. An opportunity may match any one of these terms. */
    keywordTerms?: string[];
    sources: OpportunitySourceV2[];
    types: OpportunityTypeV2[];
    lifecycle: OpportunityLifecycleV2[];
    agencies: string[];
    sectors: string[];
    naicsCodes: string[];
    pscCodes: string[];
    setAsideCodes: string[];
    eligibility: OpportunityEligibilityV2[];
    posted: OpportunityPostedV2[];
    geography: string[];
    applicantTypes: string[];
    funding: string[];
    costShare: string[];
    methods: string[];
    disbursement: string[];
    grantPrerequisites: string[];
    codes: string[];
    deadlineWindow: OpportunityDeadlineWindowV2;
    deadlineFrom: string | null;
    deadlineTo: string | null;
    sort: OpportunitySortV2;
    direction: OpportunitySortDirectionV2;
    page: number;
    pageSize: number;
}
export interface OpportunityCriteriaWarning {
    key: string;
    reason: 'unsupported' | 'retired' | 'invalid';
}
export interface NormalizedOpportunitySearchCriteria {
    criteria: OpportunitySearchCriteriaV2;
    warnings: OpportunityCriteriaWarning[];
    unsupported: Record<string, unknown>;
}
export interface OpportunitySearchRecordV2 {
    id: string;
    source: OpportunitySourceV2;
    sourceRecordId: string;
    title: string;
    agency: string | null;
    sourceUrl: string | null;
    type: OpportunityTypeV2;
    lifecycle: OpportunityLifecycleV2;
    postedDate: string | null;
    deadline: string | null;
    closeOrArchiveDate: string | null;
    isPursuable: boolean;
    summary: string | null;
    naicsCodes: string[];
    pscCodes: string[];
    setAside: string | null;
    applicantTypes: string[];
    geography: string[];
    value: number | null;
    valueBasis: 'source_backed' | 'not_stated_by_source';
    sourceFacts: {
        provenance: string;
        [key: string]: unknown;
    };
    relevanceScore: number | null;
    matchedSignals: Array<{
        signal: string;
        strength: 'strong' | 'moderate' | 'weak';
        matchedOn: string;
    }>;
    eligibility: {
        state: OpportunityEligibilityV2;
        reason: string;
    } | null;
    clientId: string | null;
    /** Client-specific live capability; independent of display mode/ranking suppression. */
    clientCapability?: OpportunityClientCapabilityV2 | null;
    /** Bounded tenant/client workflow and bookmark decoration, when requested. */
    decoration?: import('./funding-opportunities-v2-workflow.js').OpportunityRecordDecorationV2;
}
export interface OpportunitySourceFreshnessV2 {
    source: OpportunitySourceV2;
    state: 'current' | 'degraded' | 'stale' | 'never_synced' | 'initial_partial' | 'error_cached' | 'unavailable' | 'not_enabled' | 'unknown';
    recordCount: number | null;
    activeRecordCount: number | null;
    lastSyncedAt: string | null;
    /** Most recent attempt, including partial/error runs. */
    latestAttemptAt?: string | null;
    /** Most recent clean complete success, independent of the latest attempt. */
    lastSuccessAt?: string | null;
}
/** Stable response for the shell/source-health read; it is not narrowed by search criteria. */
export interface OpportunitySourceHealthResponseV2 {
    sources: OpportunitySourceFreshnessV2[];
    generatedAt: string;
}
export interface OpportunitySearchResponseV2 {
    criteria: OpportunitySearchCriteriaV2;
    opportunities: OpportunitySearchRecordV2[];
    page: number;
    pageSize: number;
    total: number | null;
    totalIsCapped: boolean;
    /** True only when every queried enabled source reports current catalog health. */
    catalogComplete: boolean;
    counts: {
        grants: number | null;
        contracts: number | null;
        active: number | null;
        closed: number | null;
    };
    mode: OpportunitySearchMode;
    clientId: string | null;
    freshness: OpportunitySourceFreshnessV2[];
    provenance: Array<{
        source: OpportunitySourceV2;
        queried: boolean;
        returned: number;
        count: number | null;
        capped: boolean;
    }>;
    emptyReason: string | null;
    /** Present only for matched searches with an authorized selected client. */
    profileGaps: OpportunityProfileGapsV2 | null;
    generatedAt: string;
}
export interface SavedSearchSummaryV2 {
    id: string;
    name: string;
    description: string | null;
    visibility: SearchVisibilityV2;
    clientId: string | null;
    criteria: OpportunitySearchCriteriaV2;
    warnings: OpportunityCriteriaWarning[];
    archivedAt: string | null;
    createdByUserId: string;
    updatedAt: string;
}
export declare function normalizeOpportunitySearchCriteria(input: unknown): NormalizedOpportunitySearchCriteria;
//# sourceMappingURL=funding-opportunities-v2.d.ts.map