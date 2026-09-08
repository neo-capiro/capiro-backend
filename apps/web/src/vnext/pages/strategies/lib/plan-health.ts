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

/**
 * Lightweight plan-health proxy from a StrategyListItem's `nodeCount` — the
 * only field the list endpoint carries that bears on plan health. Returns a
 * partial summary with `totalSteps` populated and all other dimensions null
 * (unknown, not zero). The library uses this to show a "steps" indicator
 * instead of a bare "—" and to sort by plan complexity as a first-pass
 * proxy until a server-side fleet aggregate endpoint lands.
 */
export interface PlanHealthSummary {
  totalSteps: number;
  /** null = unknown (requires per-node detail from StrategyDetail) */
  ownedSteps: number | null;
  totalGates: number | null;
  groundedGates: number | null;
  datedSteps: number | null;
  overdueSteps: number | null;
  /** null = cannot compute a score without per-node detail */
  score: number | null;
}

export function planHealthFromSummary(nodeCount: number): PlanHealthSummary {
  return {
    totalSteps: nodeCount,
    ownedSteps: null,
    totalGates: null,
    groundedGates: null,
    datedSteps: null,
    overdueSteps: null,
    score: null,
  };
}

