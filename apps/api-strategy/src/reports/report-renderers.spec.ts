import { describe, expect, it, jest } from "@jest/globals";
import { XMLValidator } from "fast-xml-parser";
import JSZip from "jszip";
import { DocxReportRenderer } from "./docx-report.renderer.js";
import { PptxReportRenderer } from "./pptx-report.renderer.js";
import type { VerifiedReportNarrative } from "./report-narrative.types.js";
import { ooxmlSafeText } from "./report-text.js";
import type {
  ExecutiveReportSnapshot,
  ReportMemberDetail,
  ReportNode,
  ReportRenderExtras,
} from "./report.types.js";

jest.setTimeout(20_000);

describe("executive report renderers", () => {
  it.each([
    ["DOCX", () => new DocxReportRenderer().render(snapshot(), null)],
    ["PPTX", () => new PptxReportRenderer().render(snapshot(), null)],
  ])("renders a non-empty %s OOXML package", async (_label, render) => {
    const bytes = await render();
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(1_000);
    expect(bytes.subarray(0, 4).toString("hex")).toBe("504b0304");
  });

  it.each([
    ["DOCX", () => new DocxReportRenderer().render(snapshot(), null)],
    ["PPTX", () => new PptxReportRenderer().render(snapshot(), null)],
  ])(
    "renders the complete executive narrative in %s without client-private notes",
    async (_label, render) => {
      const text = await packageText(await render());

      expect(text).toContain("Situation and");
      expect(text).toContain("Leadership");
      expect(text.toLowerCase()).toContain("action register");
      expect(text).toContain(
        "A compressed committee calendar makes early alignment essential.",
      );
      expect(text).toContain("Obtain approval for the preferred path.");
      expect(text).toContain(
        "Committee staff expects a quantified evidence pack.",
      );
      expect(text).not.toContain("Internal practitioner note");
    },
  );

  it.each([
    ["DOCX", () => new DocxReportRenderer().render(workingPlanSnapshot(), null)],
    ["PPTX", () => new PptxReportRenderer().render(workingPlanSnapshot(), null)],
  ])(
    "emits each internal-audience working-plan item exactly once in %s",
    async (_label, render) => {
      const snap = workingPlanSnapshot();
      const workingTitles = snap.nodes
        .filter((node) =>
          ["suggested", "draft", "internal_review"].includes(node.status),
        )
        .map((node) => node.title);
      // More than 5 so PPTX's paginated working-plan appendix (5 items per
      // slide) is actually exercised, not just its single-page case.
      expect(workingTitles.length).toBeGreaterThan(5);

      const text = await packageText(await render());
      for (const title of workingTitles) {
        const occurrences = text.split(title).length - 1;
        expect(occurrences).toBe(1);
      }
    },
  );

  it.each([
    ["DOCX", () => new DocxReportRenderer().render(unsafeSnapshot(), null)],
    ["PPTX", () => new PptxReportRenderer().render(unsafeSnapshot(), null)],
  ])("normalizes stored text into valid %s XML", async (_label, render) => {
    const archive = await JSZip.loadAsync(await render());
    const xmlFiles = Object.values(archive.files).filter(
      (entry) =>
        !entry.dir &&
        (entry.name.endsWith(".xml") || entry.name.endsWith(".rels")),
    );
    expect(xmlFiles.length).toBeGreaterThan(3);

    const documents = await Promise.all(
      xmlFiles.map((entry) => entry.async("string")),
    );
    for (const xml of documents) {
      expect(ooxmlSafeText(xml)).toBe(xml);
      expect(XMLValidator.validate(xml)).toBe(true);
    }
    expect(documents.join("\n")).toContain("valid emoji \ud83d\ude80");
  });

  it("keeps legal supplementary characters and replaces invalid XML code units", () => {
    expect(ooxmlSafeText("A\u0001B\ud83d\ude80C\ud800D\udc00E")).toBe(
      "A B\ud83d\ude80C\ufffdD\ufffdE",
    );
  });

  it.each([
    ["DOCX", (extras: ReportRenderExtras) => new DocxReportRenderer().render(snapshot(), null, extras)],
    ["PPTX", (extras: ReportRenderExtras) => new PptxReportRenderer().render(snapshot(), null, extras)],
  ])(
    "renders verified narrative prose with its sources in %s and drops the bullet fallback",
    async (_label, render) => {
      const text = await packageText(await render({ narrative: narrative() }));

      expect(text).toContain(
        "Northstar Systems is pursuing durable authorization language while the committee calendar compresses.",
      );
      expect(text).toContain(
        "Early alignment with committee staff is essential because the calendar is compressed.",
      );
      expect(text).toContain("Sources: Approved strategy brief");
      // The deterministic situation bullet is replaced by the prose: the item
      // may still be listed once in an appendix/source register, never twice.
      expect(
        text.split("A compressed committee calendar makes early alignment essential.").length - 1,
      ).toBeLessThanOrEqual(1);
      expect(text).not.toContain("Timing pressure:");
    },
  );

  it.each([
    ["DOCX", () => new DocxReportRenderer().render(snapshot(), null)],
    ["PPTX", () => new PptxReportRenderer().render(snapshot(), null)],
  ])("draws a delivery timeline with period columns in %s", async (_label, render) => {
    const text = await packageText(await render());
    expect(text).toContain("Delivery timeline");
    expect(text).toContain("Sep ’26");
    expect(text).toContain("Dec ’26");
    expect(text).toContain("Confirm leadership message");
  });

  it.each([
    ["DOCX", (extras: ReportRenderExtras) => new DocxReportRenderer().render(memberSnapshot(), null, extras)],
    ["PPTX", (extras: ReportRenderExtras) => new PptxReportRenderer().render(memberSnapshot(), null, extras)],
  ])(
    "renders member office cards with the Washington office and portrait in %s",
    async (_label, render) => {
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      );
      const bytes = await render({
        memberDetails: [memberDetail()],
        memberPhotos: new Map([["member-52480", { bytes: png, contentType: "image/png" }]]),
      });
      const text = await packageText(bytes);
      expect(text).toContain("Member offices in the plan");
      expect(text).toContain("Maria Cantwell");
      expect(text).toContain("511 Hart Senate Office Building");
      expect(text).toContain("Democratic");
      expect(text).toContain("(202) 224-3441");

      const archive = await JSZip.loadAsync(bytes);
      const media = Object.keys(archive.files).filter((name) =>
        /(word|ppt)\/media\//.test(name),
      );
      expect(media.length).toBeGreaterThan(0);
    },
  );

  it.each([
    ["DOCX", (extras: ReportRenderExtras) => new DocxReportRenderer().render(memberSnapshot(), null, extras)],
    ["PPTX", (extras: ReportRenderExtras) => new PptxReportRenderer().render(memberSnapshot(), null, extras)],
  ])("falls back to initials and a directory note when no detail resolved in %s", async (_label, render) => {
    const text = await packageText(
      await render({
        memberDetails: [
          { ...memberDetail(), washingtonOffice: null, photoUrl: null, resolved: false },
        ],
      }),
    );
    expect(text).toContain("Maria Cantwell");
    expect(text).toMatch(/Directory detail was not available/);
    expect(text).not.toContain("511 Hart");
  });
});

