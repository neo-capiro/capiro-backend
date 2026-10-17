import type {
  ExecutiveReportSnapshot,
  ReportIssue,
  ReportLogoDescriptor,
} from "./report.types.js";

export const REPORT_CAPACITY_LIMITS = {
  nodes: 300,
  artifacts: 600,
  sourcesPerNode: 20,
  dependenciesPerNode: 100,
  contextDocuments: 40,
  contextFactsPerDocument: 80,
  contextSourceBytes: 2 * 1024 * 1024,
  snapshotBytes: 8 * 1024 * 1024,
  /** Member-office profiles drawn in one report; the rest stay as target labels. */
  memberProfiles: 12,
} as const;

export function reportCapacityIssues(input: {
  nodeRows: number;
  artifactRows: number;
  maxSourcesPerNode?: number;
  maxDependenciesPerNode?: number;
  contextDocumentRows?: number;
  contextSourceBytes?: number;
  contextFactsExceeded?: boolean;
  estimatedBytes: number;
}): ReportIssue[] {
  const issues: ReportIssue[] = [];
  if (input.nodeRows > REPORT_CAPACITY_LIMITS.nodes) {
    issues.push({
      code: "REPORT_NODE_LIMIT_EXCEEDED",
      message: `This strategy has more than ${REPORT_CAPACITY_LIMITS.nodes} active plan steps. Archive or split the plan before exporting.`,
    });
  }
  if (input.artifactRows > REPORT_CAPACITY_LIMITS.artifacts) {
    issues.push({
      code: "REPORT_ARTIFACT_LIMIT_EXCEEDED",
      message: `This strategy has more than ${REPORT_CAPACITY_LIMITS.artifacts} attached artifacts. Remove older attachments before exporting.`,
    });
  }
  if ((input.maxSourcesPerNode ?? 0) > REPORT_CAPACITY_LIMITS.sourcesPerNode) {
    issues.push({
      code: "REPORT_NODE_SOURCE_LIMIT_EXCEEDED",
      message: `At least one live plan step has more than ${REPORT_CAPACITY_LIMITS.sourcesPerNode} provenance sources. Remove obsolete sources or split that step before exporting.`,
    });
  }
  if (
    (input.maxDependenciesPerNode ?? 0) >
    REPORT_CAPACITY_LIMITS.dependenciesPerNode
  ) {
    issues.push({
      code: "REPORT_NODE_DEPENDENCY_LIMIT_EXCEEDED",
      message: `At least one live plan step has more than ${REPORT_CAPACITY_LIMITS.dependenciesPerNode} dependencies. Simplify or split that step before exporting.`,
    });
  }
  if (
    (input.contextDocumentRows ?? 0) > REPORT_CAPACITY_LIMITS.contextDocuments
  ) {
    issues.push({
      code: "REPORT_CONTEXT_LIMIT_EXCEEDED",
      message: `This strategy resolves more than ${REPORT_CAPACITY_LIMITS.contextDocuments} active context documents. Archive or supersede older context before exporting.`,
    });
  }
  if (input.contextFactsExceeded) {
    issues.push({
      code: "REPORT_CONTEXT_FACT_LIMIT_EXCEEDED",
      message: `At least one context document has more than ${REPORT_CAPACITY_LIMITS.contextFactsPerDocument} active facts. Supersede obsolete facts or split that source before exporting.`,
    });
  }
  if (
    (input.contextSourceBytes ?? 0) > REPORT_CAPACITY_LIMITS.contextSourceBytes
  ) {
    issues.push({
      code: "REPORT_CONTEXT_CONTENT_LIMIT_EXCEEDED",
      message:
        "The active context pack is too large for one executive report. Supersede obsolete context or split oversized documents before exporting.",
    });
  }
  if (input.estimatedBytes > REPORT_CAPACITY_LIMITS.snapshotBytes) {
    issues.push({
      code: "REPORT_SNAPSHOT_LIMIT_EXCEEDED",
      message:
        "This strategy contains too much report content for one executive export. Shorten notes or split the plan before exporting.",
    });
  }
  return issues;
}

/**
 * One readiness policy is used by both preflight and the export endpoint.
 *
 * Only genuine validity guards remain: payload capacity and the presence of at
 * least one plan step (an empty report is not a deliverable). Content-quality
 * and review-state checks (placeholder titles, open context conflicts, missing
 * executive premise) are advisory warnings for the author, never export
 * blockers — the direct-export flow has no approval step.
 */
export function reportReadinessErrors(
  snapshot: ExecutiveReportSnapshot,
): ReportIssue[] {
  const errors: ReportIssue[] = [...snapshot.capacityErrors];
  if (snapshot.counts.nodes === 0) {
    errors.unshift({
      code: "NO_REPORTABLE_PLAN_STEPS",
      message:
        "Add at least one live plan step before generating an executive report.",
    });
  }
  return errors;
}

