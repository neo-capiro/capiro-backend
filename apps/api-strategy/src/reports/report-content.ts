import { isCommittedStrategyStep, isStrategyStepOverdue, strategyStepDueDate } from '@capiro/strategy-verifier';
import type {
  ExecutiveReportSnapshot,
  ReportNarrativeItem,
  ReportNarrativeSectionKey,
  ReportNode,
  ReportSectionReadiness,
} from "./report.types.js";

export interface RoadmapGroup {
  label:
    | "Overdue / needs attention"
    | "Now & next 30 days"
    | "31–60 days"
    | "61–90 days"
    | "Later"
    | "Completed"
    | "Suggested / awaiting acceptance";
  nodes: ReportNode[];
}

export interface ReportFocusArea {
  title: string;
  description: string;
  nodes: ReportNode[];
}

export interface LeadershipAgendaItem {
  title: string;
  detail: string;
  tone: "decision" | "risk" | "delivery" | "evidence" | "ownership";
}

export function executiveSummary(snapshot: ExecutiveReportSnapshot): string[] {
  const lines: string[] = [];
  const summary = compact(snapshot.strategy.summary);
  const goal = compact(snapshot.strategy.goal);
  if (summary) lines.push(clip(summary, 700));
  if (goal && goal !== summary) lines.push(`Objective: ${clip(goal, 600)}`);
  for (const item of contextItems(snapshot, ["situation", "outcomes"]).slice(
    0,
    summary ? 1 : 2,
  )) {
    if (!lines.some((line) => comparable(line).includes(comparable(item.text))))
      lines.push(clip(item.text, 700));
  }
  if (lines.length === 0) {
    lines.push(
      `This report summarizes the current ${strategyTypeLabel(snapshot.strategy.type).toLowerCase()} plan for ${snapshot.client.name}.`,
    );
  }
  return lines;
}

export function contextItems(
  snapshot: ExecutiveReportSnapshot,
  keys?: readonly ReportNarrativeSectionKey[],
): ReportNarrativeItem[] {
  return snapshot.context.sections
    .filter((section) => !keys || keys.includes(section.key))
    .flatMap((section) => section.items);
}

export function focusAreas(
  snapshot: ExecutiveReportSnapshot,
): ReportFocusArea[] {
  const definitions: Array<{
    title: string;
    description: string;
    subjects: string[];
  }> = [
    {
      title: "Evidence and deliverables",
      description:
        "Products, submissions, and proof points that move the plan.",
      subjects: ["deliverable", "submission"],
    },
    {
      title: "Stakeholder engagement",
      description:
        "Member, committee, and agency engagement around the outcome.",
      subjects: ["member", "committee", "agency"],
    },
    {
      title: "Decision path and outcomes",
      description: "Asks, choices, gates, and outcome milestones.",
      subjects: ["ask", "outcome"],
    },
    {
      title: "Positioning and communications",
      description: "Narrative, optics, and coalition positioning.",
      subjects: ["optics"],
    },
  ];
  return definitions.flatMap((definition) => {
    const nodes = snapshot.nodes.filter((node) =>
      definition.subjects.includes(node.subject),
    );
    return nodes.length ? [{ ...definition, nodes }] : [];
  });
}

export function leadershipAgenda(
  snapshot: ExecutiveReportSnapshot,
  limit = 6,
): LeadershipAgendaItem[] {
  const agenda: LeadershipAgendaItem[] = [];
  const asOf = Date.parse(`${snapshot.asOf}T00:00:00.000Z`);
  const ordered = criticalNodes(snapshot, snapshot.nodes.length).filter((node) => isCommittedStrategyStep(node) && node.status !== "completed");

  for (const node of ordered.filter(
    (candidate) => candidate.kind === "decision",
  )) {
    agenda.push({
      title: `Decide: ${node.title}`,
      detail: `${node.ownerName} · ${dateRange(node)}`,
      tone: "decision",
    });
  }
  for (const node of ordered.filter((candidate) => candidate.kind === "risk")) {
    agenda.push({
      title: `Confirm response: ${node.title}`,
      detail: `${node.ownerName} · ${dateRange(node)}`,
      tone: "risk",
    });
  }
  for (const node of ordered.filter(
    (candidate) => isStrategyStepOverdue(candidate, new Date(asOf)),
  )) {
    agenda.push({
      title: `Recover or rebaseline: ${node.title}`,
      detail: `${node.ownerName} · due ${formatDate(node.endsOn ?? node.startsOn)}`,
      tone: "delivery",
    });
  }
  for (const node of ordered.filter((candidate) => !candidate.ownerAssigned)) {
    agenda.push({
      title: `Assign an owner: ${node.title}`,
      detail: `${kindLabel(node.kind)} · ${dateRange(node)}`,
      tone: "ownership",
    });
  }
  for (const node of ordered.filter(
    (candidate) => candidate.kind === "gate" && candidate.sources.length === 0,
  )) {
    agenda.push({
      title: `Ground the gate: ${node.title}`,
      detail: "Attach an approved source before the decision point.",
      tone: "evidence",
    });
  }
  if (agenda.length === 0) {
    for (const node of ordered.slice(0, 3)) {
      agenda.push({
        title: `Advance: ${node.title}`,
        detail: `${node.ownerName} · ${dateRange(node)}`,
        tone: "delivery",
      });
    }
  }
  const unique = agenda.filter(
    (item, index) =>
      agenda.findIndex(
        (candidate) => comparable(candidate.title) === comparable(item.title),
      ) === index,
  );
  return unique.slice(0, limit);
}

