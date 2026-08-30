import type { ReportHealth, ReportNode } from "./report.types.js";

/**
 * Server-side implementation of the planner's documented deterministic health
 * formula. `asOf` is injected so snapshot generation and unit tests never
 * depend on a renderer/browser clock.
 */
export function computeReportHealth(
  nodes: readonly ReportNode[],
  asOf: Date,
): ReportHealth {
  const totalNodes = nodes.length;
  if (totalNodes === 0) {
    return {
      score: 0,
      label: "At risk",
      coveragePct: 0,
      groundingPct: 100,
      timelinessPct: 100,
      totalNodes: 0,
      ownedNodes: 0,
      totalGates: 0,
      groundedGates: 0,
      overdueNodes: 0,
    };
  }

  const ownedNodes = nodes.filter((node) => node.ownerAssigned).length;
  const gates = nodes.filter((node) => node.kind === "gate");
  const groundedGates = gates.filter((node) => node.sources.length > 0).length;
  const datedNodes = nodes.filter((node) =>
    Boolean(node.endsOn ?? node.startsOn),
  );
  const overdueNodes = datedNodes.filter((node) =>
    isOverdue(node, asOf),
  ).length;

  const coverage = ownedNodes / totalNodes;
  const grounding = gates.length === 0 ? 1 : groundedGates / gates.length;
  const timeliness =
    datedNodes.length === 0 ? 1 : 1 - overdueNodes / datedNodes.length;
  const score = Math.round(
    100 * (0.4 * coverage + 0.35 * grounding + 0.25 * timeliness),
  );

  return {
    score,
    label:
      score >= 80 ? "On track" : score >= 60 ? "Needs attention" : "At risk",
    coveragePct: Math.round(coverage * 100),
    groundingPct: Math.round(grounding * 100),
    timelinessPct: Math.round(timeliness * 100),
    totalNodes,
    ownedNodes,
    totalGates: gates.length,
    groundedGates,
    overdueNodes,
  };
}

function isOverdue(node: ReportNode, asOf: Date): boolean {
  // `active` means accepted/published in the strategy workflow, not complete.
  // The node model has no terminal completion status, so any closed-ended plan
  // step past its due date is overdue regardless of workflow status.
  if (node.openEnded) return false;
  const due = node.endsOn ?? node.startsOn;
  const dueMs = Date.parse(`${due}T00:00:00.000Z`);
  return Number.isFinite(dueMs) && dueMs < asOf.getTime();
}
