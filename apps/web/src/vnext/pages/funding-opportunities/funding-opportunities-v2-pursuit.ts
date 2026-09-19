import {
  getFundingOpportunityDeadlinePresentation,
  type FundingOpportunityV2DeadlinePresentation,
} from './funding-opportunities-v2-detail-types.js';
import { getFundingOpportunityMatchPresentation } from './funding-opportunities-v2-detail-types.js';
import {
  PIPELINE_STAGE_LABELS,
  PIPELINE_STAGES,
  type PipelineBoardView,
  type PipelineCardView,
  type PipelineStageView,
} from './funding-opportunities-domain.js';

export const PURSUIT_STAGE_ORDER = PIPELINE_STAGES;
export const PURSUIT_STAGE_LABELS = PIPELINE_STAGE_LABELS;

export const SOURCE_LABELS: Record<string, string> = {
  grants_gov: 'Grants.gov',
  sam_gov: 'SAM.gov',
  agency_forecast: 'Forecast',
  dibbs: 'DLA bid board',
  sbir_sttr: 'SBIR / STTR',
  ca_portal: 'California Grants Portal',
};

export const TERMINAL_SENTENCES: Record<PipelineStageView, string> = {
  reviewing: '',
  qualified: '',
  pursuing: '',
  submitted: '',
  won: 'Nothing moves out of Won.',
  lost: 'Lost is terminal. Reinstating the record is a separate, audited action.',
  passed: 'Passed is terminal. The record stays discoverable in the catalog.',
};

/** The four operator-facing reasons shared by pursuit and the main not-fit flow. */
export const PURSUIT_REASONS = [
  {
    key: 'capability',
    label: 'Outside client capability',
    description: 'The scope is not work this client performs.',
  },
  {
    key: 'eligibility',
    label: 'Client is not eligible',
    description: 'Applicant type, set-aside or registration blocks a response.',
  },
  {
    key: 'economics',
    label: 'Economics do not work',
    description: 'Value, cost share or period of performance rules it out.',
  },
  {
    key: 'capacity',
    label: 'No capacity this cycle',
    description: 'A fit, but the client cannot resource a response now.',
  },
] as const;

export interface PursuitSummary {
  inPipeline: number | null;
  deadlinesInside30Days: number | null;
  unassigned: number | null;
  awaitingAward: number | null;
  lastStageChange: string | null;
}

export interface PursuitCardView extends PipelineCardView {
  deadline: FundingOpportunityV2DeadlinePresentation;
}

export function stageCards(board: PipelineBoardView, stage: PipelineStageView): PipelineCardView[] {
  return board.cards.filter((card) => card.stage === stage);
}

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source.replaceAll('_', ' ');
}

export function deadlineForCard(
  card: PipelineCardView,
  now = new Date(),
): FundingOpportunityV2DeadlinePresentation {
  const keyDate = card.keyDate;
  const presentation = getFundingOpportunityDeadlinePresentation({
    // Once a typed key date exists, it is authoritative. In particular, a raw
    // source period with no calendar date must not inherit an older response
    // deadline and manufacture urgency.
    deadline: keyDate ? keyDate.date : card.responseDeadline,
    lifecycle: card.lifecycle === 'post_award' ? 'closed' : (card.lifecycle ?? 'active'),
    workflowStatus: card.stage,
    now,
  });
  if (!keyDate) return presentation;
  const isResponseCountdown = keyDate.kind === 'response' || keyDate.kind === 'quote';
  const labels = {
    response: 'Closes',
    quote: 'Quote',
    anticipated_award: 'Award expected',
    award: 'Awarded',
    closed: 'Closed',
  } as const;
  const descriptorOnly = new Set([
    'Response deadline',
    'Quote deadline',
    'Closed',
    'Anticipated award',
  ]);
  const value = keyDate.date
    ? presentation.value
    : keyDate.displayLabel && !descriptorOnly.has(keyDate.displayLabel)
      ? keyDate.displayLabel
      : presentation.value;
  return {
    ...presentation,
    label: labels[keyDate.kind],
    // Known dates use the canonical helper's formatted value. A source period
    // is retained only when there is no calendar date; descriptive placeholders
    // are not dates and must remain a truthful missing-date presentation.
    value,
    compactValue: keyDate.date ? presentation.compactValue : undefined,
    daysRemaining: keyDate.date && isResponseCountdown ? presentation.daysRemaining : null,
    tone: keyDate.date ? presentation.tone : 'plain',
    note: presentation.note ?? undefined,
  };
}

