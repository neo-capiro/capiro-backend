/**
 * Mirrors apps/api/src/funding-opportunities/funding-opportunities.types.ts.
 *
 * Hand-mirrored per the repo's dominant convention (see
 * district-nexus-api.ts's own note): `packages/shared` is reserved for constants
 * both sides genuinely need at RUNTIME, not for type mirroring.
 *
 * The three rules the API side enforces, restated because the UI is where they
 * become visible or get broken:
 *
 *   1. NO blended dollar total. Grants and contracts are counted separately and
 *      labelled separately.
 *   2. NULL money renders as `—` or `Not stated`, never `$0`.
 *   3. Relevance and eligibility are shown as two different things.
 */

export type OpportunitySource = 'grants_gov' | 'sam_gov';

export type OpportunityKind =
  | 'grant'
  | 'cooperative_agreement'
  | 'sources_sought'
  | 'presolicitation'
  | 'solicitation'
  | 'combined_synopsis_solicitation'
  | 'special_notice'
  | 'amendment'
  | 'award_notice'
  | 'other';

export type OpportunityWorkflowStatus =
  | 'suggested'
  | 'saved'
  | 'pursuing'
  | 'dismissed'
  | 'won'
  | 'lost'
  | 'expired';

export type EligibilityState = 'eligible' | 'ineligible' | 'needs_review' | 'unknown';

export type Money = number | null;

export interface OpportunitySourceFreshness {
  source: OpportunitySource;
  verb: string;
  label: string;
  lastSyncedAt: string | null;
  neverSynced: boolean;
  lastRunDegraded: boolean;
  recordCount: number;
  activeRecordCount: number;
}

export interface OpportunityMatchedSignal {
  signal: string;
  strength: 'strong' | 'moderate' | 'weak';
  weight: number;
  matchedOn: string;
}

export interface MissingProfileField {
  field: string;
  label: string;
  impact: string;
  href: string | null;
}

export interface GrantFunding {
  estimatedProgramFunding: Money;
  awardFloor: Money;
  awardCeiling: Money;
  expectedAwardCount: number | null;
  costSharingRequired: boolean | null;
}

export interface ContractValue {
  estimatedValue: Money;
  basis: 'not_stated_by_source' | 'source_backed';
}