function narrative(): VerifiedReportNarrative {
  return {
    model: "claude-test",
    generatedAt: "2026-08-30T12:00:00.000Z",
    usage: { inputTokens: 10, outputTokens: 5 },
    attempts: 1,
    acceptedParagraphs: 2,
    rejectedParagraphs: 0,
    orchestratorDroppedParagraphs: 0,
    rejections: [],
    sections: [
      {
        id: "executive_summary",
        paragraphs: [
          {
            text: "Northstar Systems is pursuing durable authorization language while the committee calendar compresses.",
            evidenceIds: ["plan:strategy", "ctx:situation:1"],
            sourceTitles: ["Strategy plan", "Approved strategy brief"],
          },
        ],
      },
      {
        id: "situation",
        paragraphs: [
          {
            text: "Early alignment with committee staff is essential because the calendar is compressed.",
            evidenceIds: ["ctx:situation:1"],
            sourceTitles: ["Approved strategy brief"],
          },
        ],
      },
    ],
  };
}

function memberDetail(): ReportMemberDetail {
  return {
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
    photoUrl: "https://img.legistorm.com/people/480/52480.jpg",
    photoSource: "legistorm",
    resolved: true,
  };
}

function memberSnapshot(): ExecutiveReportSnapshot {
  const base = snapshot();
  const gate = base.nodes.find((node) => node.id === "gate")!;
  gate.subject = "member";
  gate.targetLabel = "Maria Cantwell";
  gate.memberRef = {
    memberId: "member-52480",
    memberName: "Maria Cantwell",
    party: "D",
    state: "WA",
    chamber: "Senate",
    committee: "Senate Armed Services Committee",
    sourceDirectory: "congress",
  };
  return {
    ...base,
    members: [
      {
        ...gate.memberRef,
        name: "Maria Cantwell",
        nodeIds: ["gate"],
      },
    ],
  };
}

