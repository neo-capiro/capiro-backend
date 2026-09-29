import { deadlineStatus, normalizeDeadline } from '@capiro/shared';
import type { AssuredEvidence } from './claim-ledger';
import type { ClaimCategory, EvidenceRequirement } from './evidence-plan';

const DAY_MS = 86_400_000;
export const STATUS_STATEMENT_MAX_AGE_DAYS = 90;
export const CURRENT_RETRIEVAL_MAX_AGE_DAYS = 7;

export type FreshnessState = 'fresh' | 'stale' | 'unknown';
export type FreshnessBasis = 'effectiveAt' | 'publishedAt' | 'retrievedAt' | 'none';
export interface FreshnessEvaluation {
  state: FreshnessState;
  ageDays: number | null;
  basis: FreshnessBasis;
  reason: string;
}

type PolicyKind = 'durable' | 'status' | 'deadline' | 'cycle' | 'dated';
export const FRESHNESS_POLICY: Readonly<Record<ClaimCategory, PolicyKind>> = {
  bill_status: 'status',
  member_vote: 'durable',
  current_role: 'status',
  budget_amount: 'cycle',
  budget_delta: 'cycle',
  enactment: 'durable',
  report_language: 'durable',
  regulatory_deadline: 'deadline',
  schedule_commitment: 'deadline',
  regulatory_stage: 'status',
  district_representation: 'status',
  grant_opportunity: 'deadline',
  grant_award: 'durable',
  procurement_opportunity: 'deadline',
  client_recommendation: 'status',
  negative_or_exhaustive: 'status',
  general_background: 'dated',
};

/**
 * A recent query proves a retrieval attempt, not that an older status statement
 * is current. Therefore retrievedAt is used only when no statement date exists;
 * it never overrides a stale effective/publication date.
 */
export function evaluateFreshness(input: {
  category: ClaimCategory | string;
  requirementFreshness?: EvidenceRequirement['freshness'];
  evidence: Pick<AssuredEvidence, 'publishedAt' | 'effectiveAt' | 'retrievedAt'>;
  asOf: string;
}): FreshnessEvaluation {
  const asOf = timestamp(input.asOf);
  if (asOf == null) return unknown('The comparison date is invalid.');
  const policy =
    FRESHNESS_POLICY[input.category as ClaimCategory] ??
    policyForRequirement(input.requirementFreshness);

  if (policy === 'durable') {
    const dated = datedBasis(input.evidence, asOf);
    return {
      state: 'fresh',
      ageDays: dated.ageDays,
      basis: dated.basis,
      reason: 'This category records a durable historical event; age does not invalidate it.',
    };
  }

  if (policy === 'deadline') {
    const deadline = input.evidence.effectiveAt ?? input.evidence.publishedAt;
    if (!deadline) return unknown('No deadline/effective date is available.');
    const status = deadlineStatus(
      input.asOf,
      normalizeDeadline({
        value: deadline,
        kind: 'datetime',
        source: 'assured_evidence',
      }),
    );
    const ageDays = age(deadline, asOf);
    if (status === 'closed')
      return {
        state: 'stale',
        ageDays,
        basis: input.evidence.effectiveAt ? 'effectiveAt' : 'publishedAt',
        reason: 'The opportunity or commitment deadline has passed.',
      };
    if (status === 'open')
      return {
        state: 'fresh',
        ageDays,
        basis: input.evidence.effectiveAt ? 'effectiveAt' : 'publishedAt',
        reason: 'The deadline has not passed.',
      };
    return unknown('The deadline could not be compared.');
  }

  if (policy === 'cycle') {
    const dated = datedBasis(input.evidence, asOf);
    return {
      state: dated.basis === 'none' ? 'unknown' : 'fresh',
      ...dated,
      reason:
        dated.basis === 'none'
          ? 'No cycle date is available; later-stage detection requires exact comparison.'
          : 'Age is recorded, but a later funding stage determines cycle staleness.',
    };
  }

  const statementDate = input.evidence.effectiveAt ?? input.evidence.publishedAt;
  if (statementDate) {
    const ageDays = age(statementDate, asOf);
    if (ageDays == null) return unknown('The statement date is invalid.');
    const basis = input.evidence.effectiveAt ? 'effectiveAt' : 'publishedAt';
    return ageDays > STATUS_STATEMENT_MAX_AGE_DAYS
      ? {
          state: 'stale',
          ageDays,
          basis,
          reason: `The status statement is older than ${STATUS_STATEMENT_MAX_AGE_DAYS} days; a recent retrieval alone cannot refresh it.`,
        }
      : {
          state: 'fresh',
          ageDays,
          basis,
          reason: 'The dated statement is within the provisional status window.',
        };
  }

  if (input.evidence.retrievedAt) {
    const ageDays = age(input.evidence.retrievedAt, asOf);
    if (ageDays == null) return unknown('The retrieval date is invalid.');
    return ageDays <= CURRENT_RETRIEVAL_MAX_AGE_DAYS
      ? {
          state: 'unknown',
          ageDays,
          basis: 'retrievedAt',
          reason: 'The retrieval is recent, but no dated statement proves current status.',
        }
      : {
          state: 'stale',
          ageDays,
          basis: 'retrievedAt',
          reason: `The only available observation is older than ${CURRENT_RETRIEVAL_MAX_AGE_DAYS} days.`,
        };
  }
  return unknown('No publication, effective, or retrieval date is available.');
}

function policyForRequirement(value?: EvidenceRequirement['freshness']): PolicyKind {
  if (value === 'durable') return 'durable';
  if (value === 'current_cycle') return 'cycle';
  return value === 'same_turn' || value === 'current_session' ? 'status' : 'dated';
}
function datedBasis(
  evidence: Pick<AssuredEvidence, 'publishedAt' | 'effectiveAt' | 'retrievedAt'>,
  asOf: number,
) {
  const entries: Array<[FreshnessBasis, string | undefined]> = [
    ['effectiveAt', evidence.effectiveAt],
    ['publishedAt', evidence.publishedAt],
    ['retrievedAt', evidence.retrievedAt],
  ];
  for (const [basis, value] of entries) if (value) return { ageDays: age(value, asOf), basis };
  return { ageDays: null, basis: 'none' as const };
}
function unknown(reason: string): FreshnessEvaluation {
  return { state: 'unknown', ageDays: null, basis: 'none', reason };
}
function age(value: string, asOf: number): number | null {
  const date = timestamp(value);
  return date == null ? null : Math.floor((asOf - date) / DAY_MS);
}
function timestamp(value: string): number | null {
  const result = new Date(value).getTime();
  return Number.isNaN(result) ? null : result;
}