export interface OpportunityWorkflow {
  id: string;
  status: OpportunityWorkflowStatus;
  owner: { userId: string; name: string | null; email: string | null } | null;
  facility: { id: string; name: string; state: string | null; districtKey: string | null } | null;
  notes: string | null;
  dismissedReason: string | null;
  outcomeNote: string | null;
  userCreated: boolean;
  staleAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FundingOpportunity {
  id: string;
  source: OpportunitySource;
  sourceRecordId: string;
  sourceReference: string | null;
  sourceUrl: string | null;
  kind: OpportunityKind;
  kindRaw: string | null;
  baseKind: OpportunityKind | null;
  title: string;
  agency: string | null;
  subAgency: string | null;
  office: string | null;
  status: string | null;
  postedDate: string | null;
  responseDeadline: string | null;
  responseDeadlineNote: string | null;
  closeOrArchiveDate: string | null;
  isActive: boolean;
  isPursuable: boolean;
  summary: string | null;
  summaryIsLink: boolean;
  naicsCodes: string[];
  pscCodes: string[];
  setAside: string | null;
  setAsideCode: string | null;
  eligibleApplicantTypes: string[];
  assistanceListings: string[];
  fundingInstrument: string | null;
  category: string | null;
  grantFunding: GrantFunding | null;
  contractValue: ContractValue | null;
  placeOfPerformance: {
    city: string | null;
    state: string | null;
    zip: string | null;
    country: string | null;
  } | null;
  districtKey: string | null;
  districtBasis: 'source_place_of_performance' | 'linked_project_site' | null;
  relevanceScore: number;
  eligibility: { state: EligibilityState; reason: string };
  matchedSignals: OpportunityMatchedSignal[];
  missingProfileFields: MissingProfileField[];
  sourceUpdatedAt: string | null;
  workflow: OpportunityWorkflow | null;
  clientId: string | null;
}

export type EmptyReason =
  | 'no_source_records'
  | 'source_never_synced'
  | 'client_profile_too_thin'
  | 'no_match_above_threshold'
  | 'no_saved_opportunities'
  | 'no_results_for_filters';

export interface FundingOpportunityCounts {
  activeGrants: number;
  activeContracts: number;
  saved: number;
  pursuing: number;
  dismissed: number;
  deadlinesIn30Days: number;
}

export interface FundingOpportunityListResponse {
  opportunities: FundingOpportunity[];
  total: number;
  totalIsCapped: boolean;
  page: number;
  pageSize: number;
  counts: FundingOpportunityCounts;
  freshness: OpportunitySourceFreshness[];
  emptyReason: EmptyReason | null;
  emptyExplanation: string | null;
  missingProfileFields: MissingProfileField[];
  generatedAt: string;
}

export interface ClientFundingOpportunitySummary {
  clientId: string;
  counts: FundingOpportunityCounts;
  nextDeadline: {
    opportunityId: string;
    title: string;
    source: OpportunitySource;
    responseDeadline: string;
  } | null;
  topGrants: FundingOpportunity[];
  topContracts: FundingOpportunity[];
  missingProfileFields: MissingProfileField[];
  freshness: OpportunitySourceFreshness[];
  emptyReason: EmptyReason | null;
  emptyExplanation: string | null;
  generatedAt: string;
}

// ── Display helpers ─────────────────────────────────────────────────────────

/** The intel-api flag key gating the whole surface. Byte-matches the API guard. */
export const FUNDING_OPPORTUNITIES_FEATURE = 'funding_opportunities';

export const KIND_LABELS: Record<OpportunityKind, string> = {
  grant: 'Grant',
  cooperative_agreement: 'Cooperative agreement',
  sources_sought: 'Sources sought',
  presolicitation: 'Presolicitation',
  solicitation: 'Solicitation',
  combined_synopsis_solicitation: 'Combined synopsis / solicitation',
  special_notice: 'Special notice',
  amendment: 'Amendment',
  award_notice: 'Award notice',
  other: 'Other',
};

export const SOURCE_LABELS: Record<OpportunitySource, string> = {
  grants_gov: 'Grants.gov',
  sam_gov: 'SAM.gov',
};

export const ELIGIBILITY_LABELS: Record<EligibilityState, string> = {
  eligible: 'Eligible',
  ineligible: 'Not eligible',
  needs_review: 'Needs review',
  unknown: 'Unknown',
};

export const WORKFLOW_LABELS: Record<OpportunityWorkflowStatus, string> = {
  suggested: 'Suggested',
  saved: 'Saved',
  pursuing: 'Pursuing',
  dismissed: 'Dismissed',
  won: 'Won',
  lost: 'Lost',
  expired: 'Expired',
};

/**
 * Money for display. THE central honesty rule of this surface, in one function.
 *
 * `null` is "we hold no figure" and renders as the caller's placeholder — never
 * `$0`, which states a fact the source never stated. `0` is a real zero and IS
 * rendered as `$0`, because a source that says zero is different from a source
 * that says nothing.
 */
export function formatMoney(value: Money, placeholder = '—'): string {
  if (value == null) return placeholder;
  if (!Number.isFinite(value)) return placeholder;
  if (Math.abs(value) >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${Math.round(value)}`;
}

/** Deadline text. A note ("Continuous") replaces a missing date rather than hiding it. */
export function formatDeadline(
  responseDeadline: string | null,
  note: string | null,
): { text: string; daysRemaining: number | null } {
  if (!responseDeadline) {
    return { text: note?.trim() ? note.trim() : 'No deadline stated', daysRemaining: null };
  }
  const t = Date.parse(responseDeadline);
  if (!Number.isFinite(t)) return { text: 'No deadline stated', daysRemaining: null };
  const days = Math.ceil((t - Date.now()) / 86_400_000);
  const text = new Date(t).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  return { text, daysRemaining: days };
}

/** "Grants.gov current to 28 Jul" / an explicit never-synced statement. */
export function formatFreshness(f: OpportunitySourceFreshness): string {
  if (f.neverSynced) return `${f.label}: never synced`;
  if (!f.lastSyncedAt) return `${f.label}: freshness unknown`;
  const when = new Date(f.lastSyncedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return `${f.label}: current to ${when}${f.lastRunDegraded ? ' (last run had errors)' : ''}`;
}

/**
 * The money line for one opportunity, source-appropriate.
 *
 * Grants and contracts get DIFFERENT labels because they are different kinds of
 * number: a grant ceiling is the most any single award will be, and a SAM notice
 * usually states no value at all. There is deliberately no code path that adds
 * them together.
 */
export function moneyLine(o: FundingOpportunity): { label: string; value: string } {
  if (o.source === 'grants_gov' && o.grantFunding) {
    const g = o.grantFunding;
    if (g.awardCeiling != null) {
      return { label: 'Award ceiling', value: formatMoney(g.awardCeiling) };
    }
    if (g.estimatedProgramFunding != null) {
      return { label: 'Program funding', value: formatMoney(g.estimatedProgramFunding) };
    }
    return { label: 'Award ceiling', value: 'Not stated' };
  }
  if (o.source === 'sam_gov') {
    // Always "Not stated" today, and that is a fact about SAM.gov rather than a
    // gap in this UI — see ContractValue in the API types.
    return { label: 'Contract value', value: formatMoney(o.contractValue?.estimatedValue ?? null, 'Not stated') };
  }
  return { label: 'Value', value: 'Not stated' };
}
