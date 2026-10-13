export type ApiToolReadOutcomeKind = 'complete' | 'empty' | 'partial' | 'unavailable' | 'failed';
export interface ApiToolReadOutcome {
    kind: ApiToolReadOutcomeKind;
    reason?: string;
}
/** Governance observations only: proposal text is never an approved memory fact. */
export interface MeriPendingMemoryProposalRead {
    tool: 'list_memory_proposals';
    enabled: boolean;
    authority: 'own_pending_proposals';
    claimsAreApprovedFacts: false;
    scope: {
        tenantId: string;
        userId: string;
        clientId: string | null;
    };
    candidates: Array<{
        id: string;
        status: 'pending';
        approvedFact: false;
        scope: string;
        clientId: string | null;
        sourceKind: string;
        createdAt: string;
        restricted: boolean;
        title: string | null;
        proposedText: string | null;
        contentTruncated: boolean;
    }>;
    nextCursor: string | null;
    coverage: {
        firstPage: boolean;
        complete: boolean;
        reason: string;
    };
}
/**
 * Normalize only API read contracts whose owner-produced output shapes are
 * validated here. Unqualified tools return null and retain their existing path;
 * arbitrary source bodies are never scanned for generic success/error keys.
 */
export declare function classifyApiToolReadOutcome(toolName: string, payload: unknown): ApiToolReadOutcome | null;
//# sourceMappingURL=meri-read-outcome.d.ts.map