import type { ExecutiveReportSnapshot, ReportNode } from "./report.types.js";

export interface RoadmapGroup {
  label:
    | "Overdue / needs attention"
    | "Now & next 30 days"
    | "31–60 days"
    | "61–90 days"
    | "Later";
  nodes: ReportNode[];
}

export function executiveSummary(snapshot: ExecutiveReportSnapshot): string[] {
  const lines: string[] = [];
  const summary = compact(snapshot.strategy.summary);
  const goal = compact(snapshot.strategy.goal);
  if (summary) lines.push(clip(summary, 700));
  if (goal && goal !== summary) lines.push(`Objective: ${clip(goal, 600)}`);
  if (lines.length === 0) {
    lines.push(
      `This report summarizes the current ${strategyTypeLabel(snapshot.strategy.type).toLowerCase()} plan for ${snapshot.client.name}.`,
    );
  }
  return lines;
}

export function criticalNodes(
  snapshot: ExecutiveReportSnapshot,
  limit = 8,
): ReportNode[] {
  const asOf = Date.parse(`${snapshot.asOf}T00:00:00.000Z`);
  return [...snapshot.nodes]
    .sort((a, b) => {
      const aPriority = priority(a, asOf);
      const bPriority = priority(b, asOf);
      return (
        aPriority - bPriority ||
        dueMs(a) - dueMs(b) ||
        a.title.localeCompare(b.title)
      );
    })
    .slice(0, limit);
}

export function decisionsAndRisks(
  snapshot: ExecutiveReportSnapshot,
): ReportNode[] {
  return snapshot.nodes.filter(
    (node) => node.kind === "decision" || node.kind === "risk",
  );
}

export function roadmap(snapshot: ExecutiveReportSnapshot): RoadmapGroup[] {
  const asOf = Date.parse(`${snapshot.asOf}T00:00:00.000Z`);
  const groups: RoadmapGroup[] = [
    { label: "Overdue / needs attention", nodes: [] },
    { label: "Now & next 30 days", nodes: [] },
    { label: "31–60 days", nodes: [] },
    { label: "61–90 days", nodes: [] },
    { label: "Later", nodes: [] },
  ];
  for (const node of snapshot.nodes) {
    const diffDays = Math.floor(
      (Date.parse(`${node.startsOn}T00:00:00.000Z`) - asOf) / 86_400_000,
    );
    const overdue =
      !node.openEnded &&
      Date.parse(`${node.endsOn ?? node.startsOn}T00:00:00.000Z`) < asOf;
    const index = overdue
      ? 0
      : diffDays <= 30
        ? 1
        : diffDays <= 60
          ? 2
          : diffDays <= 90
            ? 3
            : 4;
    groups[index]!.nodes.push(node);
  }
  return groups;
}

export function nodeDetail(
  snapshot: ExecutiveReportSnapshot,
  node: ReportNode,
): string {
  const parts = [
    `${kindLabel(node.kind)} · ${statusLabel(node.status)}`,
    `Owner: ${node.ownerName}`,
    `Timing: ${dateRange(node)}`,
  ];
  if (node.targetLabel) parts.push(`Target: ${clip(node.targetLabel, 100)}`);
  if (snapshot.options.includeInternalNotes && node.note?.trim()) {
    parts.push(`Internal note: ${clip(compact(node.note)!, 500)}`);
  }
  return parts.join(" | ");
}

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    draft: "Draft",
    in_progress: "In progress",
    internal_review: "Internal review",
    active: "Active",
    suggested: "Suggested",
  };
  return labels[status] ?? titleCase(status);
}

export function kindLabel(kind: string): string {
  return titleCase(kind);
}

export function strategyTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    appropriations: "Appropriations",
    authorization: "Authorization",
    regulatory: "Regulatory / policy",
    coalition: "Coalition / positioning",
    procurement: "Contract / procurement",
    earmark: "Grant / earmark",
  };
  return labels[type] ?? titleCase(type);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "Not set";
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

export function dateRange(node: ReportNode): string {
  if (node.openEnded) return `${formatDate(node.startsOn)} – Ongoing`;
  if (!node.endsOn || node.endsOn === node.startsOn)
    return formatDate(node.startsOn);
  return `${formatDate(node.startsOn)} – ${formatDate(node.endsOn)}`;
}

export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function compact(value: string | null | undefined): string | null {
  const compacted = value?.replace(/\s+/g, " ").trim();
  return compacted || null;
}

function priority(node: ReportNode, asOf: number): number {
  const overdue = !node.openEnded && dueMs(node) < asOf;
  if (overdue) return 0;
  if (node.kind === "risk") return 1;
  if (node.kind === "decision") return 2;
  if (node.kind === "gate") return 3;
  if (node.kind === "milestone") return 4;
  return 5;
}

function dueMs(node: ReportNode): number {
  const parsed = Date.parse(`${node.endsOn ?? node.startsOn}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
