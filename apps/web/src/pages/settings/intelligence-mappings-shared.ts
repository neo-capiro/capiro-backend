/**
 * UI-free intelligence-mappings domain vocabulary — extracted from
 * IntelligenceMappingsPage.tsx (antd) so the vNext Settings module shares the
 * exact same review-safety rules and labels (extraction pattern, purge
 * Phase 2). The legacy page imports from here; behavior unchanged.
 */
import type { QueryClient } from '@tanstack/react-query';

export interface ClientIntelMapping {
  id: string;
  clientId: string;
  clientName: string;
  source: string;
  externalId: string;
  externalName: string;
  confidence: number;
  confirmed: boolean;
  /** Identity tier vocabulary; null on rows written before it was recorded. */
  matchBasis: string | null;
  matchTier: number | null;
  relationshipType: string | null;
  rollUpAwards: boolean | null;
  reviewStatus: 'candidate' | 'confirmed' | 'rejected' | 'superseded';
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResolutionSummary {
  totalClients: number;
  mappingsCreated: number;
  autoConfirmed: number;
  needsReview: number;
}

/** Mirrors MatchExplanation in apps/api/src/intelligence/contractor-identity.ts. */
export interface MatchExplanation {
  basis: string;
  tier: number;
  exactIdentifiers: Record<string, string>;
  normalizedClientName: string;
  normalizedCandidateName: string;
  corroborators: string[];
  conflicts: string[];
  awardCount: number | null;
  totalObligated: number | null;
  latestAwardDate: string | null;
  sourceSyncedAt: string | null;
}

export interface ContractorCandidateView {
  client: { id: string; name: string; uei: string | null; cageCode: string | null };
  candidates: Array<{
    contractorId: string;
    contractorName: string;
    confidence: number;
    autoConfirmEligible: boolean;
    matchBasis: string;
    matchTier: number;
    explanation: MatchExplanation | null;
    mapping: {
      id: string;
      confirmed: boolean;
      matchBasis: string;
      matchTier: number | null;
      relationshipType: string | null;
      rollUpAwards: boolean | null;
      reviewStatus: 'candidate' | 'confirmed' | 'rejected' | 'superseded';
      rejectionReason: string | null;
    } | null;
  }>;
}

export const MATCH_BASIS_LABELS: Record<string, string> = {
  exact_uei: 'Exact UEI',
  exact_cage: 'Exact CAGE',
  exact_legal_name_corroborated: 'Exact legal name + corroboration',
  exact_legal_name: 'Exact legal name',
  fuzzy_name: 'Similar name only',
  manual_pin: 'Pinned by a person',
  legacy_unrecorded: 'Basis not recorded',
};

/**
 * How a match basis reads to a reviewer. A bare confidence percentage is NOT a
 * reason anybody can check, which is why the table shows this instead of leading
 * with the number.
 */
export function matchBasisLabel(basis: string | null): string {
  if (!basis) return MATCH_BASIS_LABELS.legacy_unrecorded!;
  return MATCH_BASIS_LABELS[basis] ?? basis;
}

export type MappingSource = 'lda' | 'fec_employer' | 'contracting' | 'assistance_recipient';

/**
 * The mapping-source vocabulary, in one place. Used by the manual-attach
 * picker AND by the empty state's copy, which names the source the list is
 * filtered to. Two hand-copied label lists would drift.
 */
export const MAPPING_SOURCE_OPTIONS: Array<{ label: string; value: MappingSource }> = [
  { label: 'LDA registrant (issue codes)', value: 'lda' },
  { label: 'FEC employer (contributions)', value: 'fec_employer' },
  { label: 'Federal contractor (contracts)', value: 'contracting' },
  { label: 'Assistance recipient (grants)', value: 'assistance_recipient' },
];

/** The `?source=` value as a MappingSource, or undefined when it is not one. */
export function asMappingSource(raw: string | null | undefined): MappingSource | undefined {
  return MAPPING_SOURCE_OPTIONS.find((o) => o.value === raw)?.value;
}

/**
 * Sources the backend's entity resolver never auto-confirms regardless of
 * confidence (see NEVER_AUTO_CONFIRM in apps/api's entity-resolution.service.ts),
 * PLUS sources that need a per-row relationship / roll-up decision before confirm.
 *
 * assistance_recipient's confidence is a name-similarity score across wildly
 * heterogeneous entity types (universities, counties, energy companies) where a
 * high score can still be the wrong entity — still never bulk-confirmed.
 * contracting needs an explicit relationship type + roll-up awards decision, so
 * it stays out of "Confirm All" even when a candidate is eligible.
 *
 * (Verified live 2026-07-27: $15B+ in wrong assistance_recipient suggestions sat
 * at confidence a confidence-only bulk action would have swept up — that source
 * remains blocked.)
 */
export const REQUIRES_INDIVIDUAL_REVIEW = new Set<string>([
  'assistance_recipient',
  'contracting',
]);

/**
 * The subset of sources that attribute federal award MONEY, and therefore
 * cannot be confirmed without an explicit relationship type and roll-up decision.
 * Mirrors AWARD_BEARING_MAPPING_SOURCES in apps/api's intelligence.service.ts.
 */
export const AWARD_BEARING_SOURCES = new Set<string>(['contracting', 'assistance_recipient']);

export function formatMappingSpend(v: number | null): string {
  if (v == null || v <= 0) return '—';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${Math.round(v)}`;
}

// Profile/intel react-query keys that depend on a client's mappings. Invalidated
// after any mapping change so the Intelligence tab (aggregate, snapshot, setup
// checklist, derived issue-code signal) reflects the change without a hard reload.
export const CLIENT_INTEL_QUERY_KEYS = [
  'client-intel-v1-profile',
  'client-intel-v1-aggregate',
  'intel-setup-completeness',
  'intel-issue-code-signal',
];

export function invalidateClientIntel(qc: QueryClient) {
  for (const key of CLIENT_INTEL_QUERY_KEYS) {
    void qc.invalidateQueries({ queryKey: [key] });
  }
}

export function mappingApiErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const data = (error as { response?: { data?: { message?: unknown } } }).response?.data;
    if (typeof data?.message === 'string') return data.message;
    if (Array.isArray(data?.message)) return data.message.join(', ');
  }
  return error instanceof Error ? error.message : 'Request failed';
}
