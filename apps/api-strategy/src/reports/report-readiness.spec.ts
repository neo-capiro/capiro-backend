import { describe, expect, it } from "@jest/globals";
import {
  contextItems,
  evidenceItems,
  focusAreas,
  leadershipAgenda,
  reportSectionReadiness,
} from "./report-content.js";
import { reportReadinessErrors } from "./report-snapshot.service.js";
import { buildReportFilename } from "./strategy-report.service.js";
import type { ExecutiveReportSnapshot, ReportNode } from "./report.types.js";

describe("executive report readiness", () => {
  it("no longer blocks a sparse client plan; review-state issues are advisory only", () => {
    const report = sparseClientReport();

    // The approval gates (placeholder content, context conflicts, missing
    // executive premise) are removed: the only hard readiness error left is a
    // plan with zero steps. Suggested/draft steps export without promotion.
    expect(reportReadinessErrors(report)).toEqual([]);
    expect(reportReadinessErrors(report)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "CLIENT_PLACEHOLDER_CONTENT" }),
        expect.objectContaining({ code: "CLIENT_CONTEXT_CONFLICT" }),
        expect.objectContaining({ code: "CLIENT_EXECUTIVE_PREMISE_MISSING" }),
      ]),
    );
  });

  it("still blocks a plan with zero reportable steps (empty deliverable)", () => {
    const report = completeReport();
    report.nodes = [];
    report.counts = { ...report.counts, nodes: 0 };
    expect(reportReadinessErrors(report)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "NO_REPORTABLE_PLAN_STEPS" }),
      ]),
    );
  });

  it("keeps the complete internal working plan exportable", () => {
    const report = sparseClientReport();
    report.options.audience = "internal";
    report.nodes = [
      ...report.nodes,
      ...Array.from({ length: 17 }, (_, index) =>
        node(`Suggested action ${index + 1}`, "suggested"),
      ),
      node("New step", "draft"),
      node("Test Step Member #2", "draft"),
    ];
    report.counts.nodes = report.nodes.length;
    report.inclusion = {
      ...report.inclusion,
      includedNodes: 20,
      omittedNodes: 0,
      includedByStatus: { active: 1, suggested: 17, draft: 2 },
      omittedByStatus: {},
    };

    expect(reportReadinessErrors(report)).toEqual([]);
  });

  it("assembles a substantive, traceable executive story without inference", () => {
    const report = completeReport();

    expect(contextItems(report, ["situation"])[0]?.text).toContain(
      "authorization window",
    );
    expect(focusAreas(report).map((area) => area.title)).toEqual(
      expect.arrayContaining([
        "Evidence and deliverables",
        "Stakeholder engagement",
        "Decision path and outcomes",
      ]),
    );
    expect(
      leadershipAgenda(report)
        .map((item) => item.title)
        .join(" "),
    ).toMatch(/Decide|Confirm response|Ground the gate/);
    expect(evidenceItems(report)[0]).toMatchObject({
      source: "Approved strategy brief",
    });
    expect(reportSectionReadiness(report)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "summary", state: "ready" }),
        expect.objectContaining({ id: "context", state: "ready" }),
        expect.objectContaining({ id: "evidence", state: "ready" }),
      ]),
    );
    expect(reportReadinessErrors(report)).toEqual([]);
  });

  it("makes client and internal server filenames unmistakable", () => {
    expect(
      buildReportFilename(
        "Northstar Systems",
        "Authorization plan",
        "2026-08-30",
        "docx",
        "client",
      ),
    ).toContain("executive-report-client-2026-08-30.docx");
    expect(
      buildReportFilename(
        "Northstar Systems",
        "Authorization plan",
        "2026-08-30",
        "pptx",
        "internal",
      ),
    ).toContain("executive-briefing-internal-working-2026-08-30.pptx");
  });
});

function sparseClientReport(): ExecutiveReportSnapshot {
  const active = node("Confirm program position", "active");
  return {
    ...baseReport([active]),
    inclusion: {
      liveNodes: 20,
      includedNodes: 1,
      omittedNodes: 19,
      includedByStatus: { active: 1 },
      omittedByStatus: { suggested: 17, draft: 2 },
      placeholderNodes: 2,
    },
  };
}