function unsafeSnapshot(): ExecutiveReportSnapshot {
  const unsafe = snapshot();
  unsafe.strategy.title =
    "Control\u0001 plan with valid emoji \ud83d\ude80 and lone \ud800";
  unsafe.client.name = "Client\u000b name";
  unsafe.strategy.goal = "Goal\u0000 text";
  unsafe.nodes[0]!.title = "Node\u000c title";
  unsafe.nodes[0]!.note = "Internal\u0007 note";
  unsafe.nodes[0]!.sources = [{ section: "Source\u001f section", ref: null }];
  return unsafe;
}

function snapshot(): ExecutiveReportSnapshot {
  const nodes: ReportNode[] = [
    node({
      id: "action",
      title: "Confirm leadership message",
      ownerName: "Avery Cole",
    }),
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
      profile: {
        description:
          "Northstar develops secure mission systems for public-sector customers.",
        productDescription:
          "Its portfolio combines resilient communications and decision support.",
        profileType: "Enterprise",
        sectorTag: "Aerospace and defense",
        website: "https://northstar.example",
      },
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
      note: "Updated decision path",
    },
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
      overdueNodes: 1,
    },
    counts: {
      nodes: 4,
      actions: 1,
      decisions: 1,
      gates: 1,
      milestones: 0,
      risks: 1,
      artifacts: 1,
    },
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
    artifacts: [
      {
        nodeId: "action",
        artifactType: "workspace_draft",
        artifactRef: "draft-1",
      },
    ],
    firmPhases: [
      { label: "Positioning", startFy: 2026, startQ: 4, endFy: 2027, endQ: 1 },
    ],
    referenceWindows: [],
    context: {
      activeDocuments: 4,
      includedDocuments: 1,
      excludedDocuments: 3,
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
        {
          key: "ask",
          title: "Primary ask",
          items: [
            {
              text: "Obtain approval for the preferred path.",
              label: "Leadership decision",
              sourceTitle: "Approved strategy brief",
              sourceRef: "context-1#ask",
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

function workingPlanSnapshot(): ExecutiveReportSnapshot {
  const base = snapshot();
  const workingNodes: ReportNode[] = [
    node({
      id: "wp-decision",
      kind: "decision",
      subject: "ask",
      title: "Suggested decision: adjust authorization ask",
      status: "suggested",
      startsOn: "2026-09-15",
      endsOn: "2026-09-15",
      ownerName: "Jordan Lee",
    }),
    node({
      id: "wp-risk",
      kind: "risk",
      subject: "member",
      title: "Draft risk: committee turnover",
      status: "draft",
      startsOn: "2026-08-01",
      endsOn: null,
      openEnded: true,
      ownerName: "Avery Cole",
    }),
    node({
      id: "wp-overdue",
      kind: "action",
      subject: "deliverable",
      title: "Internal review: overdue evidence packet",
      status: "internal_review",
      startsOn: "2026-01-01",
      endsOn: "2026-02-01",
      ownerName: "Riley Chen",
    }),
    node({
      id: "wp-unowned",
      kind: "action",
      subject: "optics",
      title: "Suggested outreach: op-ed placement",
      status: "suggested",
      ownerAssigned: false,
      ownerName: "",
      startsOn: "2026-08-20",
      endsOn: "2026-09-20",
    }),
    node({
      id: "wp-5",
      subject: "member",
      title: "Draft step five",
      status: "draft",
      ownerName: "Sam Ito",
    }),
    node({
      id: "wp-6",
      subject: "agency",
      title: "Suggested step six",
      status: "suggested",
      ownerName: "Sam Ito",
    }),
    node({
      id: "wp-7",
      subject: "committee",
      title: "Internal review step seven",
      status: "internal_review",
      ownerName: "Sam Ito",
    }),
  ];
  return {
    ...base,
    nodes: [...base.nodes, ...workingNodes],
    options: { ...base.options, audience: "internal" },
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
