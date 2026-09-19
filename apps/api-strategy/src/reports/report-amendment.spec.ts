import { describe, expect, it, jest } from "@jest/globals";
import JSZip from "jszip";
import { DocxReportRenderer } from "./docx-report.renderer.js";
import { PptxReportRenderer } from "./pptx-report.renderer.js";
import {
  AMENDMENT_STATUS_LADDER,
  amendmentMessageDiscipline,
  classifyValidationResult,
  clientInputsRequired,
  reportSectionReadiness,
  routeAndVehicleItems,
  strategyTypeLabel,
  targetBudgetLineItems,
  validationSummary,
  vendorReferenceItems,
} from "./report-content.js";
import type {
  ExecutiveReportSnapshot,
  ReportContextFact,
  ReportNode,
} from "./report.types.js";

jest.setTimeout(30_000);

/*
 * Amendment-type executive report: the extra sections render ONLY when
 * `strategy.type === "amendment"`. The appropriations fixture below is the
 * same snapshot with a different type, so any leak of the new sections into
 * other types fails here.
 */

const AMENDMENT_HEADINGS = [
  "Target budget line",
  "Routes and vehicle status",
  "Core message discipline",
  "Information required from the client",
  "Validation summary and open gaps",
  "Vendor reference data",
];

const STANDARD_READINESS_IDS = [
  "summary",
  "context",
  "priorities",
  "decisions_risks",
  "roadmap",
  "accountability",
  "evidence",
];

describe("amendment report content", () => {
  it("labels the amendment type", () => {
    expect(strategyTypeLabel("amendment")).toBe("Amendment ask");
    expect(strategyTypeLabel("appropriations")).toBe("Appropriations");
  });

  it("selects Steward facts by template key", () => {
    const snap = amendmentSnapshot();
    expect(targetBudgetLineItems(snap).map((fact) => fact.id)).toEqual([
      "fact-target-1",
      "fact-target-2",
    ]);
    expect(routeAndVehicleItems(snap).map((fact) => fact.id)).toEqual([
      "fact-route-1",
    ]);
    expect(vendorReferenceItems(snap).map((fact) => fact.id)).toEqual([
      "fact-vendor-1",
      "fact-vendor-2",
    ]);
  });

  it("extracts client inputs from 'Client input required:' steps", () => {
    const inputs = clientInputsRequired(amendmentSnapshot());
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({
      input: "Offset candidate approved by the client CFO",
      status: "In progress",
      neededBy: "Sep 20, 2026",
    });
    expect(inputs[1]).toMatchObject({
      input: "Facility address and congressional district",
      status: "Completed",
    });
    // A plain decision step is not a client input.
    expect(inputs.map((item) => item.input)).not.toContain(
      "Select the sponsor office",
    );
  });

  it("classifies Confirmed / Unverified from confidence or authority", () => {
    expect(
      classifyValidationResult({ confidence: 0.8, authority: null }),
    ).toBe("Confirmed");
    expect(
      classifyValidationResult({ confidence: 0.95, authority: "draft" }),
    ).toBe("Confirmed");
    expect(
      classifyValidationResult({
        confidence: 0.2,
        authority: "external_authoritative",
      }),
    ).toBe("Confirmed");
    expect(
      classifyValidationResult({ confidence: null, authority: "firm_approved" }),
    ).toBe("Confirmed");
    expect(
      classifyValidationResult({ confidence: null, authority: "client_approved" }),
    ).toBe("Confirmed");
    expect(
      classifyValidationResult({ confidence: 0.79, authority: "draft" }),
    ).toBe("Unverified");
    expect(
      classifyValidationResult({ confidence: null, authority: null }),
    ).toBe("Unverified");
    expect(
      classifyValidationResult({ confidence: 0.5, authority: "unverified" }),
    ).toBe("Unverified");
  });

  it("builds the validation summary from evidence, target facts and open gaps", () => {
    const rows = validationSummary(amendmentSnapshot());
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          claim: "FY2027 President's Budget request for the line is $184.2M (Exhibit P-1, page 12).",
          result: "Confirmed",
        }),
        expect.objectContaining({
          claim: "House committee mark for the line: not yet read.",
          result: "Unverified",
        }),
        expect.objectContaining({
          claim: "Sponsor office confirmed interest in filing (staff email).",
          result: "Confirmed",
        }),
        expect.objectContaining({
          claim: "Context documents past their review date",
          result: "Open gap",
        }),
        expect.objectContaining({
          claim: "Unresolved material conflicts between context sources",
          result: "Open gap",
        }),
        expect.objectContaining({
          claim: "Offset candidate approved by the client CFO",
          result: "Open gap",
          note: expect.stringContaining("Sep 20, 2026"),
        }),
      ]),
    );
    // Vendor facts belong to the appendix, not the validation table; completed
    // client inputs are no longer gaps.
    expect(rows.map((row) => row.claim)).not.toContain(
      "Legal name: Northstar Systems LLC (SAM.gov entity).",
    );
    expect(rows.map((row) => row.claim)).not.toContain(
      "Facility address and congressional district",
    );
  });

  it("keeps the message discipline free of figures, dates and client facts", () => {
    const discipline = amendmentMessageDiscipline();
    expect(discipline.say.length).toBeGreaterThanOrEqual(5);
    expect(discipline.avoid.length).toBeGreaterThanOrEqual(6);
    for (const line of [...discipline.say, ...discipline.avoid]) {
      expect(line).not.toMatch(/\d/);
      expect(line).not.toMatch(/Northstar|\$|FY/);
    }
    expect(discipline.avoid.join(" ")).toMatch(/directed buy/);
    expect(discipline.say.join(" ")).toMatch(/offset/);
    expect(AMENDMENT_STATUS_LADDER).toEqual([
      "Filed",
      "Made in order",
      "Adopted",
      "Conferenced",
      "Enacted",
    ]);
  });

  it("adds an amendment_package readiness entry for amendment strategies only", () => {
    const amendment = reportSectionReadiness(amendmentSnapshot());
    expect(amendment.map((section) => section.id)).toEqual([
      ...STANDARD_READINESS_IDS,
      "amendment_package",
    ]);
    expect(amendment.at(-1)).toMatchObject({
      id: "amendment_package",
      state: "ready",
      availableCount: 7,
    });

    const appropriations = reportSectionReadiness(appropriationsSnapshot());
    expect(appropriations.map((section) => section.id)).toEqual(
      STANDARD_READINESS_IDS,
    );

    const empty = reportSectionReadiness(emptyAmendmentSnapshot());
    expect(empty.at(-1)).toMatchObject({
      id: "amendment_package",
      state: "empty",
      availableCount: 0,
    });
    expect(empty.at(-1)?.message).toContain("14_target_budget_line.md");
  });
});