export function buildWarnings(input: {
  clientFound: boolean;
  hasGoal: boolean;
  health: ExecutiveReportSnapshot["health"];
  logo: ReportLogoDescriptor;
  logoRequested: boolean;
  staleDocuments: number;
  openMaterialConflicts: number;
  audience: "client" | "internal";
  inclusion: ExecutiveReportSnapshot["inclusion"];
  narrativeItems: number;
  contextFacts: number;
  excludedContextDocuments: number;
  decisions: number;
  risks: number;
  memberProfilesOmitted: number;
}): ReportIssue[] {
  const warnings: ReportIssue[] = [];
  if (input.memberProfilesOmitted > 0) {
    warnings.push({
      code: "MEMBER_PROFILES_TRUNCATED",
      message: `${input.memberProfilesOmitted} additional member office${input.memberProfilesOmitted === 1 ? "" : "s"} will appear as plain stakeholder targets; the report profiles the first ${REPORT_CAPACITY_LIMITS.memberProfiles}.`,
    });
  }
  if (!input.clientFound) {
    warnings.push({
      code: "CLIENT_RECORD_UNAVAILABLE",
      message:
        "The client record could not be resolved; the report will use a generic label.",
    });
  }
  if (!input.hasGoal) {
    warnings.push({
      code: "MISSING_STRATEGY_GOAL",
      message:
        "The strategy has no explicit goal; the executive summary will be shorter.",
    });
  }
  if (input.audience === "client" && input.inclusion.omittedNodes > 0) {
    const reasons = Object.entries(input.inclusion.omittedByStatus)
      .map(([status, count]) => `${count} ${status.replace(/_/g, " ")}`)
      .join(", ");
    warnings.push({
      code: "WORKING_PLAN_ITEMS_OMITTED",
      message: `${input.inclusion.includedNodes} of ${input.inclusion.liveNodes} live plan steps will be included. ${reasons} item${input.inclusion.omittedNodes === 1 ? " is" : "s are"} excluded until reviewed and moved to In progress or Active.`,
    });
  }
  if (input.inclusion.placeholderNodes > 0) {
    warnings.push({
      code: "PLACEHOLDER_PLAN_CONTENT",
      message: `${input.inclusion.placeholderNodes} placeholder or test plan step${input.inclusion.placeholderNodes === 1 ? " needs" : "s need"} to be renamed or removed before a client deliverable is ready.`,
    });
  }
  if (input.narrativeItems === 0) {
    warnings.push({
      code: "NO_APPROVED_STRATEGIC_CONTEXT",
      message:
        input.audience === "client"
          ? "No approved, client-confidential context is available for the situation, outcomes, ask, constraints, or stakeholder narrative."
          : "No active context document contributes narrative detail; the report will rely on the plan alone.",
    });
  }
  if (input.audience === "client" && input.excludedContextDocuments > 0) {
    warnings.push({
      code: "CONTEXT_WITHHELD_FOR_AUDIENCE",
      message: `${input.excludedContextDocuments} active context document${input.excludedContextDocuments === 1 ? " is" : "s are"} excluded because it is stale, internal, or not marked as an approved source of truth.`,
    });
  }
  if (input.decisions === 0 && input.risks === 0) {
    warnings.push({
      code: "NO_DECISIONS_OR_RISKS",
      message:
        "No decision or risk steps are recorded, so the leadership agenda will not include a decision-and-risk register.",
    });
  }
  if (input.contextFacts === 0 && input.health.groundedGates === 0) {
    warnings.push({
      code: "NO_REPORT_EVIDENCE",
      message:
        "No approved context facts or evidence-grounded gates are available for the evidence section.",
    });
  }
  const unowned = input.health.totalNodes - input.health.ownedNodes;
  if (unowned > 0) {
    warnings.push({
      code: "UNASSIGNED_PLAN_STEPS",
      message: `${unowned} plan step${unowned === 1 ? " is" : "s are"} unassigned.`,
    });
  }
  const ungrounded = input.health.totalGates - input.health.groundedGates;
  if (ungrounded > 0) {
    warnings.push({
      code: "UNGROUNDED_GATES",
      message: `${ungrounded} gate${ungrounded === 1 ? " has" : "s have"} no evidence source.`,
    });
  }
  if (input.health.overdueNodes > 0) {
    warnings.push({
      code: "OVERDUE_PLAN_STEPS",
      message: `${input.health.overdueNodes} plan step${input.health.overdueNodes === 1 ? " is" : "s are"} overdue.`,
    });
  }
  if (input.logoRequested && !input.logo.available) {
    warnings.push({
      code: "CLIENT_LOGO_UNAVAILABLE",
      message:
        "No client logo is on file; the report will use typography-only branding.",
    });
  } else if (input.logoRequested && !input.logo.supported) {
    warnings.push({
      code: "CLIENT_LOGO_UNSUPPORTED",
      message:
        "The client logo cannot be embedded. Upload a PNG or JPEG for report branding.",
    });
  }
  if (input.staleDocuments > 0) {
    warnings.push({
      code: "STALE_CONTEXT",
      message: `${input.staleDocuments} active context document${input.staleDocuments === 1 ? " is" : "s are"} past its review date.`,
    });
  }
  if (input.openMaterialConflicts > 0) {
    warnings.push({
      code: "MATERIAL_CONTEXT_CONFLICTS",
      message: `${input.openMaterialConflicts} material context conflict${input.openMaterialConflicts === 1 ? " remains" : "s remain"} unresolved.`,
    });
  }
  return warnings;
}
