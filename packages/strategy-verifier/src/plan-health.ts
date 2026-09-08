/** Calendar-day policy shared by editor, monitoring and exports. */
export interface StrategyDueNode {
  status?: string;
  startsOn?: string | Date | null;
  endsOn?: string | Date | null;
  openEnded?: boolean;
  archivedAt?: string | Date | null;
  isArchived?: boolean;
}

/** Suggested work is not a commitment; draft work is part of the saved plan. */
export function isCommittedStrategyStep(node: StrategyDueNode): boolean {
  return node.status !== 'suggested' && !node.archivedAt && !node.isArchived;
}

function utcDay(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? Math.floor(value.getTime() / 86_400_000) * 86_400_000 : null;
  }
  // Prisma dates reach browser consumers as timezone-qualified ISO timestamps.
  // Validate the written calendar date first: Date.parse alone normalizes Feb 30.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const timestamp = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value);
  if (!dateOnly && !timestamp) return null;
  const day = value.slice(0, 10);
  const dayMs = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(dayMs) || new Date(dayMs).toISOString().slice(0, 10) !== day) return null;
  const instant = dateOnly ? dayMs : Date.parse(value);
  return Number.isFinite(instant) ? Math.floor(instant / 86_400_000) * 86_400_000 : null;
}

/** UTC due day of an unfinished commitment. Invalid dates are not counted. */
export function strategyStepDueDate(node: StrategyDueNode): number | null {
  if (!isCommittedStrategyStep(node) || node.status === 'completed' || node.openEnded) return null;
  return utcDay(node.endsOn ?? node.startsOn);
}

export function isStrategyStepOverdue(node: StrategyDueNode, asOf: Date): boolean {
  const due = strategyStepDueDate(node);
  const today = utcDay(asOf);
  return due !== null && today !== null && due < today;
}

/** A reference is coverage, not verification of its contents or authority. */
export function hasLinkedStrategyEvidence(sources: unknown): boolean {
  return Array.isArray(sources) && sources.some((source: unknown) => {
    if (!source || typeof source !== 'object') return false;
    const entry = source as Record<string, unknown>;
    if (typeof entry.section !== 'string' || !entry.section.trim()) return false;
    if (typeof entry.ref !== 'string') return false;
    const ref = entry.ref.trim();
    return /^fact:[A-Za-z0-9_-]+$/.test(ref) || /^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(ref);
  });
}

export interface StrategyHealthNode extends StrategyDueNode {
  kind?: string;
  ownerAssigned: boolean;
  hasLinkedEvidence: boolean;
}

/** The caller supplies its audience-filtered nodes and evidence. */
export function computeStrategyHealth(nodes: readonly StrategyHealthNode[], asOf: Date) {
  const live = nodes.filter((node) => !node.archivedAt && !node.isArchived);
  const totalNodes = live.length;
  const ownedNodes = live.filter((node) => node.ownerAssigned).length;
  const gates = live.filter((node) => node.kind === 'gate');
  const groundedGates = gates.filter((node) => node.hasLinkedEvidence).length;
  const datedNodes = live.filter((node) => strategyStepDueDate(node) !== null).length;
  const overdueNodes = live.filter((node) => isStrategyStepOverdue(node, asOf)).length;
  const coverage = totalNodes ? ownedNodes / totalNodes : null;
  const grounding = gates.length ? groundedGates / gates.length : null;
  const timeliness = datedNodes ? 1 - overdueNodes / datedNodes : null;
  const dimensions = [[coverage, 0.4], [grounding, 0.35], [timeliness, 0.25]] as const;
  let weighted = 0;
  let weight = 0;
  for (const [value, share] of dimensions) {
    if (value !== null) { weighted += value * share; weight += share; }
  }
  const score = weight ? Math.round(100 * weighted / weight) : 0;
  return {
    score,
    label: totalNodes === 0 ? 'No steps' as const : score >= 80 ? 'On track' as const : score >= 60 ? 'Needs attention' as const : 'At risk' as const,
    coveragePct: coverage === null ? 0 : Math.round(coverage * 100),
    groundingPct: grounding === null ? null : Math.round(grounding * 100),
    timelinessPct: timeliness === null ? null : Math.round(timeliness * 100),
    totalNodes, ownedNodes, totalGates: gates.length, groundedGates, datedNodes, overdueNodes,
  };
}
