import { describe, expect, it } from "@jest/globals";
import { buildPdfReportDocument } from "./pdf-report.document.js";
import { loadPdfFontFaces } from "./pdf-fonts.js";
import type {
  ExecutiveReportSnapshot,
  ReportNode,
} from "./report.types.js";

/**
 * Contract tests for the executive PDF document builder. These assert the
 * HTML the Chromium printer consumes: section order, page-break rules, footer
 * template, audience redaction, and option semantics. They never launch a
 * browser — that path is covered by the live export QA.
 */
describe("executive PDF report document", () => {
  it("embeds the Inter font faces as data URIs", () => {
    const faces = loadPdfFontFaces();
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      expect(face.dataUri.startsWith("data:font/woff2;base64,")).toBe(true);
    }
  });

  it("renders every section with a page-broken label and the cover blocks", () => {
    const { html } = buildPdfReportDocument(snapshot(), null);
    for (const label of [
      "Recommendation",
      "Funding position",
      "Where the cycle stands",
      "Risks and decision gates",
      "Sources and evidence",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("In this brief");
    expect(html).toContain("Prepared for");
    expect(html).toContain("Authorization Strategy for Program Continuity");
    // Each numbered section forces a new page (reference print semantics);
    // cards and table rows avoid splitting, and long tables repeat headers.
    expect(html).toContain("break-before:page");
    expect(html).toContain("break-inside:avoid");
    expect(html).toContain("table-header-group");
  });

  it("renders the delivery timeline and phase-grouped plan rows", () => {
    const { html } = buildPdfReportDocument(snapshot(), null);
    expect(html).toContain("gantt");
    expect(html).toContain("Confirm leadership message");
    expect(html).toContain("phase-row");
  });

  it("never renders internal working notes for a client audience", () => {
    const value = snapshot();
    value.options.audience = "client";
    value.options.includeInternalNotes = false;
    const { html } = buildPdfReportDocument(value, null);
    expect(html).not.toContain("Internal practitioner note");
  });

  it("renders internal notes only when the option is on for internal audience", () => {
    const value = snapshot();
    value.options.audience = "internal";
    value.options.includeInternalNotes = true;
    const { html } = buildPdfReportDocument(value, null);
    expect(html).toContain("Internal practitioner note");
  });

  it("omits the roadmap section when includeRoadmap is off", () => {
    const value = snapshot();
    value.options.includeRoadmap = false;
    const { html } = buildPdfReportDocument(value, null);
    expect(html).not.toContain("Where the cycle stands");
    // The gantt container markup (not the always-present CSS rules) is omitted.
    expect(html).not.toContain('<div class="gantt">');
    expect(html).not.toContain('<div class="gantt-row"');
  });

  it("omits the evidence register when includeEvidenceAppendix is off", () => {
    const value = snapshot();
    value.options.includeEvidenceAppendix = false;
    const { html } = buildPdfReportDocument(value, null);
    expect(html).not.toContain("Sources and evidence");
  });

  it("renders change log and agent history only for internal audience with flags on", () => {
    const value = snapshot();
    value.options.audience = "internal";
    value.options.includeChangeLog = true;
    value.options.includeAgentHistory = true;
    value.activity.versions = [
      {
        id: "v1",
        note: "Updated decision path",
        authorKind: "person",
        createdAt: "2026-08-29T14:00:00.000Z",
      },
    ];
    value.activity.agentRuns = [
      {
        state: "staged",
        trigger: "generate",
        startedAt: null,
        finishedAt: null,
        createdAt: "2026-08-29T14:00:00.000Z",
        waitingReason: null,
      },
    ];
    const { html } = buildPdfReportDocument(value, null);
    expect(html).toContain("Change log");
    expect(html).toContain("Agent history");
    expect(html).toContain("Updated decision path");

    const clientValue = snapshot();
    clientValue.options.audience = "client";
    clientValue.options.includeChangeLog = true;
    clientValue.options.includeAgentHistory = true;
    const clientDoc = buildPdfReportDocument(clientValue, null);
    expect(clientDoc.html).not.toContain("Change log");
    expect(clientDoc.html).not.toContain("Agent history");
  });

  it("asserts the source-tracing provenance only when dated evidence exists", () => {
    const withEvidence = buildPdfReportDocument(snapshot(), null);
    expect(withEvidence.html).toContain("traced to the source documents");

    const bare = snapshot();
    bare.context.facts = [];
    bare.context.sections = [];
    const without = buildPdfReportDocument(bare, null);
    expect(without.html).not.toContain("traced to the source documents");
  });

  it("escapes stored text and keeps source refs as text", () => {
    const value = snapshot();
    value.strategy.title = `Plan <script>alert(1)</script> & "quotes"`;
    const { html } = buildPdfReportDocument(value, null);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Approved strategy brief");
  });

  it("produces a footer template with page numbering and confidentiality", () => {
    const { footerTemplate } = buildPdfReportDocument(snapshot(), null);
    expect(footerTemplate).toContain("pageNumber");
    expect(footerTemplate).toContain("totalPages");
    expect(footerTemplate).toContain("Confidential");
    expect(footerTemplate).toContain("Northstar Systems");
  });

  it("labels the masthead, footer, and planning window for the internal audience", () => {
    const value = snapshot();
    value.options.audience = "internal";
    value.strategy.targetDate = "2026-11-20";
    const { html, footerTemplate } = buildPdfReportDocument(value, null);
    expect(html).toContain("Internal strategy brief");
    expect(html).not.toContain("Client strategy brief");
    expect(footerTemplate).toContain("Internal working copy");
    expect(footerTemplate).not.toContain("Client deliverable");
    // Planning window follows the strategy target date for every audience.
    expect(html).toContain("Through Nov 20, 2026");
  });

  it("renders member office profiles when the option is on and detail resolves", () => {
    const value = snapshot();
    value.options.includeMemberProfiles = true;
    value.members = [
      {
        memberId: "member-52480",
        memberName: "Maria Cantwell",
        party: "D",
        state: "WA",
        chamber: "Senate",
        committee: "Senate Armed Services Committee",
        sourceDirectory: "congress",
        name: "Maria Cantwell",
        nodeIds: ["gate"],
      },
    ];
    const { html } = buildPdfReportDocument(value, null, {
      memberDetails: [
        {
          memberId: "member-52480",
          name: "Maria Cantwell",
          party: "D",
          state: "WA",
          chamber: "Senate",
          district: null,
          committees: ["Senate Armed Services Committee"],
          washingtonOffice: {
            label: "Washington Office",
            address1: "511 Hart Senate Office Building",
            address2: null,
            city: "Washington",
            state: "DC",
            zip: "20510",
            phone: "(202) 224-3441",
            fax: null,
          },
          photoUrl: null,
          photoSource: null,
          resolved: true,
        },
      ],
    });
    expect(html).toContain("Member offices in the plan");
    expect(html).toContain("Maria Cantwell");
    expect(html).toContain("511 Hart Senate Office Building");
  });

  it("omits member profiles when the option is off", () => {
    const value = snapshot();
    value.options.includeMemberProfiles = false;
    const { html } = buildPdfReportDocument(value, null, {
      memberDetails: [
        {
          memberId: "member-52480",
          name: "Maria Cantwell",
          party: "D",
          state: "WA",
          chamber: "Senate",
          district: null,
          committees: [],
          washingtonOffice: null,
          photoUrl: null,
          photoSource: null,
          resolved: false,
        },
      ],
    });
    expect(html).not.toContain("Member offices in the plan");
  });

  it("labels working-draft evidence honestly instead of implying approval", () => {
    const value = snapshot();
    value.context.facts = [
      {
        id: "fact-9",
        text: "Draft finding not yet vetted.",
        documentTitle: "Working note",
        templateKey: "08_evidence",
        sourceRef: "heading:Draft",
        authority: "working_draft",
        asOf: "2026-08-29",
        confidence: null,
      },
    ];
    const { html } = buildPdfReportDocument(value, null);
    expect(html).toContain("Working draft");
    expect(html).not.toContain(">Client approved<");
  });
});

function snapshot(): ExecutiveReportSnapshot {
  const nodes: ReportNode[] = [
    node({ id: "action", title: "Confirm leadership message", ownerName: "Avery Cole" }),
    node({
      id: "decision",
      kind: "decision",
      title: "Select the preferred authorization path",
      startsOn: "2026-09-15",
      endsOn: "2026-09-15",
      ownerName: "Jordan Lee",
    }),
    node({
      id: "risk",
      kind: "risk",
      title: "Committee calendar compression",
      startsOn: "2026-08-01",
      endsOn: null,
      openEnded: true,
      ownerName: "Avery Cole",
    }),
    node({
      id: "gate",
      kind: "gate",
      title: "Evidence package approved",
      startsOn: "2026-10-01",
      endsOn: "2026-10-01",
      sources: [{ section: "Strategy brief", ref: "fact:1" }],
      targetLabel: "Senate Armed Services Committee",
    }),
  ];
  return {
    snapshotHash: "a".repeat(64),
    asOf: "2026-08-30",
    strategy: {
      id: "strategy-1",
      title: "Authorization Strategy for Program Continuity",
      type: "authorization",
      goal: "Secure durable authorization language while preserving implementation flexibility.",
      summary:
        "The plan aligns evidence development, stakeholder engagement, and decision gates around the next authorization cycle.",
      targetDate: "2026-12-15",
      ownerName: "Avery Cole",
      lastEditedAt: "2026-08-29T14:00:00.000Z",
    },
    client: {
      id: "client-1",
      name: "Northstar Systems",
      logo: { available: false, supported: false, contentType: null, objectKey: null },
    },
    version: { id: "version-1", createdAt: "2026-08-29T14:00:00.000Z", note: null },
    health: {
      score: 84,
      label: "On track",
      coveragePct: 100,
      groundingPct: 100,
      timelinessPct: 75,
      totalNodes: 4,
      ownedNodes: 4,
      totalGates: 1,
      groundedGates: 1,
      datedNodes: 4,
      overdueNodes: 1,
    },
    allLiveHealth: {
      score: 84,
      label: "On track",
      coveragePct: 100,
      groundingPct: 100,
      timelinessPct: 75,
      totalNodes: 4,
      ownedNodes: 4,
      totalGates: 1,
      groundedGates: 1,
      datedNodes: 4,
      overdueNodes: 1,
    },
    counts: { nodes: 4, actions: 1, decisions: 1, gates: 1, milestones: 0, risks: 1, artifacts: 1 },
    inclusion: {
      liveNodes: 4,
      includedNodes: 4,
      omittedNodes: 0,
      includedByStatus: { in_progress: 4 },
      omittedByStatus: {},
      placeholderNodes: 0,
    },
    nodes,
    members: [],
    artifacts: [{ nodeId: "action", artifactType: "workspace_draft", artifactRef: "draft-1" }],
    firmPhases: [],
    referenceWindows: [],
    context: {
      activeDocuments: 1,
      includedDocuments: 1,
      excludedDocuments: 0,
      staleDocuments: 0,
      openMaterialConflicts: 0,
      documents: [
        {
          id: "context-1",
          title: "Approved strategy brief",
          templateKey: "strategy_brief",
          authority: "client_approved",
          confidentiality: "client_shareable",
          asOf: "2026-08-29",
          validUntil: null,
          updatedAt: "2026-08-29T10:00:00.000Z",
          highlightCount: 3,
        },
      ],
      facts: [
        {
          id: "fact-1",
          text: "Committee staff expects a quantified evidence pack.",
          documentTitle: "Approved strategy brief",
          templateKey: "strategy_brief",
          sourceRef: "fact:1",
          authority: "client_approved",
          asOf: "2026-08-29",
          confidence: 0.9,
        },
      ],
      sections: [
        {
          key: "situation",
          title: "Situation",
          items: [
            {
              text: "A compressed committee calendar makes early alignment essential.",
              label: "Timing pressure",
              sourceTitle: "Approved strategy brief",
              sourceRef: "context-1#situation",
              authority: "client_approved",
              asOf: "2026-08-29",
              confidence: 0.9,
            },
          ],
        },
      ],
    },
    activity: { versions: [], agentRuns: [], changeSets: [] },
    options: {
      format: "pdf",
      audience: "client",
      useClientLogo: true,
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

function node(overrides: Partial<ReportNode>): ReportNode {
  return {
    id: "node",
    kind: "action",
    subject: "deliverable",
    title: "Plan step",
    note: "Internal practitioner note",
    ownerAssigned: true,
    ownerName: "Team member",
    status: "in_progress",
    startsOn: "2026-08-15",
    endsOn: "2026-09-15",
    openEnded: false,
    dependsOnIds: [],
    sources: [],
    targetLabel: null,
    ...overrides,
  };
}
