import { isCommittedStrategyStep, isStrategyStepOverdue, strategyStepDueDate } from '@capiro/strategy-verifier';
import type {
  ExecutiveReportSnapshot,
  ReportContextFact,
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
  const sections: ReportSectionReadiness[] = [
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
  if (isAmendmentStrategy(snapshot)) {
    const targetCount = targetBudgetLineItems(snapshot).length;
    const routeCount = routeAndVehicleItems(snapshot).length;
    const vendorCount = vendorReferenceItems(snapshot).length;
    const inputCount = clientInputsRequired(snapshot).length;
    const packageCount = targetCount + routeCount + vendorCount + inputCount;
    sections.push({
      id: "amendment_package",
      label: "Amendment package",
      state: state(packageCount, 3),
      availableCount: packageCount,
      message:
        packageCount > 0
          ? `${targetCount} target-line, ${routeCount} route, and ${vendorCount} vendor reference fact${targetCount + routeCount + vendorCount === 1 ? "" : "s"}; ${inputCount} client input${inputCount === 1 ? "" : "s"} tracked.`
          : "Upload 14_target_budget_line.md, 16_route_and_vehicle_status.md, and 15_vendor_reference_pull.md to populate the amendment sections.",
    });
  }
  return sections;
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
    amendment: "Amendment ask",
  };
  return labels[type] ?? titleCase(type);
}

/*
 * ---------------------------------------------------------------------------
 * Amendment-type content (deterministic, no LLM).
 *
 * An amendment strategy pursues a budget line or authorizing provision through
 * a named legislative vehicle. Its report carries extra sections drawn from
 * three Context Steward templates plus "Client input required:" decision
 * steps. Everything here is a pure projection of the audience-filtered
 * snapshot: the facts in `snapshot.context.facts` already passed report-policy
 * redaction, so these helpers never widen what a client may see.
 * ---------------------------------------------------------------------------
 */

export const TARGET_BUDGET_LINE_TEMPLATE_KEY = "14_target_budget_line";
export const VENDOR_REFERENCE_TEMPLATE_KEY = "15_vendor_reference_pull";
export const ROUTE_AND_VEHICLE_TEMPLATE_KEY = "16_route_and_vehicle_status";
export const EVIDENCE_REGISTER_TEMPLATE_KEY = "08_evidence_register";

/** Plan-step title prefix Meri uses for inputs only the client can supply. */
export const CLIENT_INPUT_REQUIRED_PREFIX = "Client input required:";

/** The five hurdles an amendment clears, in order; a stage is never advanced without evidence. */
export const AMENDMENT_STATUS_LADDER = [
  "Filed",
  "Made in order",
  "Adopted",
  "Conferenced",
  "Enacted",
] as const;

/** Authorities whose facts count as confirmed without a separate confidence score. */
const CONFIRMING_AUTHORITIES = new Set<string>([
  "external_authoritative",
  "firm_approved",
  "client_approved",
]);
const CONFIRMED_CONFIDENCE_FLOOR = 0.8;

export type ValidationResult = "Confirmed" | "Unverified";

export interface ClientInputRequirement {
  /** The input name: title text after the `Client input required:` prefix. */
  input: string;
  status: string;
  /** Formatted due date (end date, else start date). */
  neededBy: string;
  node: ReportNode;
}

export interface ValidationSummaryRow {
  claim: string;
  result: ValidationResult | "Open gap";
  note: string;
}

export interface AmendmentMessageDiscipline {
  say: readonly string[];
  avoid: readonly string[];
}

export function isAmendmentStrategy(snapshot: ExecutiveReportSnapshot): boolean {
  return snapshot.strategy.type === "amendment";
}

/** Steward facts extracted from `14_target_budget_line.md` (line identity, FY baseline, requested amendment). */
export function targetBudgetLineItems(
  snapshot: ExecutiveReportSnapshot,
): ReportContextFact[] {
  return factsForTemplate(snapshot, TARGET_BUDGET_LINE_TEMPLATE_KEY);
}

/** Steward facts extracted from `16_route_and_vehicle_status.md` (vehicles, routes, status ladder, deadlines). */
export function routeAndVehicleItems(
  snapshot: ExecutiveReportSnapshot,
): ReportContextFact[] {
  return factsForTemplate(snapshot, ROUTE_AND_VEHICLE_TEMPLATE_KEY);
}

/** Steward facts extracted from `15_vendor_reference_pull.md` (company dossier rows). */
export function vendorReferenceItems(
  snapshot: ExecutiveReportSnapshot,
): ReportContextFact[] {
  return factsForTemplate(snapshot, VENDOR_REFERENCE_TEMPLATE_KEY);
}

/**
 * Included plan steps titled `Client input required: <input>`. Matched on the
 * title prefix (case-insensitive) rather than on kind so a mis-kinded step
 * still reaches the "Information required from the client" table.
 */