function completeReport(): ExecutiveReportSnapshot {
  const nodes = [
    node("Publish the evidence brief", "active", {
      subject: "deliverable",
      sources: [{ section: "Approved strategy brief", ref: "fact:1" }],
    }),
    node("Brief the authorizing committee", "in_progress", {
      subject: "committee",
      targetLabel: "Authorizing committee",
    }),
    node("Select the preferred language path", "active", {
      kind: "decision",
      subject: "ask",
    }),
    node("Calendar compression", "active", {
      kind: "risk",
      subject: "outcome",
      openEnded: true,
      endsOn: null,
    }),
    node("Evidence threshold met", "active", {
      kind: "gate",
      subject: "submission",
      sources: [{ section: "Evidence register", ref: "fact:2" }],
    }),
  ];
  const report = baseReport(nodes);
  report.counts = {
    nodes: 5,
    actions: 2,
    decisions: 1,
    gates: 1,
    milestones: 0,
    risks: 1,
    artifacts: 1,
  };
  report.inclusion = {
    liveNodes: 5,
    includedNodes: 5,
    omittedNodes: 0,
    includedByStatus: { active: 4, in_progress: 1 },
    omittedByStatus: {},
    placeholderNodes: 0,
  };
  report.context = {
    activeDocuments: 2,
    includedDocuments: 2,
    excludedDocuments: 0,
    staleDocuments: 0,
    openMaterialConflicts: 0,
    documents: [
      {
        id: "doc-1",
        title: "Approved strategy brief",
        templateKey: "01_strategy_brief",
        authority: "client_approved",
        confidentiality: "client_confidential",
        asOf: "2026-08-15",
        validUntil: "2026-12-31",
        updatedAt: "2026-08-15T12:00:00.000Z",
        highlightCount: 3,
      },
      {
        id: "doc-2",
        title: "Ask and options",
        templateKey: "03_ask_and_options",
        authority: "client_approved",
        confidentiality: "client_confidential",
        asOf: "2026-08-15",
        validUntil: "2026-12-31",
        updatedAt: "2026-08-15T12:00:00.000Z",
        highlightCount: 2,
      },
    ],
    facts: [
      {
        id: "fact-1",
        text: "The current authorization window closes before the next committee markup.",
        documentTitle: "Approved strategy brief",
        templateKey: "01_strategy_brief",
        sourceRef: "heading:Current position",
        authority: "client_approved",
        asOf: "2026-08-15",
        confidence: 0.95,
      },
    ],
    sections: [
      {
        key: "situation",
        title: "Situation and stakes",
        items: [
          {
            text: "The current authorization window closes before the next committee markup.",
            label: "Current position",
            sourceTitle: "Approved strategy brief",
            sourceRef: "heading:Current position",
            authority: "client_approved",
            asOf: "2026-08-15",
            confidence: 0.95,
          },
        ],
      },
      {
        key: "outcomes",
        title: "Objectives and definition of success",
        items: [
          {
            text: "Must achieve durable authorization language this cycle.",
            label: "Must achieve",
            sourceTitle: "Approved strategy brief",
            sourceRef: "heading:Must achieve",
            authority: "client_approved",
            asOf: "2026-08-15",
            confidence: null,
          },
        ],
      },
      {
        key: "ask",
        title: "Strategic ask and options",
        items: [
          {
            text: "Request inclusion of the agreed program language.",
            label: "Primary ask",
            sourceTitle: "Ask and options",
            sourceRef: "heading:Primary ask",
            authority: "client_approved",
            asOf: "2026-08-15",
            confidence: null,
          },
        ],
      },
      {
        key: "evidence",
        title: "Evidence and assumptions",
        items: [
          {
            text: "The evidence package is supported by the approved program record.",
            label: "Established facts",
            sourceTitle: "Approved strategy brief",
            sourceRef: "heading:Established facts",
            authority: "client_approved",
            asOf: "2026-08-15",
            confidence: 0.9,
          },
        ],
      },
    ],
  };
  return report;
}

function baseReport(nodes: ReportNode[]): ExecutiveReportSnapshot {
  const health = {
    score: 82,
    label: "On track" as const,
    coveragePct: 100,
    groundingPct: nodes.some((item) => item.kind === "gate") ? 100 : null,
    timelinessPct: 100,
    totalNodes: nodes.length,
    ownedNodes: nodes.length,
    totalGates: nodes.filter((item) => item.kind === "gate").length,
    groundedGates: nodes.filter(
      (item) => item.kind === "gate" && item.sources.length > 0,
    ).length,
    datedNodes: nodes.length,
    overdueNodes: 0,
  };
  return {
    snapshotHash: "a".repeat(64),
    asOf: "2026-08-30",
    strategy: {
      id: "strategy-1",
      title: "Program authorization strategy",
      type: "authorization",
      goal: "Secure durable authorization language this cycle.",
      summary: null,
      targetDate: "2026-12-15",
      ownerName: "Avery Cole",
      lastEditedAt: "2026-08-29T12:00:00.000Z",
    },
    client: {
      id: "client-1",
      name: "Northstar Systems",
      logo: {
        available: false,
        supported: false,
        contentType: null,
        objectKey: null,
      },
    },
    version: {
      id: "version-1",
      createdAt: "2026-08-29T12:00:00.000Z",
      note: null,
    },
    health,
    allLiveHealth: health,
    counts: {
      nodes: nodes.length,
      actions: nodes.filter((item) => item.kind === "action").length,
      decisions: nodes.filter((item) => item.kind === "decision").length,
      gates: nodes.filter((item) => item.kind === "gate").length,
      milestones: nodes.filter((item) => item.kind === "milestone").length,
      risks: nodes.filter((item) => item.kind === "risk").length,
      artifacts: 0,
    },
    inclusion: {
      liveNodes: nodes.length,
      includedNodes: nodes.length,
      omittedNodes: 0,
      includedByStatus: { active: nodes.length },
      omittedByStatus: {},
      placeholderNodes: 0,
    },
    nodes,
    members: [],
    artifacts: [],
    firmPhases: [],
    referenceWindows: [],
    context: {
      activeDocuments: 0,
      includedDocuments: 0,
      excludedDocuments: 0,
      staleDocuments: 0,
      openMaterialConflicts: 0,
      documents: [],
      facts: [],
      sections: [],
    },
    activity: { versions: [], agentRuns: [], changeSets: [] },
    options: {
      format: "docx",
      audience: "client",
      useClientLogo: false,
      includeRoadmap: true,
      includeEvidenceAppendix: true,
      includeChangeLog: false,
      includeInternalNotes: false,
      includeAgentHistory: false,
      includeNarrative: false,
      includeMemberProfiles: true,
    },
    warnings: [],
    capacityErrors: [],
  };
}

function node(
  title: string,
  status: string,
  overrides: Partial<ReportNode> = {},
): ReportNode {
  return {
    id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    kind: "action",
    subject: "deliverable",
    title,
    note: null,
    ownerAssigned: true,
    ownerName: "Avery Cole",
    status,
    startsOn: "2026-09-01",
    endsOn: "2026-09-30",
    openEnded: false,
    dependsOnIds: [],
    sources: [],
    targetLabel: null,
    ...overrides,
  };
}
