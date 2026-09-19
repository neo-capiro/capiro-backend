import type { OpportunityCurrentEvidenceV2 } from '@capiro/shared';
export type OpportunityWorkflowStatus =
  | 'suggested'
  | 'saved'
  | 'pursuing'
  | 'dismissed'
  | 'won'
  | 'lost'
  | 'expired';

export type HumanDecision = 'pursue' | 'monitor' | 'pass';

export interface OpportunityDecision {
  decision: HumanDecision;
  reason: string | null;
  decidedAt: string;
  decidedByUserId: string;
  nextAction: string | null;
  nextActionDueAt: string | null;
}

export interface OpportunityWorkflow {
  nextAction?: string | null;
  nextActionDueAt?: string | null;
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

export const PIPELINE_STAGES = [
  'reviewing',
  'qualified',
  'pursuing',
  'submitted',
  'won',
  'lost',
  'passed',
] as const;
export type PipelineStageView = (typeof PIPELINE_STAGES)[number];

export const PIPELINE_STAGE_LABELS: Record<PipelineStageView, string> = {
  reviewing: 'Reviewing',
  qualified: 'Qualified',
  pursuing: 'Pursuing',
  submitted: 'Submitted',
  won: 'Won',
  lost: 'Lost',
  passed: 'Passed',
};

export const PIPELINE_STAGES_NEEDING_REASON: readonly PipelineStageView[] = ['lost', 'passed'];

export interface PipelineCardView {
  rowId: string;
  source: string;
  sourceRecordId: string | null;
  sourceReference?: string | null;
  title: string | null;
  stage: PipelineStageView | null;
  stageBasis: 'recorded' | 'workflow_status' | 'legacy_override' | 'unstaged';
  stageExplanation: string;
  stageReason?: string | null;
  version: number;
  allowedTransitions: PipelineStageView[];
  responseDeadline: string | null;
  keyDate?: {
    kind: 'response' | 'quote' | 'anticipated_award' | 'award' | 'closed';
    date: string | null;
    displayLabel?: string;
  } | null;
  value?: { display: string; basis: string } | null;
  flag?: { label: string; tone: string } | null;
  owner?: { userId: string; name: string | null; email: string | null } | null;
  lifecycle?: 'active' | 'forecast' | 'closed' | 'post_award' | null;
  nextAction?: string | null;
  nextActionDueAt?: string | null;
  notes?: string | null;
  stageUpdatedAt?: string | null;
  capability?: { canPursue: boolean; reason: string | null };
  currentEvidence?: OpportunityCurrentEvidenceV2 | null;
}

export interface PipelineBoardView {
  clientId: string;
  counts: {
    stages: Array<{ stage: PipelineStageView; count: number }>;
    unstaged: { suggested: number; expired: number; other: number };
    total: number;
    derivedFromWorkflowStatus: number;
  };
  cards: PipelineCardView[];
  cardsTruncated: boolean;
  hasMore?: boolean;
  summary?: {
    inPipeline: number | null;
    deadlinesInside30Days: number | null;
    unassigned: number | null;
    awaitingAward: number | null;
    lastStageChange: string | null;
  };
}

export function pipelineBoardApiPath(clientId: string): string {
  return `/api/intelligence/clients/${encodeURIComponent(clientId)}/pipeline`;
}

export function pipelineStageApiPath(clientId: string, rowId: string): string {
  return `/api/intelligence/clients/${encodeURIComponent(clientId)}/pipeline/${encodeURIComponent(rowId)}/stage`;
}

export const FUNDING_OPPORTUNITIES_FEATURE = 'funding_opportunities';
export const FUNDING_OPPORTUNITIES_PIPELINE_FEATURE = 'funding_opportunities_pipeline_v2';

export function formatSourceDate(
  value: string | null,
  placeholder = 'Not provided by the source',
): string {
  if (!value) return placeholder;
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!plain) {
    const midnight = /^(\d{4})-(\d{2})-(\d{2})T00:00:00(?:\.0+)?(?:Z|\+00:00)$/.exec(value);
    if (midnight)
      return formatSourceDate(`${midnight[1]}-${midnight[2]}-${midnight[3]}`, placeholder);
    return value;
  }
  const [, year, month, day] = plain;
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${Number(day)} ${months[Number(month) - 1] ?? month} ${year}`;
}

export const MATCH_SIGNAL_LABELS: Record<string, string> = {
  assistanceListing: 'Prior award under this Assistance Listing',
  applicantType: 'Organization type meets the applicant rule',
  agency: 'Prior award history with this agency',
  stateRestriction: 'Restricted to a state the client is in',
  fundingCategory: 'Funding category match',
  knownPartner: 'Known partner named',
  naicsExact: 'Exact NAICS match',
  pscExact: 'Exact product/service code match',
  programElement: 'Client-relevant Program Element',
  agencyHistory: 'Prior award history with this agency',
  placeOfPerformanceSite: 'Work happens at a client site',
  setAsideSelfReported: 'Set-aside the client reports qualifying for',
  naicsIndustryGroup: 'Same NAICS industry group',
  pscCategory: 'Same product/service category',
  officeHistory: 'Prior award history with this office',
  facilityState: 'Client has a site in this state',
  capabilityKeyword: 'Capability match',
  sector: 'Same sector',
  genericTopical: 'Common industry term',
  funding_priority_match: 'Funding priority match',
  exact_naics_match: 'Exact NAICS match',
  exact_psc_match: 'Exact product/service code match',
  capability_match: 'Capability match',
  prior_agency_history: 'Prior award history with this agency',
  program_element_linked_source_backed: 'Client-relevant Program Element',
  location_match: 'Client location match',
  known_vehicle_access: 'Recorded vehicle access',
  reviewed_strategic_priority: 'Reviewed strategic priority',
};

export function signalLabel(signal: string, source?: 'capability' | 'funding_priority'): string {
  if (signal === 'capabilityKeyword' && source === 'funding_priority')
    return 'Funding priority match';
  return MATCH_SIGNAL_LABELS[signal] ?? 'Unrecognized match signal';
}

export function isFitSignal(signal: { signal: string; weight?: number }): boolean {
  return (
    signal.signal !== 'applicantType' &&
    signal.signal !== 'stateRestriction' &&
    (signal.weight == null || signal.weight > 0)
  );
}
