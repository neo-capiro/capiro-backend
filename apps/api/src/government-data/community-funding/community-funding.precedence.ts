import type { FundingCandidate } from './community-funding.types.js';

/**
 * Canonical merge / precedence policy for when a second (or later) authoritative
 * source publishes the same logical community funding request but disagrees on a
 * non-identity value (requested amount, subcommittee wording, account label,
 * description, etc.) — see community-funding.identity.ts for why these fields are
 * NOT part of identity in the first place.
 *
 * The explicit rule, never "last file processed wins":
 *
 *   1. finalAmountUsd: adopt a candidate's value ONLY when the canonical row's
 *      current value is null and the candidate's is not. A non-null final/enacted
 *      amount is NEVER overwritten with a requested-only (null) value from a later
 *      source — the hardest single requirement in this repair.
 *   2. requestedAmountUsd + amountStageRaw move together, and only escalate to a
 *      strictly higher-ranked amount stage (see AMOUNT_STAGE_RANK below). A
 *      same-or-lower-ranked stage from a later source never overwrites an
 *      already-recorded higher stage.
 *   3. Every other descriptive field (requesterName, requester state/district,
 *      recipient address/city/state/zip, project description, appropriations
 *      account, subcommittee): first-seen wins, unconditionally. This keeps the
 *      canonical row conservative and deterministic. Nothing is lost by this
 *      choice — the disagreeing raw value from the later source is always written
 *      onto that source's own CommunityFundingRequestSource row regardless of what
 *      the canonical projection picks, so every conflicting authoritative value
 *      stays auditable.
 *
 * Real-data note (see community-funding.identity.ts): the FY2026 House CJS PDF and
 * the FY2026 House consolidated XLSX disagree on requestedAmountUsd for the
 * majority of matched requests (324 agree / 525 disagree across the real rehearsal
 * corpus) — this is NOT parser noise, it reflects a real stage distinction: the
 * PDF's 'house_amount' is the subcommittee's own funding mark for the request,
 * while the XLSX's 'amount_requested' is the member's original ask. Rule 2 exists
 * specifically to make that escalation deterministic rather than accidental.
 */
const AMOUNT_STAGE_RANK: Record<FundingCandidate['amountStageRaw'], number> = {
  amount_requested: 0,
  senate_recommendation: 0,
  house_amount: 1,
};

export interface CanonicalNonIdentityFields {
  requesterName: string;
  requesterState: string | null;
  requesterDistrict: string | null;
  recipientAddress: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  projectDescription: string | null;
  requestedAmountUsd: string;
  finalAmountUsd: string | null;
  amountStageRaw: FundingCandidate['amountStageRaw'];
  appropriationsAccountRaw: string | null;
  subcommittee: string | null;
}

export interface CanonicalMergeResult {
  fields: CanonicalNonIdentityFields;
  /** True iff at least one field's persisted value actually changes. */
  changed: boolean;
}

export function mergeCanonicalNonIdentityFields(
  current: CanonicalNonIdentityFields,
  candidate: FundingCandidate,
): CanonicalMergeResult {
  const candidateStageRank = AMOUNT_STAGE_RANK[candidate.amountStageRaw];
  const currentStageRank = AMOUNT_STAGE_RANK[current.amountStageRaw];
  const escalateAmount = candidateStageRank > currentStageRank;

  const finalAmountUsd = current.finalAmountUsd ?? candidate.finalAmountUsd ?? null;
  const requestedAmountUsd = escalateAmount ? candidate.requestedAmountUsd : current.requestedAmountUsd;
  const amountStageRaw = escalateAmount ? candidate.amountStageRaw : current.amountStageRaw;

  const fields: CanonicalNonIdentityFields = {
    requesterName: current.requesterName,
    requesterState: current.requesterState ?? candidate.requesterState ?? null,
    requesterDistrict: current.requesterDistrict ?? candidate.requesterDistrict ?? null,
    recipientAddress: current.recipientAddress,
    city: current.city,
    state: current.state ?? candidate.state ?? null,
    zip: current.zip,
    projectDescription: current.projectDescription,
    requestedAmountUsd,
    finalAmountUsd,
    amountStageRaw,
    appropriationsAccountRaw: current.appropriationsAccountRaw,
    subcommittee: current.subcommittee,
  };

  const changed =
    fields.requesterState !== current.requesterState ||
    fields.requesterDistrict !== current.requesterDistrict ||
    fields.state !== current.state ||
    fields.finalAmountUsd !== current.finalAmountUsd ||
    fields.requestedAmountUsd !== current.requestedAmountUsd ||
    fields.amountStageRaw !== current.amountStageRaw;

  return { fields, changed };
}