export function evidenceItems(snapshot: ExecutiveReportSnapshot): Array<{
  text: string;
  source: string;
  asOf: string | null;
  confidence: number | null;
  authority: string | null;
}> {
  const facts = snapshot.context.facts.map((fact) => ({
    text: fact.text,
    source: fact.documentTitle,
    asOf: fact.asOf,
    confidence: fact.confidence,
    authority: fact.authority,
  }));
  const highlights = contextItems(snapshot, ["evidence"]).map((item) => ({
    text: item.text,
    source: item.sourceTitle,
    asOf: item.asOf,
    confidence: item.confidence,
    authority: item.authority,
  }));
  return [...facts, ...highlights].filter(
    (item, index, all) =>
      all.findIndex(
        (candidate) => comparable(candidate.text) === comparable(item.text),
      ) === index,
  );
}

export function reportSectionReadiness(
  snapshot: ExecutiveReportSnapshot,
): ReportSectionReadiness[] {
  const narrativeCount = contextItems(snapshot).length;
  const decisionRiskCount = decisionsAndRisks(snapshot).length;
  const accountableCount = snapshot.nodes.filter(
    (node) => node.ownerAssigned || node.targetLabel,
  ).length;
  const evidenceCount =
    evidenceItems(snapshot).length +
    snapshot.nodes.filter((node) => node.sources.length > 0).length +
    snapshot.artifacts.length;
  const state = (count: number, thinAt = 2) =>
    count === 0
      ? ("empty" as const)
      : count < thinAt
        ? ("thin" as const)
        : ("ready" as const);
  return [
    {
      id: "summary",
      label: "Executive summary",
      state: snapshot.strategy.goal || narrativeCount ? "ready" : "empty",
      availableCount: Number(Boolean(snapshot.strategy.goal)) + narrativeCount,
      message:
        snapshot.strategy.goal || narrativeCount
          ? "Objective and approved narrative are available."
          : "Add a strategy goal or approved strategy brief.",
    },
    {
      id: "context",
      label: "Strategic context",
      state: state(narrativeCount, 3),
      availableCount: narrativeCount,
      message:
        narrativeCount > 0
          ? `${narrativeCount} approved context item${narrativeCount === 1 ? "" : "s"} available.`
          : "No audience-safe context narrative is available.",
    },
    {
      id: "priorities",
      label: "Leadership priorities",
      state: state(snapshot.nodes.length, 3),
      availableCount: snapshot.nodes.length,
      message: `${snapshot.nodes.length} plan step${snapshot.nodes.length === 1 ? "" : "s"} will be represented.`,
    },
    {
      id: "decisions_risks",
      label: "Decisions and risks",
      state: state(decisionRiskCount, 2),
      availableCount: decisionRiskCount,
      message:
        decisionRiskCount > 0
          ? `${decisionRiskCount} decision and risk item${decisionRiskCount === 1 ? "" : "s"} available.`
          : "No decision or risk steps are recorded.",
    },
    {
      id: "roadmap",
      label: "Roadmap",
      state: snapshot.options.includeRoadmap
        ? state(snapshot.nodes.length, 3)
        : "excluded",
      availableCount: snapshot.nodes.length,
      message: snapshot.options.includeRoadmap
        ? "All included plan steps will appear in the detailed roadmap or action register."
        : "Excluded by export settings.",
    },
    {
      id: "accountability",
      label: "Accountability",
      state: state(accountableCount, Math.min(3, snapshot.nodes.length)),
      availableCount: accountableCount,
      message: `${accountableCount} of ${snapshot.nodes.length} included steps have an owner or stakeholder target.`,
    },
    {
      id: "evidence",
      label: "Evidence and sources",
      state: snapshot.options.includeEvidenceAppendix
        ? state(evidenceCount, 2)
        : "excluded",
      availableCount: evidenceCount,
      message: snapshot.options.includeEvidenceAppendix
        ? evidenceCount > 0
          ? `${evidenceCount} evidence, source, or output item${evidenceCount === 1 ? "" : "s"} available.`
          : "No evidence or connected outputs are available."
        : "Excluded by export settings.",
    },
  ];
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
    { label: "Completed", nodes: [] },
    { label: "Suggested / awaiting acceptance", nodes: [] },
  ];
  for (const node of snapshot.nodes) {
    if (node.status === "completed") { groups[5]!.nodes.push(node); continue; }
    if (node.status === "suggested") { groups[6]!.nodes.push(node); continue; }
    const diffDays = Math.floor(
      (Date.parse(`${node.startsOn}T00:00:00.000Z`) - asOf) / 86_400_000,
    );
    const overdue = isStrategyStepOverdue(node, new Date(asOf));
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
  return groups.filter((group, index) => index < 5 || group.nodes.length > 0);
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

function comparable(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function priority(node: ReportNode, asOf: number): number {
  if (node.status === "completed") return 99;
  if (node.status === "suggested") return 98;
  const overdue = isStrategyStepOverdue(node, new Date(asOf));
  if (overdue) return 0;
  if (node.kind === "risk") return 1;
  if (node.kind === "decision") return 2;
  if (node.kind === "gate") return 3;
  if (node.kind === "milestone") return 4;
  return 5;
}

function dueMs(node: ReportNode): number {
  return strategyStepDueDate(node) ?? Number.MAX_SAFE_INTEGER;
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
