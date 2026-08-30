/**
 * Deterministic appropriations outcome correlation for CPF/CDS advocacy.
 *
 * Product rules (handoff after #1345):
 *   - Anchor is the canonical community_funding_request id when present.
 *   - Secondary exact key: appropriations account + fiscal year (both required).
 *   - Explicit later authoritative appropriations/funding evidence only.
 *   - Always causationClaimed: false — never "the recipient secured funding."
 *   - Never infer a match from temporal proximity or free-text similarity alone.
 *
 * This module is pure (no Prisma) so every rule is unit-testable. The completion
 * service's lifecycle_outcomes rail calls into it; semantic scoreAdvocacyOutcome
 * is deliberately NOT a fallback for cpf_request/cds_request record types.
 */

import { normalizeIdentityText } from '../government-data/community-funding/community-funding.parser.js';

export type AppropriationsOutcomeMatchedOn =
  | 'community_funding_request_id'
  | 'appropriations_account_fy';

export interface CommunityFundingAdvocacyAnchor {
  /** Canonical community_funding_request.id (UUID). */
  communityFundingRequestId?: string | null;
  /** Raw or normalized appropriations account from the CPF/CDS request. */
  appropriationsAccountRaw?: string | null;
  appropriationsAccountNormalized?: string | null;
  fiscalYear?: number | null;
  /** cpf_request | cds_request | other */
  recordType?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
}

export interface AppropriationsOutcomeEvidence {
  communityFundingRequestId?: string | null;
  /** Explicit later funding evidence must name the account when not request-anchored. */
  appropriationsAccountRaw?: string | null;
  appropriationsAccountNormalized?: string | null;
  fiscalYear?: number | string | null;
  /** Optional stage label from the later source (enacted, conference, etc.). */
  amountStage?: string | null;
  amountFrom?: string | number | null;
  amountTo?: string | number | null;
  /** Free-form notes — NEVER used as a match key. */
  notes?: string | null;
}

export interface AppropriationsOutcomeMatch {
  matchedOn: AppropriationsOutcomeMatchedOn;
  score: number;
  relationship: 'strongly_aligned';
  causationClaimed: false;
  accountKey: string | null;
  fiscalYear: number | null;
  communityFundingRequestId: string | null;
}

/** True when this advocacy row is a CPF/CDS public-request finding/record. */
export function isCommunityFundingAdvocacyRecord(
  advocacy: CommunityFundingAdvocacyAnchor & { externalKey?: string | null },
): boolean {
  const recordType = (advocacy.recordType ?? '').toLowerCase();
  if (recordType === 'cpf_request' || recordType === 'cds_request') return true;
  const sourceType = (advocacy.sourceType ?? '').toLowerCase();
  if (sourceType === 'community_funding') return true;
  const externalKey = advocacy.externalKey ?? '';
  return externalKey.startsWith('community_funding:');
}

export function normalizeAppropriationsAccountKey(
  raw: string | null | undefined,
  normalized?: string | null | undefined,
): string | null {
  const preferred = (normalized ?? '').trim() || (raw ?? '').trim();
  if (!preferred) return null;
  const key = normalizeIdentityText(preferred);
  return key.length ? key : null;
}

export function parseFiscalYear(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1990 && value <= 2100) {
    return value;
  }
  if (typeof value === 'string' && /^\d{4}$/.test(value.trim())) {
    const n = Number(value.trim());
    if (n >= 1990 && n <= 2100) return n;
  }
  return null;
}

/**
 * Resolve a deterministic CPF/CDS ↔ appropriations evidence match.
 *
 * Returns null when:
 *   - neither exact key is complete
 *   - keys disagree
 *   - later-evidence ordering fails (outcome not strictly after attributable activity)
 *
 * Never consults title/notes/amount-only signals.
 */