describe("amendment report renderers", () => {
  it("renders every amendment section in the DOCX with its facts", async () => {
    const text = await packageText(
      await new DocxReportRenderer().render(amendmentSnapshot(), null),
    );
    for (const heading of AMENDMENT_HEADINGS) expect(text).toContain(heading);
    expect(text).toContain("Amendment ask");
    expect(text).toContain(
      "FY2027 President's Budget request for the line is $184.2M (Exhibit P-1, page 12).",
    );
    expect(text).toContain(
      "Primary route: House floor amendment to the FY2027 defense appropriations bill; window not yet scheduled.",
    );
    expect(text).toContain("What to say");
    expect(text).toContain("What not to say");
    expect(text).toContain("directed buy");
    expect(text).toContain("Offset candidate approved by the client CFO");
    expect(text).toContain("Needed by");
    expect(text).toContain("Open gap");
    expect(text).toContain("Legal name: Northstar Systems LLC (SAM.gov entity).");
    expect(text).toContain(
      "Rows marked Unverified must be confirmed against the named source before external use.",
    );
    expect(text).toContain("Unverified");
    expect(text).toContain("filed → made in order → adopted → conferenced → enacted");
  });

  it("orders the DOCX sections as the amendment document does", async () => {
    const text = await packageText(
      await new DocxReportRenderer().render(amendmentSnapshot(), null),
    );
    const position = (needle: string) => {
      const index = text.indexOf(needle);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };
    expect(position("Objectives, outcomes, and primary ask")).toBeLessThan(
      position("Target budget line"),
    );
    expect(position("Target budget line")).toBeLessThan(
      position("Routes and vehicle status"),
    );
    expect(position("Routes and vehicle status")).toBeLessThan(
      position("Situation and operating context"),
    );
    expect(position("Decision agenda and risk response")).toBeLessThan(
      position("Core message discipline"),
    );
    expect(position("Core message discipline")).toBeLessThan(
      position("Information required from the client"),
    );
    expect(position("Information required from the client")).toBeLessThan(
      position("Delivery roadmap"),
    );
    expect(position("Validation summary and open gaps")).toBeLessThan(
      position("Evidence and context source register"),
    );
    expect(position("Evidence and context source register")).toBeLessThan(
      position("Vendor reference data"),
    );
  });

  it("names the Steward template in each empty amendment section", async () => {
    const text = await packageText(
      await new DocxReportRenderer().render(emptyAmendmentSnapshot(), null),
    );
    expect(text).toContain(
      "No target budget line facts recorded yet — upload 14_target_budget_line.md.",
    );
    expect(text).toContain(
      "No route or vehicle status facts recorded yet — upload 16_route_and_vehicle_status.md.",
    );
    expect(text).toContain(
      "No vendor reference facts recorded yet — upload 15_vendor_reference_pull.md.",
    );
    expect(text).toContain("No client inputs are recorded.");
    // Message discipline is fixed text and always renders.
    expect(text).toContain("What not to say");
  });

  it.each([
    ["DOCX", (snap: ExecutiveReportSnapshot) => new DocxReportRenderer().render(snap, null)],
    ["PPTX", (snap: ExecutiveReportSnapshot) => new PptxReportRenderer().render(snap, null)],
  ])("does not add amendment sections to an appropriations %s", async (_label, render) => {
    const text = await packageText(await render(appropriationsSnapshot()));
    for (const heading of AMENDMENT_HEADINGS) {
      expect(text).not.toContain(heading);
    }
    expect(text).not.toContain("What not to say");
    expect(text).not.toContain("Appendix: Vendor reference data");
    expect(text).toContain("Appropriations");
  });

  it("renders the vendor appendix and validation summary for both audiences", async () => {
    const client = amendmentSnapshot();
    client.options.audience = "client";
    const internal = amendmentSnapshot();
    internal.options.audience = "internal";
    const [clientText, internalText] = await Promise.all([
      packageText(await new DocxReportRenderer().render(client, null)),
      packageText(await new DocxReportRenderer().render(internal, null)),
    ]);
    for (const text of [clientText, internalText]) {
      expect(text).toContain("Vendor reference data");
      expect(text).toContain("Validation summary and open gaps");
      expect(text).toContain("Legal name: Northstar Systems LLC (SAM.gov entity).");
    }
    // Internal notes on a client-input step stay internal.
    expect(clientText).not.toContain("Internal practitioner note");
    expect(internalText).toContain("Internal governance appendix");
  });

  it("renders the amendment slides in the PPTX", async () => {
    const bytes = await new PptxReportRenderer().render(amendmentSnapshot(), null);
    expect(bytes.subarray(0, 4).toString("hex")).toBe("504b0304");
    const text = await packageText(bytes);
    expect(text).toContain("Routes and vehicle status");
    expect(text).toContain("Core message discipline");
    expect(text).toContain("Information required from the client");
    expect(text).toContain("ROUTES & VEHICLE STATUS");
    expect(text).toContain("TARGET BUDGET LINE");
    expect(text).toContain("WHAT TO SAY");
    expect(text).toContain("WHAT NOT TO SAY");
    expect(text).toContain("Offset candidate approved by the client CFO");
    expect(text).toContain("Filed → Made in order → Adopted → Conferenced → Enacted");
    expect(text).toContain(
      "Primary route: House floor amendment to the FY2027 defense appropriations bill; window not yet scheduled.",
    );
  });
});

