import { sha256CanonicalJson } from '../../defense-budget/contracts/canonical-json.js';
import { normalizeIdentityText } from './community-funding.parser.js';
import type { FundingCandidate } from './community-funding.types.js';

// Shared canonical hashing is intentionally imported rather than cloned. This module is
// government-data-specific; the dependency is one-way and has no defense domain behavior.
export function communityFundingIdentity(candidate: FundingCandidate, sourceDocumentId: string): string {
  return sha256CanonicalJson({
    chamber: candidate.chamber, requestType: candidate.requestType, fiscalYear: candidate.fiscalYear,
    requesterName: normalizeIdentityText(candidate.requesterName), recipientName: normalizeIdentityText(candidate.recipientName),
    projectTitle: normalizeIdentityText(candidate.projectTitle),
    appropriationsAccountRaw: normalizeIdentityText(candidate.appropriationsAccountRaw ?? ''), sourceDocumentId,
  });
}