export function matchCommunityFundingAppropriationsDeterministically(
  advocacy: CommunityFundingAdvocacyAnchor & { externalKey?: string | null },
  outcomeEvidence: AppropriationsOutcomeEvidence,
  opts?: {
    /** Earliest attributable CPF/CDS activity on the Matter/record, if known. */
    attributableActivityDate?: Date | null;
    /** When the later appropriations/funding evidence was observed. */
    outcomeObservedAt?: Date | null;
  },
): AppropriationsOutcomeMatch | null {
  const attributable = opts?.attributableActivityDate ?? null;
  const observedAt = opts?.outcomeObservedAt ?? null;
  if (attributable && observedAt && observedAt.getTime() <= attributable.getTime()) {
    // Later authoritative evidence must be strictly after the request/activity.
    return null;
  }

  const advocacyRequestId =
    (advocacy.communityFundingRequestId ?? '').trim() ||
    (advocacy.sourceType === 'community_funding' ? (advocacy.sourceId ?? '').trim() : '') ||
    (advocacy.externalKey?.startsWith('community_funding:')
      ? advocacy.externalKey.slice('community_funding:'.length)
      : '');
  const evidenceRequestId = (outcomeEvidence.communityFundingRequestId ?? '').trim();

  if (advocacyRequestId && evidenceRequestId) {
    if (advocacyRequestId === evidenceRequestId) {
      return {
        matchedOn: 'community_funding_request_id',
        score: 0.97,
        relationship: 'strongly_aligned',
        causationClaimed: false,
        accountKey: normalizeAppropriationsAccountKey(
          outcomeEvidence.appropriationsAccountRaw,
          outcomeEvidence.appropriationsAccountNormalized,
        ),
        fiscalYear:
          parseFiscalYear(outcomeEvidence.fiscalYear) ?? parseFiscalYear(advocacy.fiscalYear),
        communityFundingRequestId: advocacyRequestId,
      };
    }
    // Both sides name a canonical request and they disagree — fail closed.
    // Do not silently fall through to a weaker account/FY match that would
    // glue two different real requests together.
    return null;
  }

  const advocacyAccount = normalizeAppropriationsAccountKey(
    advocacy.appropriationsAccountRaw,
    advocacy.appropriationsAccountNormalized,
  );
  const evidenceAccount = normalizeAppropriationsAccountKey(
    outcomeEvidence.appropriationsAccountRaw,
    outcomeEvidence.appropriationsAccountNormalized,
  );
  const advocacyFy = parseFiscalYear(advocacy.fiscalYear);
  const evidenceFy = parseFiscalYear(outcomeEvidence.fiscalYear);

  if (advocacyAccount && evidenceAccount && advocacyFy != null && evidenceFy != null) {
    if (advocacyAccount === evidenceAccount && advocacyFy === evidenceFy) {
      return {
        matchedOn: 'appropriations_account_fy',
        score: 0.93,
        relationship: 'strongly_aligned',
        causationClaimed: false,
        accountKey: advocacyAccount,
        fiscalYear: advocacyFy,
        communityFundingRequestId: advocacyRequestId || null,
      };
    }
  }

  return null;
}

/**
 * Build a review-gated appropriations_outcome proposedValue.
 * Returns null when the candidate is not a deterministic later match.
 *
 * Language is deliberately non-causal: the finding describes observed
 * appropriations/funding evidence aligned to the request, never that the
 * recipient "secured" the money because of advocacy.
 */
export function buildAppropriationsOutcomeFinding(input: {
  matterId: string | null;
  advocacyExternalKey: string;
  communityFundingRequestId: string | null;
  outcome: {
    id?: string | null;
    kind: string;
    sourceType: string;
    sourceId?: string | null;
    observedAt: string;
    notes?: string | null;
    evidence: AppropriationsOutcomeEvidence;
  };
  match: AppropriationsOutcomeMatch;
}): Record<string, unknown> {
  return {
    matterId: input.matterId,
    advocacyExternalKey: input.advocacyExternalKey,
    outcomeEventId: input.outcome.id ?? null,
    outcomeKind: input.outcome.kind,
    observedAt: input.outcome.observedAt,
    notes: input.outcome.notes ?? null,
    evidence: input.outcome.evidence,
    communityFundingRequestId: input.match.communityFundingRequestId,
    appropriationsAccountKey: input.match.accountKey,
    fiscalYear: input.match.fiscalYear,
    relationship: input.match.relationship,
    matchedOn: input.match.matchedOn,
    causationClaimed: false as const,
    score: input.match.score,
    // Honest label for reviewers — never "funding secured".
    summary:
      input.match.matchedOn === 'community_funding_request_id'
        ? 'Later appropriations/funding evidence cites this exact canonical CPF/CDS request. This is alignment of identifiers, not proof the recipient secured the funds or that advocacy caused the outcome.'
        : 'Later appropriations/funding evidence matches this CPF/CDS request on exact appropriations account and fiscal year. This is identifier alignment only — not a claim that the recipient secured funding.',
  };
}
