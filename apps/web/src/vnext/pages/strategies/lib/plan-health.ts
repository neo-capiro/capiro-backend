/** Shared policy; null detail means loading, never a fabricated health score. */
import { computeStrategyHealth, hasLinkedStrategyEvidence } from '@capiro/strategy-verifier';
import type { StrategyDetail } from '../../../../pages/strategy/types.js';

export interface PlanHealth {
  score: number;
  totalSteps: number;
  ownedSteps: number;
  totalGates: number;
  groundedGates: number;
  datedSteps: number;
  overdueSteps: number;
  groundingPct: number | null;
  timelinessPct: number | null;
}

export function computePlanHealth(
  detail: StrategyDetail | null | undefined,
  today: Date = new Date(),
): PlanHealth | null {
  if (!detail || !Array.isArray(detail.nodes)) return null;
  const health = computeStrategyHealth(detail.nodes.map((node) => ({
    ...node,
    ownerAssigned: Boolean(node.ownerUserId),
    hasLinkedEvidence: hasLinkedStrategyEvidence(node.provenance?.sources),
  })), today);
  return {
    score: health.score, totalSteps: health.totalNodes, ownedSteps: health.ownedNodes,
    totalGates: health.totalGates, groundedGates: health.groundedGates,
    datedSteps: health.datedNodes, overdueSteps: health.overdueNodes,
    groundingPct: health.groundingPct, timelinessPct: health.timelinessPct,
  };
}