function amendmentSnapshot(): ExecutiveReportSnapshot {
  const nodes: ReportNode[] = [
    node({
      id: "action",
      title: "Draft the amendment text and offset language",
      ownerName: "Avery Cole",
    }),
    node({
      id: "decision",
      kind: "decision",
      subject: "ask",
      title: "Select the sponsor office",
      startsOn: "2026-09-15",
      endsOn: "2026-09-15",
      ownerName: "Jordan Lee",
    }),
    node({
      id: "client-input-1",
      kind: "decision",
      subject: "ask",
      title: "Client input required: Offset candidate approved by the client CFO",
      startsOn: "2026-09-10",
      endsOn: "2026-09-20",
      ownerName: "Jordan Lee",
    }),
    node({
      id: "client-input-2",
      kind: "decision",
      subject: "deliverable",
      title: "Client input required: Facility address and congressional district",
      status: "completed",
      startsOn: "2026-08-20",
      endsOn: "2026-08-28",
      ownerName: "Riley Chen",
    }),
    node({
      id: "gate",
      kind: "gate",
      subject: "committee",
      title: "Amendment filed with the Rules Committee",
      startsOn: "2026-10-01",
      endsOn: "2026-10-01",
      sources: [{ section: "Route and vehicle status", ref: "fact:route-1" }],
      targetLabel: "House Rules Committee",
    }),
    node({
      id: "risk",
      kind: "risk",
      title: "Continuing resolution closes the in-year window",
      startsOn: "2026-08-01",
      endsOn: null,
      openEnded: true,
      ownerName: "Avery Cole",
    }),
  ];
  const facts: ReportContextFact[] = [
    fact({
      id: "fact-target-1",
      text: "FY2027 President's Budget request for the line is $184.2M (Exhibit P-1, page 12).",
      documentTitle: "FY27 target line workbook",
      templateKey: "14_target_budget_line",
      sourceRef: "fact:target-1",
      authority: "external_authoritative",
      confidence: 0.95,
    }),
    fact({
      id: "fact-target-2",
      text: "House committee mark for the line: not yet read.",
      documentTitle: "FY27 target line workbook",
      templateKey: "14_target_budget_line",
      sourceRef: "fact:target-2",
      authority: "draft",
      confidence: 0.3,
    }),
    fact({
      id: "fact-route-1",
      text: "Primary route: House floor amendment to the FY2027 defense appropriations bill; window not yet scheduled.",
      documentTitle: "Vehicle and route tracker",
      templateKey: "16_route_and_vehicle_status",
      sourceRef: "fact:route-1",
      authority: "firm_approved",
      confidence: 0.9,
    }),
    fact({
      id: "fact-vendor-1",
      text: "Legal name: Northstar Systems LLC (SAM.gov entity).",
      documentTitle: "Company dossier pull",
      templateKey: "15_vendor_reference_pull",
      sourceRef: "fact:vendor-1",
      authority: "external_authoritative",
      confidence: 0.9,
    }),
    fact({
      id: "fact-vendor-2",
      text: "Litigation and adverse history: not sourced; enter and cite independently.",
      documentTitle: "Company dossier pull",
      templateKey: "15_vendor_reference_pull",
      sourceRef: "fact:vendor-2",
      authority: "draft",
      confidence: null,
    }),
    fact({
      id: "fact-evidence-1",
      text: "Sponsor office confirmed interest in filing (staff email).",
      documentTitle: "Evidence register",
      templateKey: "08_evidence_register",
      sourceRef: "fact:evidence-1",
      authority: "client_approved",
      confidence: 0.85,
    }),
    fact({
      id: "fact-brief-1",
      text: "Committee staff expects a quantified evidence pack.",
      documentTitle: "Approved strategy brief",
      templateKey: "01_strategy_brief",
      sourceRef: "fact:brief-1",
      authority: "client_approved",
      confidence: 0.9,
    }),
  ];
  return {
    snapshotHash: "b".repeat(64),
    asOf: "2026-08-30",
    strategy: {
      id: "strategy-amend",
      title: "Amendment Ask for Program Acceleration",
      type: "amendment",
      goal: "Secure a program increase to the target line through a sponsored floor amendment with a screened offset.",
      summary:
        "The plan carries a vendor-neutral capability ask through the House floor with the Senate and conference as parallel routes.",
      targetDate: "2026-12-15",
      ownerName: "Avery Cole",
      lastEditedAt: "2026-08-29T14:00:00.000Z",
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
      createdAt: "2026-08-29T14:00:00.000Z",
      note: "Added offset gate",
    },
    health: health(nodes),
    allLiveHealth: health(nodes),
    counts: {
      nodes: nodes.length,
      actions: 1,
      decisions: 3,
      gates: 1,
      milestones: 0,
      risks: 1,
      artifacts: 0,
    },
    inclusion: {
      liveNodes: nodes.length,
      includedNodes: nodes.length,
      omittedNodes: 0,
      includedByStatus: { in_progress: nodes.length - 1, completed: 1 },
      omittedByStatus: {},
      placeholderNodes: 0,
    },
    nodes,
    members: [],
    artifacts: [],
    firmPhases: [],
    referenceWindows: [],
    context: {
      activeDocuments: 5,
      includedDocuments: 5,
      excludedDocuments: 0,
      staleDocuments: 1,
      openMaterialConflicts: 1,
      documents: [
        document("context-target", "FY27 target line workbook", "14_target_budget_line"),
        document("context-route", "Vehicle and route tracker", "16_route_and_vehicle_status"),
        document("context-vendor", "Company dossier pull", "15_vendor_reference_pull"),
        document("context-evidence", "Evidence register", "08_evidence_register"),
        document("context-brief", "Approved strategy brief", "01_strategy_brief"),
      ],
      facts,
      sections: [
        {
          key: "ask",
          title: "Primary ask",
          items: [
            {
              text: "Request a program increase to the target line, stated as capability and quantity.",
              label: "Primary ask",
              sourceTitle: "Approved strategy brief",
              sourceRef: "context-brief#ask",
              authority: "client_approved",
              asOf: "2026-08-29",
              confidence: 0.95,
            },
          ],
        },
      ],
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
      includeMemberProfiles: false,
    },
    warnings: [],
    capacityErrors: [],
  };
}

