/**
 * First-class Claim / Evidence assembly (data warehouse #5). Mirrors the
 * additive Prisma `Claim` / `Evidence` tables (P0-T7). Pure: takes claim drafts
 * (no DB ids) and partitions them into supported (>= 1 evidence) vs unsupported.
 *
 * Unsupported claims are FLAGGED, never silently dropped — Document Generation
 * (A16) and client packets (SC3.3) must surface them, not emit them as fact.
 */
export type ClaimConfidence = 'high' | 'medium' | 'low' | 'unknown';

export interface EvidenceDraft {
  /** Canonical source kind, e.g. 'congress_bill', 'lda_filing', 'transcript_segment'. */
  sourceType: string;
  /** Canonical id within that source (Appendix B), e.g. a Congress.gov bill id. */
  sourceId: string;
  url?: string;
  quote?: string;
  pageNumber?: number;
  accessedAt: Date;
}

export interface ClaimDraft {
  /** e.g. 'client', 'bill', 'program_element', 'member'. */
  subjectType: string;
  subjectId: string;
  statement: string;
  confidence: ClaimConfidence;
  /** Recency of the freshest evidence backing the claim. */
  freshnessAt?: Date;
  evidence: EvidenceDraft[];
}

/** A claim proven by at least one piece of evidence. */
export interface SupportedClaim extends ClaimDraft {
  evidence: [EvidenceDraft, ...EvidenceDraft[]];
}

export interface ClaimMap {
  supported: SupportedClaim[];
  /** Zero-evidence claims, retained and flagged (never dropped). */
  unsupported: ClaimDraft[];
}

export function assembleClaimMap(claims: readonly ClaimDraft[]): ClaimMap {
  const supported: SupportedClaim[] = [];
  const unsupported: ClaimDraft[] = [];
  for (const claim of claims) {
    if (claim.evidence.length > 0) {
      supported.push(claim as SupportedClaim);
    } else {
      unsupported.push(claim);
    }
  }
  return { supported, unsupported };
}

/** The freshest evidence date across a claim's evidence, or `null` if none. */
export function claimFreshness(claim: ClaimDraft): Date | null {
  let freshest: Date | null = null;
  for (const e of claim.evidence) {
    if (freshest === null || e.accessedAt.getTime() > freshest.getTime()) {
      freshest = e.accessedAt;
    }
  }
  return freshest;
}
