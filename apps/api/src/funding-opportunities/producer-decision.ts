import type { OpportunityWorkflowStatus } from './funding-opportunities.types.js';

export type ProducerAction =
  | { action: 'create'; relevanceScore: number }
  | { action: 'refresh'; id: string; relevanceScore: number }
  | { action: 'mark_stale'; id: string }
  | { action: 'skip_human_decision'; id: string }
  | { action: 'skip_below_floor' }
  | { action: 'noop' };

export const HUMAN_DECISION_STATUSES: ReadonlySet<OpportunityWorkflowStatus> = new Set([
  'saved',
  'pursuing',
  'dismissed',
  'won',
  'lost',
]);

export function decideProducerAction(params: {
  existing: {
    id: string;
    workflowStatus: string;
    userCreated: boolean;
    evidenceSourceType: string;
    staleAt: Date | null;
  } | null;
  relevanceScore: number;
  meetsSuggestionFloor: boolean;
  minRelevance: number;
}): ProducerAction {
  const { existing, relevanceScore, meetsSuggestionFloor, minRelevance } = params;
  const qualifies = meetsSuggestionFloor && relevanceScore >= minRelevance;

  if (existing) {
    if (
      existing.userCreated ||
      HUMAN_DECISION_STATUSES.has(existing.workflowStatus as OpportunityWorkflowStatus)
    ) {
      return { action: 'skip_human_decision', id: existing.id };
    }
    if (qualifies) return { action: 'refresh', id: existing.id, relevanceScore };
    if (existing.staleAt != null) return { action: 'noop' };
    return { action: 'mark_stale', id: existing.id };
  }

  return qualifies ? { action: 'create', relevanceScore } : { action: 'skip_below_floor' };
}
