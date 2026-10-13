import type { OpportunityEligibilityV2, OpportunitySourceV2 } from './funding-opportunities-v2.js';
/** Canonical matched evidence exposed by current-source pipeline enrichment. */
export interface OpportunityCurrentEvidenceV2 {
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
}
export interface OpportunityWorkflowSummaryV2 {
    available: boolean;
    workflowId: string | null;
    status: string | null;
    humanDecision: string | null;
    owner: {
        userId: string;
        name: string | null;
        email: string | null;
    } | null;
    nextAction: string | null;
    nextActionDueAt: string | null;
    stage: string | null;
    stageBasis: 'recorded' | 'workflow_status' | 'legacy_override' | 'unstaged' | null;
    version: number | null;
    source: OpportunitySourceV2;
    sourceRecordId: string;
    sourceRecordType: string;
    publicReference: string | null;
    unavailableReason: string | null;
}
export interface OpportunityBookmarkStateV2 {
    saved: boolean;
    bookmarkId: string | null;
    scope: 'workspace' | 'client';
    clientId: string | null;
}
export interface OpportunityRecordDecorationV2 {
    workflow: OpportunityWorkflowSummaryV2;
    bookmark: OpportunityBookmarkStateV2;
    capabilities: {
        pursue: {
            allowed: boolean;
            reason: string;
        };
        save: {
            allowed: boolean;
            reason: string;
        };
    };
}
export interface OpportunityVisibleScopeV2 {
    tenantId: string;
    actorUserId: string;
    clientId: string | null;
}
//# sourceMappingURL=funding-opportunities-v2-workflow.d.ts.map