export function computePursuitSummary(
  cards: readonly PipelineCardView[],
  now = new Date(),
): PursuitSummary {
  const records = cards.filter((card) => card.stage != null);
  const deadlinesInside30Days = records.filter((card) => {
    if (card.keyDate && card.keyDate.kind !== 'response' && card.keyDate.kind !== 'quote')
      return false;
    const deadline = deadlineForCard(card, now);
    return (
      deadline.daysRemaining != null && deadline.daysRemaining >= 0 && deadline.daysRemaining <= 30
    );
  }).length;
  const changes = records
    .map((card) => card.stageUpdatedAt ?? null)
    .filter((value): value is string => value != null)
    .sort();
  return {
    inPipeline: records.length,
    deadlinesInside30Days,
    unassigned: records.filter((card) => card.owner == null).length,
    awaitingAward: records.filter((card) => card.stage === 'submitted').length,
    lastStageChange: changes.at(-1) ?? null,
  };
}

export function boardSummary(board: PipelineBoardView, now = new Date()): PursuitSummary {
  if (board.summary) return board.summary;
  if (board.cardsTruncated || board.hasMore) {
    return {
      inPipeline: board.counts.stages.reduce((total, stage) => total + stage.count, 0),
      deadlinesInside30Days: null,
      unassigned: null,
      awaitingAward: null,
      lastStageChange: null,
    };
  }
  return computePursuitSummary(board.cards, now);
}

export function displayCount(value: number | null | undefined): string {
  return value == null ? '?' : String(value);
}

export function displayDate(value: string | null | undefined): string {
  if (!value) return 'Not provided by source';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not provided by source';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function lastStageChangeText(value: string | null): string {
  return value ? displayDate(value) : 'Not recorded';
}

export function listBasis(card: PipelineCardView): string {
  const evidence = card.currentEvidence;
  if (card.stage === 'won') {
    const value = card.value;
    const isAwardAmount =
      value?.basis === 'awarded_amount' || value?.basis === 'source_awarded_amount';
    return isAwardAmount && value.display.trim()
      ? value.display
      : 'Award amount not provided by source';
  }
  if (card.stage === 'lost' || card.stage === 'passed') {
    return card.stageReason?.trim() || 'Reason not provided by source';
  }
  if (card.stage === 'submitted') {
    if (card.stageUpdatedAt)
      return `Submitted ${displayDate(card.stageUpdatedAt)} · awaiting award`;
    const submittedLabel = card.stageExplanation?.trim();
    return submittedLabel?.toLowerCase().startsWith('submitted ')
      ? `${submittedLabel} · awaiting award`
      : submittedLabel || 'Awaiting award';
  }
  if (evidence?.eligibility?.state === 'ineligible') {
    return evidence.eligibility.reason || 'Eligibility gap';
  }
  if (evidence?.matchedSignals?.length) {
    const match = getFundingOpportunityMatchPresentation(evidence.matchedSignals);
    return match.label
      ? `${match.label}${evidence.relevanceScore != null ? ` · relevance ${evidence.relevanceScore}` : ''}`
      : match.reason;
  }
  return (
    evidence?.eligibility?.reason ||
    card.stageExplanation ||
    'Match evidence not provided by source'
  );
}

export function cardKey(card: PipelineCardView): string {
  return card.rowId;
}

export function sourceTone(source: string): string {
  if (source === 'grants_gov') return 'purple';
  if (source === 'sam_gov' || source === 'dibbs') return 'cyan';
  if (source === 'agency_forecast') return 'warning';
  if (source === 'sbir_sttr' || source === 'ca_portal') return 'indigo';
  return 'plain';
}
