import { describe, expect, it } from "@jest/globals";
import {
  buildNarrativeEvidence,
  partyLabel,
} from "./report-narrative-evidence.js";
import type {
  ExecutiveReportSnapshot,
  ReportMemberDetail,
  ReportNode,
} from "./report.types.js";

describe("narrative evidence packet", () => {
  it("emits plan, health, node, context, fact and member entries with stable ids", () => {
    const evidence = buildNarrativeEvidence(snapshot(), [memberDetail()]);
    const ids = evidence.map((entry) => entry.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "plan:strategy",
        "client:profile",
        "plan:health",
        "plan:node:decision",
        "plan:roadmap",
        "plan:timeline",
        "plan:agenda",
        "ctx:situation:1",
        "fact:fact-1",
        "member:member-52480",
      ]),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("formats dates exactly as the renderers do so the verifier can match prose", () => {
    const evidence = buildNarrativeEvidence(snapshot(), []);
    const strategy = evidence.find((entry) => entry.id === "plan:strategy")!;
    expect(strategy.text).toContain("Plan as of: Aug 30, 2026.");
    expect(strategy.text).toContain("Target date: Dec 15, 2026.");
    const node = evidence.find((entry) => entry.id === "plan:node:decision")!;
    expect(node.text).toContain("Timing: Sep 15, 2026.");
    expect(node.text).toContain("Owner: Jordan Lee.");
  });

  it("spells out member party, chamber and the Washington office verbatim", () => {
    const evidence = buildNarrativeEvidence(snapshot(), [memberDetail()]);
    const member = evidence.find((entry) => entry.id === "member:member-52480")!;
    expect(member.sourceTitle).toBe("Member office: Maria Cantwell");
    expect(member.text).toContain("Party: Democratic.");
    expect(member.text).toContain("Chamber: Senate.");
    expect(member.text).toContain(
      "Washington office: 511 Hart Senate Office Building, Washington, DC 20510.",
    );
    expect(member.text).toContain("Phone: (202) 224-3441.");
    expect(member.text).toContain(
      "Plan steps targeting this office: Evidence package approved.",
    );
  });

  it("withholds internal notes unless the options include them", () => {
    const base = snapshot();
    const withoutNotes = buildNarrativeEvidence(base, []);
    expect(
      withoutNotes.find((entry) => entry.id === "plan:node:decision")!.text,
    ).not.toContain("Internal practitioner note");

    const withNotes = buildNarrativeEvidence(
      {
        ...base,
        options: { ...base.options, audience: "internal", includeInternalNotes: true },
      },
      [],
    );
    expect(
      withNotes.find((entry) => entry.id === "plan:node:decision")!.text,
    ).toContain("Internal note: Internal practitioner note");
  });

  it("expands party codes", () => {
    expect(partyLabel("D")).toBe("Democratic");
    expect(partyLabel("Republican")).toBe("Republican");
    expect(partyLabel("I")).toBe("Independent");
    expect(partyLabel("Libertarian")).toBe("Libertarian");
  });
});

function memberDetail(): ReportMemberDetail {
  return {
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
    photoUrl: "https://img.legistorm.com/people/480/52480.jpg",
    photoSource: "legistorm",
    resolved: true,
  };
}

function snapshot(): ExecutiveReportSnapshot {
  const nodes: ReportNode[] = [
    node({
      id: "decision",
      kind: "decision",
      title: "Select the preferred authorization path",
      startsOn: "2026-09-15",
      endsOn: "2026-09-15",
      ownerName: "Jordan Lee",
    }),
    node({
      id: "gate",
      kind: "gate",
      subject: "member",
      title: "Evidence package approved",
      startsOn: "2026-10-01",
      endsOn: "2026-10-01",
      sources: [{ section: "Strategy brief", ref: "fact:1" }],
      targetLabel: "Maria Cantwell",
      memberRef: {
        memberId: "member-52480",
        memberName: "Maria Cantwell",
        party: "D",
        state: "WA",
        chamber: "Senate",
        committee: null,
        sourceDirectory: "congress",
      },
    }),
  ];
  const health = {
    score: 84,
    label: "On track" as const,
    coveragePct: 100,
    groundingPct: 100,
    timelinessPct: 75,
    totalNodes: 2,
    ownedNodes: 2,
    totalGates: 1,
    groundedGates: 1,
    datedNodes: 2,
    overdueNodes: 0,
  };
  return {
    snapshotHash: "a".repeat(64),
    asOf: "2026-08-30",
    strategy: {
      id: "strategy-1",
      title: "Authorization Strategy for Program Continuity",
      type: "authorization",
      goal: "Secure durable authorization language.",
      summary: null,
      targetDate: "2026-12-15",
      ownerName: "Avery Cole",
      lastEditedAt: null,
    },
    client: {
      id: "client-1",
      name: "Northstar Systems",
      profile: {
        description: "Northstar develops secure mission systems.",
        productDescription: null,
        profileType: "Enterprise",
        sectorTag: "Aerospace and defense",
        website: null,
      },
      logo: { available: false, supported: false, contentType: null, objectKey: null },
    },
    version: { id: "version-1", createdAt: null, note: null },
    health,
    allLiveHealth: health,
    counts: { nodes: 2, actions: 0, decisions: 1, gates: 1, milestones: 0, risks: 0, artifacts: 0 },
    inclusion: {
      liveNodes: 2,
      includedNodes: 2,
      omittedNodes: 0,
      includedByStatus: { in_progress: 2 },
      omittedByStatus: {},
      placeholderNodes: 0,
    },
    nodes,
    members: [
      {
        memberId: "member-52480",
        memberName: "Maria Cantwell",
        party: "D",
        state: "WA",
        chamber: "Senate",
        committee: null,
        sourceDirectory: "congress",
        name: "Maria Cantwell",
        nodeIds: ["gate"],
      },
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
      documents: [],
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
    memberRef: null,
    ...overrides,
  };
}
