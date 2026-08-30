import { describe, expect, it } from "@jest/globals";
import { computeReportHealth } from "./report-health.js";
import type { ReportNode } from "./report.types.js";

describe("computeReportHealth", () => {
  it("matches the planner weighting for ownership, gate grounding, and timeliness", () => {
    const nodes = [
      node({
        id: "a",
        ownerAssigned: true,
        kind: "gate",
        sources: [{ section: "Brief", ref: null }],
      }),
      node({
        id: "b",
        ownerAssigned: false,
        kind: "gate",
        sources: [],
        endsOn: "2026-08-01",
      }),
      node({
        id: "c",
        ownerAssigned: true,
        kind: "action",
        endsOn: "2026-10-01",
      }),
      node({
        id: "d",
        ownerAssigned: false,
        kind: "risk",
        openEnded: true,
        endsOn: null,
      }),
    ];

    expect(
      computeReportHealth(nodes, new Date("2026-08-30T00:00:00.000Z")),
    ).toEqual({
      // .4*(2/4) + .35*(1/2) + .25*(1-1/4) = .5625
      score: 56,
      label: "At risk",
      coveragePct: 50,
      groundingPct: 50,
      timelinessPct: 75,
      totalNodes: 4,
      ownedNodes: 2,
      totalGates: 2,
      groundedGates: 1,
      overdueNodes: 1,
    });
  });

  it("treats past-due active work as overdue while exempting open-ended steps", () => {
    const result = computeReportHealth(
      [
        node({ status: "active", endsOn: "2025-01-01" }),
        node({ id: "b", openEnded: true, endsOn: "2025-01-01" }),
      ],
      new Date("2026-08-30T00:00:00.000Z"),
    );
    expect(result.overdueNodes).toBe(1);
    expect(result.timelinessPct).toBe(50);
  });
});

function node(overrides: Partial<ReportNode> = {}): ReportNode {
  return {
    id: "node",
    kind: "action",
    subject: "deliverable",
    title: "Plan step",
    note: null,
    ownerAssigned: true,
    ownerName: "Owner",
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
