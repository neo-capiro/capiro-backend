import { describe, expect, it } from "@jest/globals";
import { nodeDetail, roadmap } from "./report-content.js";
import {
  includeNodeForAudience,
  normalizeReportOptions,
  reportStatusForAudience,
} from "./report-policy.js";
import { extractTargetLabel, stableJson } from "./report-snapshot.service.js";
import type { ExecutiveReportSnapshot, ReportNode } from "./report.types.js";

describe("executive report policy", () => {
  it("forces every internal-only surface off for a client report", () => {
    expect(
      normalizeReportOptions({
        format: "docx",
        audience: "client",
        useClientLogo: true,
        includeRoadmap: true,
        includeEvidenceAppendix: true,
        includeChangeLog: true,
        includeInternalNotes: true,
        includeAgentHistory: true,
      }),
    ).toMatchObject({
      audience: "client",
      includeChangeLog: false,
      includeInternalNotes: false,
      includeAgentHistory: false,
    });
  });

  it("keeps explicitly requested governance surfaces for an internal report", () => {
    expect(
      normalizeReportOptions({
        format: "pptx",
        audience: "internal",
        includeChangeLog: true,
        includeInternalNotes: true,
        includeAgentHistory: true,
      }),
    ).toMatchObject({
      includeChangeLog: true,
      includeInternalNotes: true,
      includeAgentHistory: true,
      useClientLogo: true,
      includeRoadmap: true,
      includeEvidenceAppendix: true,
    });
  });

  it("includes only committed delivery states for clients", () => {
    expect(includeNodeForAudience("suggested", "client")).toBe(false);
    expect(includeNodeForAudience("draft", "client")).toBe(false);
    expect(includeNodeForAudience("internal_review", "client")).toBe(false);
    expect(includeNodeForAudience("in_progress", "client")).toBe(true);
    expect(includeNodeForAudience("active", "client")).toBe(true);
    expect(includeNodeForAudience("suggested", "internal")).toBe(true);
    expect(reportStatusForAudience("internal_review", "client")).toBe(
      "internal_review",
    );
    expect(reportStatusForAudience("internal_review", "internal")).toBe(
      "internal_review",
    );
  });

  it("never exposes an opaque target id as a display label", () => {
    expect(extractTargetLabel({ memberId: "opaque-directory-id" })).toBeNull();
    expect(
      extractTargetLabel({ memberId: "opaque", memberName: "Sen. Rivera" }),
    ).toBe("Sen. Rivera");
  });

  it("omits notes from client-facing node detail", () => {
    const snapshot = minimalSnapshot();
    const detail = nodeDetail(snapshot, snapshot.nodes[0]!);
    expect(detail).not.toContain("Internal note");
    expect(detail).not.toContain("sensitive practitioner note");
  });

  it("separates overdue work from the forward-looking roadmap", () => {
    const snapshot = minimalSnapshot();
    const groups = roadmap(snapshot);
    expect(groups[0]).toMatchObject({
      label: "Overdue / needs attention",
      nodes: [{ id: "node-1" }],
    });
    expect(groups[1]?.label).toBe("Now & next 30 days");
  });

  it("places accepted active work past its due date in the overdue lane", () => {
    const snapshot = minimalSnapshot();
    snapshot.nodes[0]!.status = "active";
    expect(roadmap(snapshot)[0]?.nodes).toEqual([
      expect.objectContaining({ id: "node-1" }),
    ]);
  });

  it("stable-sorts object keys before hashing input", () => {
    expect(stableJson({ z: 1, a: { d: 4, b: 2 } })).toBe(
      '{"a":{"b":2,"d":4},"z":1}',
    );
  });
});

function minimalSnapshot(): ExecutiveReportSnapshot {
  const node: ReportNode = {
    id: "node-1",
    kind: "action",
    subject: "deliverable",
    title: "Prepare leadership brief",
    note: "sensitive practitioner note",
    ownerAssigned: true,
    ownerName: "Alex Morgan",
    status: "in_progress",
    startsOn: "2026-07-01",
    endsOn: "2026-07-15",
    openEnded: false,
    dependsOnIds: [],
    sources: [],
    targetLabel: null,
  };
  return {
    snapshotHash: "hash",
    asOf: "2026-08-30",
    strategy: {
      id: "strategy-1",
      title: "Strategy",
      type: "authorization",
      goal: "Goal",
      summary: null,
      targetDate: null,
      ownerName: "Alex Morgan",
      lastEditedAt: null,
    },
    client: {
      id: "client-1",
      name: "Client",
      logo: {
        available: false,
        supported: false,
        contentType: null,
        objectKey: null,
      },
    },
    version: { id: null, createdAt: null, note: null },
    health: {
      score: 65,
      label: "Needs attention",
      coveragePct: 100,
      groundingPct: 100,
      timelinessPct: 0,
      totalNodes: 1,
      ownedNodes: 1,
      totalGates: 0,
      groundedGates: 0,
      overdueNodes: 1,
    },
    allLiveHealth: {
      score: 65,
      label: "Needs attention",
      coveragePct: 100,
      groundingPct: 100,
      timelinessPct: 0,
      totalNodes: 1,
      ownedNodes: 1,
      totalGates: 0,
      groundedGates: 0,
      overdueNodes: 1,
    },
    counts: {
      nodes: 1,
      actions: 1,
      decisions: 0,
      gates: 0,
      milestones: 0,
      risks: 0,
      artifacts: 0,
    },
    inclusion: {
      liveNodes: 1,
      includedNodes: 1,
      omittedNodes: 0,
      includedByStatus: { in_progress: 1 },
      omittedByStatus: {},
      placeholderNodes: 0,
    },
    nodes: [node],
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
      includeEvidenceAppendix: false,
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
