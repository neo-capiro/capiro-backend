/**
 * Local visual QA harness (not a test): renders a DOCX and a PPTX with a
 * verified narrative, a timeline-worthy plan and two member-office cards, so
 * the output can be opened (or converted with LibreOffice headless) and read
 * page by page. Run from apps/api-strategy:
 *
 *   npx tsx test/report-visual-harness.ts <out-dir> [portrait.png]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DocxReportRenderer } from "../src/reports/docx-report.renderer.js";
import { PptxReportRenderer } from "../src/reports/pptx-report.renderer.js";
import { sanitizeRasterAsset } from "../src/reports/report-image.js";
import type { VerifiedReportNarrative } from "../src/reports/report-narrative.types.js";
import type {
  ExecutiveReportSnapshot,
  ReportMemberDetail,
  ReportNode,
  ReportRasterAsset,
} from "../src/reports/report.types.js";

const outDir = process.argv[2] ?? ".";
const portraitPath = process.argv[3];
mkdirSync(outDir, { recursive: true });

// Same sanitizer the export path runs on fetched portraits: strips metadata
// and yields dimensions; a file it rejects renders as initials, like production.
const portrait: ReportRasterAsset | null = portraitPath
  ? sanitizeRasterAsset({
      bytes: readFileSync(portraitPath),
      contentType: portraitPath.toLowerCase().endsWith(".png")
        ? "image/png"
        : "image/jpeg",
    })
  : null;
if (portraitPath && !portrait) console.warn("portrait rejected by sanitizer");

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
    startsOn: "2026-09-01",
    endsOn: "2026-09-30",
    openEnded: false,
    dependsOnIds: [],
    sources: [],
    targetLabel: null,
    memberRef: null,
    ...overrides,
  };
}

const cantwellRef = {
  memberId: "member-52480",
  memberName: "Maria Cantwell",
  party: "D",
  state: "WA",
  chamber: "Senate",
  committee: "Commerce, Science, and Transportation",
  sourceDirectory: "congress" as const,
};
const wickerRef = {
  memberId: "member-51245",
  memberName: "Roger Wicker",
  party: "R",
  state: "MS",
  chamber: "Senate",
  committee: "Armed Services",
  sourceDirectory: "congress" as const,
};

const nodes: ReportNode[] = [
  node({ id: "n1", title: "Confirm leadership message and proof points", ownerName: "Avery Cole", startsOn: "2026-08-10", endsOn: "2026-09-12" }),
  node({ id: "n2", kind: "decision", subject: "ask", title: "Select the preferred authorization path", ownerName: "Jordan Lee", startsOn: "2026-09-15", endsOn: "2026-09-15" }),
  node({ id: "n3", kind: "risk", title: "Committee calendar compression", ownerName: "Avery Cole", startsOn: "2026-08-01", endsOn: null, openEnded: true }),
  node({ id: "n4", kind: "gate", subject: "member", title: "Evidence package approved by SASC staff", ownerName: "Riley Chen", startsOn: "2026-10-01", endsOn: "2026-10-01", sources: [{ section: "Strategy brief", ref: "fact:1" }], targetLabel: "Roger Wicker", memberRef: wickerRef }),
  node({ id: "n5", subject: "member", title: "Brief Senator Cantwell's staff on program continuity", ownerName: "Riley Chen", startsOn: "2026-09-20", endsOn: "2026-10-15", targetLabel: "Maria Cantwell", memberRef: cantwellRef }),
  node({ id: "n6", kind: "milestone", subject: "outcome", title: "Markup language secured", ownerName: "Jordan Lee", startsOn: "2026-11-18", endsOn: "2026-11-18" }),
  node({ id: "n7", subject: "optics", title: "Coalition letter and trade-press placement", ownerName: "Sam Ito", startsOn: "2026-10-05", endsOn: "2026-11-05" }),
  node({ id: "n8", title: "Post-markup implementation guidance", ownerName: "Sam Ito", startsOn: "2026-12-01", endsOn: "2027-01-20" }),
  node({ id: "n9", title: "Overdue: district economic impact one-pager", ownerName: "Riley Chen", startsOn: "2026-07-01", endsOn: "2026-08-15" }),
];

const health = {
  score: 84,
  label: "On track" as const,
  coveragePct: 100,
  groundingPct: 100,
  timelinessPct: 78,
  totalNodes: nodes.length,
  ownedNodes: nodes.length,
  totalGates: 1,
  groundedGates: 1,
  overdueNodes: 1,
};

const snapshot: ExecutiveReportSnapshot = {
  snapshotHash: "c".repeat(64),
  asOf: "2026-09-01",
  strategy: {
    id: "strategy-1",
    title: "Authorization Strategy for Program Continuity",
    type: "authorization",
    goal: "Secure durable authorization language while preserving implementation flexibility.",
    summary: null,
    targetDate: "2026-12-15",
    ownerName: "Avery Cole",
    lastEditedAt: "2026-08-30T14:00:00.000Z",
  },
  client: {
    id: "client-1",
    name: "Northstar Systems",
    profile: {
      description: "Northstar develops secure mission systems for public-sector customers.",
      productDescription: "Its portfolio combines resilient communications and decision support.",
      profileType: "Enterprise",
      sectorTag: "Aerospace and defense",
      website: "https://northstar.example",
    },
    logo: { available: false, supported: false, contentType: null, objectKey: null },
  },
  version: { id: "version-1", createdAt: "2026-08-30T14:00:00.000Z", note: null },
  health,
  allLiveHealth: health,
  counts: { nodes: nodes.length, actions: 5, decisions: 1, gates: 1, milestones: 1, risks: 1, artifacts: 0 },
  inclusion: {
    liveNodes: nodes.length,
    includedNodes: nodes.length,
    omittedNodes: 0,
    includedByStatus: { in_progress: nodes.length },
    omittedByStatus: {},
    placeholderNodes: 0,
  },
  nodes,
  members: [
    { ...wickerRef, name: "Roger Wicker", nodeIds: ["n4"] },
    { ...cantwellRef, name: "Maria Cantwell", nodeIds: ["n5"] },
  ],
  artifacts: [],
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
        templateKey: "01_strategy_brief",
        authority: "client_approved",
        confidentiality: "client_confidential",
        asOf: "2026-08-29",
        validUntil: null,
        updatedAt: "2026-08-29T10:00:00.000Z",
        highlightCount: 3,
      },
    ],
    facts: [
      {
        id: "fact-1",
        text: "Committee staff expects a quantified evidence pack of 12 exhibits.",
        documentTitle: "Approved strategy brief",
        templateKey: "01_strategy_brief",
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
            text: "Obtain approval for the preferred path before the October markup window.",
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
    includeNarrative: true,
    includeMemberProfiles: true,
  },
  warnings: [],
  capacityErrors: [],
};

const narrative: VerifiedReportNarrative = {
  model: "harness",
  generatedAt: new Date().toISOString(),
  usage: { inputTokens: 0, outputTokens: 0 },
  attempts: 1,
  acceptedParagraphs: 7,
  rejectedParagraphs: 0,
  orchestratorDroppedParagraphs: 0,
  rejections: [],
  sections: [
    {
      id: "executive_summary",
      paragraphs: [
        {
          text: "Northstar Systems is pursuing durable authorization language while preserving the implementation flexibility its program depends on. As of Sep 1, 2026 the plan is on track, with a delivery readiness score of 84 of 100, every included step assigned to an owner, and the single evidence gate grounded in an approved source.",
          evidenceIds: ["plan:strategy", "plan:health"],
          sourceTitles: ["Strategy plan", "Delivery readiness"],
        },
        {
          text: "The near-term agenda turns on one decision: Jordan Lee will select the preferred authorization path on Sep 15, 2026, ahead of the evidence package that Riley Chen is carrying to Senate Armed Services Committee staff for approval on Oct 1, 2026. A compressed committee calendar makes early alignment essential, and one district economic one-pager is already overdue and needs to be recovered or rebaselined.",
          evidenceIds: ["plan:node:n2", "plan:node:n4", "ctx:situation:1", "plan:node:n9"],
          sourceTitles: ["Plan step: Select the preferred authorization path", "Approved strategy brief"],
        },
        {
          text: "With markup language targeted for Nov 18, 2026 and the strategy's target date set for Dec 15, 2026, the remaining work sequences from coalition positioning in October into implementation guidance that runs into January 2027.",
          evidenceIds: ["plan:node:n6", "plan:strategy", "plan:node:n8"],
          sourceTitles: ["Strategy plan"],
        },
      ],
    },
    {
      id: "situation",
      paragraphs: [
        {
          text: "Northstar develops secure mission systems for public-sector customers, combining resilient communications and decision support. The operating context is defined by timing: committee staff expect a quantified evidence pack of 12 exhibits, and a compressed committee calendar makes early alignment essential.",
          evidenceIds: ["client:profile", "fact:fact-1", "ctx:situation:1"],
          sourceTitles: ["Client profile", "Approved strategy brief"],
        },
      ],
    },
    {
      id: "objectives_and_ask",
      paragraphs: [
        {
          text: "The objective is to secure durable authorization language while preserving implementation flexibility. Leadership is asked to obtain approval for the preferred path before the October markup window, so that the evidence package and member engagement proceed on a settled position.",
          evidenceIds: ["plan:strategy", "ctx:ask:1"],
          sourceTitles: ["Strategy plan", "Approved strategy brief"],
        },
      ],
    },
    {
      id: "stakeholders",
      paragraphs: [
        {
          text: "Two Senate offices anchor the engagement. Roger Wicker, a Republican from Mississippi on the Armed Services Committee, is the target of the evidence package approval gate, while Maria Cantwell, a Democrat from Washington on Commerce, Science, and Transportation, will be briefed on program continuity between Sep 20, 2026 and Oct 15, 2026.",
          evidenceIds: ["member:member-51245", "member:member-52480", "plan:node:n4", "plan:node:n5"],
          sourceTitles: ["Member office: Roger Wicker", "Member office: Maria Cantwell"],
        },
      ],
    },
    {
      id: "roadmap_outlook",
      paragraphs: [
        {
          text: "The timeline runs from the overdue district one-pager through the Sep 15, 2026 path decision, the Oct 1, 2026 evidence gate and the October coalition placement, to markup language on Nov 18, 2026 and implementation guidance that continues into Jan 20, 2027.",
          evidenceIds: ["plan:roadmap", "plan:node:n9", "plan:node:n6", "plan:node:n8"],
          sourceTitles: ["Delivery roadmap"],
        },
      ],
    },
  ],
};

const memberDetails: ReportMemberDetail[] = [
  {
    memberId: "member-51245",
    name: "Roger Wicker",
    party: "R",
    state: "MS",
    chamber: "Senate",
    district: null,
    committees: ["Armed Services"],
    washingtonOffice: {
      label: "Washington Office",
      address1: "425 Russell Senate Office Building",
      address2: null,
      city: "Washington",
      state: "DC",
      zip: "20510",
      phone: "(202) 224-6253",
      fax: null,
    },
    photoUrl: portrait ? "https://img.legistorm.com/people/245/51245.jpg" : null,
    photoSource: "legistorm",
    resolved: true,
  },
  {
    memberId: "member-52480",
    name: "Maria Cantwell",
    party: "D",
    state: "WA",
    chamber: "Senate",
    district: null,
    committees: ["Commerce, Science, and Transportation"],
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
];

const memberPhotos = new Map<string, ReportRasterAsset>();
if (portrait) memberPhotos.set("member-51245", portrait);

const extras = { narrative, memberDetails, memberPhotos };

async function main(): Promise<void> {
  const docx = await new DocxReportRenderer().render(snapshot, null, extras);
  writeFileSync(join(outDir, "harness-client.docx"), docx);
  const pptx = await new PptxReportRenderer().render(
    { ...snapshot, options: { ...snapshot.options, format: "pptx" } },
    null,
    extras,
  );
  writeFileSync(join(outDir, "harness-client.pptx"), pptx);
  const internalDocx = await new DocxReportRenderer().render(
    {
      ...snapshot,
      options: { ...snapshot.options, audience: "internal", includeInternalNotes: true },
    },
    null,
    extras,
  );
  writeFileSync(join(outDir, "harness-internal.docx"), internalDocx);
  console.log(
    JSON.stringify({ docx: docx.length, pptx: pptx.length, internalDocx: internalDocx.length }),
  );
}

void main();