/** Same facts and steps, different type: the control for byte-identical output. */
function appropriationsSnapshot(): ExecutiveReportSnapshot {
  const snap = amendmentSnapshot();
  snap.strategy.type = "appropriations";
  return snap;
}

/** An amendment strategy before any Steward templates are uploaded. */
function emptyAmendmentSnapshot(): ExecutiveReportSnapshot {
  const snap = amendmentSnapshot();
  snap.nodes = snap.nodes.filter((item) => !item.id.startsWith("client-input"));
  snap.context.facts = [];
  snap.context.documents = [];
  snap.context.staleDocuments = 0;
  snap.context.openMaterialConflicts = 0;
  return snap;
}

function health(nodes: ReportNode[]): ExecutiveReportSnapshot["health"] {
  return {
    score: 80,
    label: "On track",
    coveragePct: 100,
    groundingPct: 100,
    timelinessPct: 100,
    totalNodes: nodes.length,
    ownedNodes: nodes.length,
    totalGates: 1,
    groundedGates: 1,
    datedNodes: nodes.length,
    overdueNodes: 0,
  };
}

function document(
  id: string,
  title: string,
  templateKey: string,
): ExecutiveReportSnapshot["context"]["documents"][number] {
  return {
    id,
    title,
    templateKey,
    authority: "external_authoritative",
    confidentiality: "client_shareable",
    asOf: "2026-08-29",
    validUntil: null,
    updatedAt: "2026-08-29T10:00:00.000Z",
    highlightCount: 1,
  };
}

function fact(overrides: Partial<ReportContextFact> & Pick<ReportContextFact, "id" | "text">): ReportContextFact {
  return {
    documentTitle: "Context document",
    templateKey: "01_strategy_brief",
    sourceRef: `fact:${overrides.id}`,
    authority: null,
    asOf: "2026-08-29",
    confidence: null,
    ...overrides,
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

async function packageText(bytes: Buffer): Promise<string> {
  const archive = await JSZip.loadAsync(bytes);
  const xmlFiles = Object.values(archive.files).filter(
    (entry) =>
      !entry.dir &&
      (entry.name === "word/document.xml" ||
        /^ppt\/slides\/slide\d+\.xml$/.test(entry.name)),
  );
  const documents = await Promise.all(
    xmlFiles.map((entry) => entry.async("string")),
  );
  return documents
    .flatMap((xml) =>
      Array.from(
        xml.matchAll(/<(?:w:t|a:t)(?:\s[^>]*)?>([\s\S]*?)<\/(?:w:t|a:t)>/g),
      ),
    )
    .map((match) => decodeXml(match[1] ?? ""))
    .join(" ");
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}
