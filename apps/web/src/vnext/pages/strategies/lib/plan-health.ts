/*
 * Plan health — interim client derivation (STRATEGIES-HANDOFF §8.7).
 *
 * The server does NOT compute a single plan-health scalar (GAP — see
 * docs/handoff/strategies-api-inventory.md and GAPS.md). Until it does, this
 * adapter implements the documented interim formula and is the ONLY place the
 * score is derived, so swapping in a server value later is a one-file change.
 *
 *   coverage   = steps with an owner / total steps
 *   grounding  = gates with all required evidence attached / total gates
 *   timeliness = 1 − (overdue steps / total dated steps)
 *   health     = round(100 × (0.4·coverage + 0.35·grounding + 0.25·timeliness))
 *
 * §8.7 hard rule: never show a health number computed from a partially loaded
 * plan. `computePlanHealth` returns null when the detail payload is absent; the
 * caller renders the loading state, never `0`.
 */
import type { StrategyDetail, StrategyNode } from '../../../../pages/strategy/types.js';

export interface PlanHealth {
  score: number; // 0–100
  totalSteps: number;
  ownedSteps: number;
  totalGates: number;
  groundedGates: number;
  datedSteps: number;
  overdueSteps: number;
}

function isGate(n: StrategyNode) {
  return n.kind === 'gate';
}

/** A gate is "grounded" when it carries at least one provenance/evidence source. */
function gateGrounded(n: StrategyNode) {
  const sources = n.provenance?.sources;
  return Array.isArray(sources) && sources.length > 0;
}

function isOverdue(n: StrategyNode, today: Date) {
  // Active means accepted/published, not completed; accepted overdue work still counts.
  if (n.openEnded || n.status === 'completed') return false;
  const due = n.endsOn ?? n.startsOn;
  if (!due) return false;
  const d = new Date(due);
  return !Number.isNaN(d.getTime()) && d.getTime() < Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
}

/**
 * Derive plan health from a fully loaded StrategyDetail. Returns null when the
 * plan is not loaded (caller renders loading). `today` is injectable so the
 * timeline's server-derived "today" can be passed in (§7.3) instead of the
 * browser clock.
 */
export function computePlanHealth(
  detail: StrategyDetail | null | undefined,
  today: Date = new Date(),
): PlanHealth | null {
  if (!detail || !Array.isArray(detail.nodes)) return null;
  const nodes = detail.nodes;
  const totalSteps = nodes.length;
  if (totalSteps === 0) {
    return {
      score: 0,
      totalSteps: 0,
      ownedSteps: 0,
      totalGates: 0,
      groundedGates: 0,
      datedSteps: 0,
      overdueSteps: 0,
    };
  }
  const ownedSteps = nodes.filter((n) => !!n.ownerUserId).length;
  const gates = nodes.filter(isGate);
  const totalGates = gates.length;
  const groundedGates = gates.filter(gateGrounded).length;
  const dated = nodes.filter((n) => !n.openEnded && !Number.isNaN(new Date(n.endsOn ?? n.startsOn).getTime()));
  const datedSteps = dated.length;
  const overdueSteps = dated.filter((n) => isOverdue(n, today)).length;

  const coverage = ownedSteps / totalSteps;
  const grounding = totalGates === 0 ? 1 : groundedGates / totalGates;
  const timeliness = datedSteps === 0 ? 1 : 1 - overdueSteps / datedSteps;
  const score = Math.round(100 * (0.4 * coverage + 0.35 * grounding + 0.25 * timeliness));

  return { score, totalSteps, ownedSteps, totalGates, groundedGates, datedSteps, overdueSteps };
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