export function clientInputsRequired(
  snapshot: ExecutiveReportSnapshot,
): ClientInputRequirement[] {
  const prefix = new RegExp(
    `^\\s*${CLIENT_INPUT_REQUIRED_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`,
    "i",
  );
  return snapshot.nodes.flatMap((node) => {
    if (!prefix.test(node.title)) return [];
    const input = node.title.replace(prefix, "").trim() || node.title.trim();
    return [
      {
        input,
        status: statusLabel(node.status),
        neededBy: node.openEnded
          ? "Ongoing"
          : formatDate(node.endsOn ?? node.startsOn),
        node,
      },
    ];
  });
}

/**
 * The single classification rule for "is this fact confirmed?": a fact is
 * Confirmed when its recorded confidence reaches the floor OR its document
 * authority is external-authoritative / firm-approved / client-approved;
 * everything else is Unverified. Used by the validation summary and the
 * vendor appendix so the two never disagree.
 */
export function classifyValidationResult(fact: {
  confidence: number | null;
  authority: string | null;
}): ValidationResult {
  if (
    fact.confidence !== null &&
    Number.isFinite(fact.confidence) &&
    fact.confidence >= CONFIRMED_CONFIDENCE_FLOOR
  ) {
    return "Confirmed";
  }
  if (fact.authority && CONFIRMING_AUTHORITIES.has(fact.authority)) {
    return "Confirmed";
  }
  return "Unverified";
}

/**
 * Claim-by-claim validation table: evidence-register and target-budget-line
 * facts classified Confirmed / Unverified, followed by open-gap rows for stale
 * context, unresolved material conflicts, and client inputs still outstanding.
 */
export function validationSummary(
  snapshot: ExecutiveReportSnapshot,
): ValidationSummaryRow[] {
  const facts = [
    ...factsForTemplate(snapshot, EVIDENCE_REGISTER_TEMPLATE_KEY),
    ...targetBudgetLineItems(snapshot),
  ].filter(
    (fact, index, all) =>
      all.findIndex((candidate) => candidate.id === fact.id) === index,
  );
  const rows: ValidationSummaryRow[] = facts.map((fact) => ({
    claim: fact.text,
    result: classifyValidationResult(fact),
    note: factProvenance(fact),
  }));
  if (snapshot.context.staleDocuments > 0) {
    rows.push({
      claim: "Context documents past their review date",
      result: "Open gap",
      note: `${snapshot.context.staleDocuments} context document${snapshot.context.staleDocuments === 1 ? " is" : "s are"} past review; refresh before external use.`,
    });
  }
  if (snapshot.context.openMaterialConflicts > 0) {
    rows.push({
      claim: "Unresolved material conflicts between context sources",
      result: "Open gap",
      note: `${snapshot.context.openMaterialConflicts} open material conflict${snapshot.context.openMaterialConflicts === 1 ? "" : "s"}; resolve before the figures are cited.`,
    });
  }
  for (const requirement of clientInputsRequired(snapshot)) {
    if (requirement.node.status === "completed") continue;
    rows.push({
      claim: requirement.input,
      result: "Open gap",
      note: `Client input · ${requirement.status} · needed by ${requirement.neededBy}`,
    });
  }
  return rows;
}

/**
 * Fixed, fact-free message discipline for an amendment ask. These lines carry
 * no numbers, dates, names or client facts by design, so they can never be
 * ungrounded; the unit test enforces the no-digit rule.
 */
export function amendmentMessageDiscipline(): AmendmentMessageDiscipline {
  return AMENDMENT_MESSAGE_DISCIPLINE;
}

const AMENDMENT_MESSAGE_DISCIPLINE: AmendmentMessageDiscipline = {
  say: [
    "State the request as a program increase to a specific line within an actively funded account, not as a new program.",
    "Explain that the increase accelerates fielding of a qualified capability against a validated requirement.",
    "Emphasize that the increase is executable in the current year under an existing contract vehicle.",
    "Describe the effort as supporting domestic capacity, keeping the statement general until it is independently documented.",
    "Present the request as a sponsored amendment with a specific offset, carried in parallel into the other chamber and into conference.",
    "Identify the next fiscal-year request window as the backstop if the current vehicle closes.",
  ],
  avoid: [
    "Never describe the request as enacted, appropriated, secured, or received.",
    "Never misdescribe the account type; procurement and research, development, test and evaluation funds follow different rules.",
    "Never name a single vendor in the funding table or report language, and never call the request a directed buy.",
    "Never cite figures from a different line item or program element as the baseline.",
    "Never represent the amendment as made in order or adopted until the Rules Committee report or the recorded vote says so.",
    "Never commit to floor timing; describe unscheduled floor windows as not yet scheduled.",
    "Never use company, district, or jobs claims until they are independently documented.",
  ],
};

function factsForTemplate(
  snapshot: ExecutiveReportSnapshot,
  templateKey: string,
): ReportContextFact[] {
  return snapshot.context.facts.filter(
    (fact) => fact.templateKey === templateKey,
  );
}

function factProvenance(fact: ReportContextFact): string {
  return [
    fact.documentTitle,
    fact.asOf ? `as of ${formatDate(fact.asOf)}` : null,
    fact.authority ? kindLabel(fact.authority) : null,
    fact.confidence === null
      ? null
      : `${Math.round(fact.confidence * 100)}% confidence`,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
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
