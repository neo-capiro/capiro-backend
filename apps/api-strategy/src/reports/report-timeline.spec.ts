import { describe, expect, it } from "@jest/globals";
import {
  buildTimelineModel,
  timelineHorizonLabel,
} from "./report-timeline.js";
import type { ExecutiveReportSnapshot, ReportNode } from "./report.types.js";

describe("report timeline model", () => {
  it("returns null when no step carries a usable start date", () => {
    expect(buildTimelineModel(snapshot(), [])).toBeNull();
    expect(
      buildTimelineModel(snapshot(), [node({ startsOn: "not-a-date" })]),
    ).toBeNull();
  });

  it("builds month columns spanning the plan plus a forward horizon", () => {
    const model = buildTimelineModel(snapshot(), [
      node({ id: "a", startsOn: "2026-09-01", endsOn: "2026-10-15" }),
      node({ id: "b", startsOn: "2026-11-10", endsOn: "2026-11-10" }),
    ]);
    expect(model).not.toBeNull();
    expect(model!.granularity).toBe("month");
    // asOf 2026-08-30 minus 14 days lands in August; horizon runs to at
    // least the target date (2026-12-15), so Aug..Dec = 5 columns.
    expect(model!.columns.map((column) => column.label)).toEqual([
      "Aug ’26",
      "Sep ’26",
      "Oct ’26",
      "Nov ’26",
      "Dec ’26",
    ]);
    expect(model!.columns.filter((column) => column.isCurrent)).toHaveLength(1);
    expect(model!.columns.find((column) => column.isCurrent)!.label).toBe(
      "Aug ’26",
    );
    expect(timelineHorizonLabel(model!)).toBe("Aug 2026 – Dec 2026");
  });

  it("orders rows chronologically and maps bars onto columns", () => {
    const model = buildTimelineModel(snapshot(), [
      node({ id: "late", startsOn: "2026-11-01", endsOn: "2026-12-01" }),
      node({ id: "early", startsOn: "2026-09-01", endsOn: "2026-10-15" }),
    ])!;
    expect(model.rows.map((row) => row.node.id)).toEqual(["early", "late"]);
    const early = model.rows[0]!;
    expect(early.firstColumn).toBe(1); // September
    expect(early.lastColumn).toBe(2); // October
    expect(early.marker).toBe(false);
    expect(early.startFraction).toBeLessThan(early.endFraction);
    const late = model.rows[1]!;
    expect(late.firstColumn).toBe(3);
    expect(late.lastColumn).toBe(4);
  });

  it("draws single-day steps, milestones and gates as markers", () => {
    const model = buildTimelineModel(snapshot(), [
      node({ id: "day", startsOn: "2026-09-15", endsOn: "2026-09-15" }),
      node({
        id: "gate",
        kind: "gate",
        startsOn: "2026-09-01",
        endsOn: "2026-09-30",
      }),
      node({ id: "span", startsOn: "2026-09-01", endsOn: "2026-09-30" }),
    ])!;
    const byId = new Map(model.rows.map((row) => [row.node.id, row]));
    expect(byId.get("day")!.marker).toBe(true);
    expect(byId.get("gate")!.marker).toBe(true);
    expect(byId.get("gate")!.endFraction).toBe(byId.get("gate")!.startFraction);
    expect(byId.get("span")!.marker).toBe(false);
  });

  it("extends open-ended work to the near-term horizon and flags overdue steps", () => {
    const model = buildTimelineModel(snapshot(), [
      node({ id: "open", startsOn: "2026-08-01", endsOn: null, openEnded: true }),
      node({ id: "late", startsOn: "2026-07-01", endsOn: "2026-08-01" }),
    ])!;
    const byId = new Map(model.rows.map((row) => [row.node.id, row]));
    expect(byId.get("open")!.overdue).toBe(false);
    expect(byId.get("open")!.endFraction).toBeGreaterThan(
      byId.get("open")!.startFraction + 0.2,
    );
    expect(byId.get("late")!.overdue).toBe(true);
    expect(model.columns[0]!.label).toBe("Jul ’26");
  });

  it("switches to quarter columns for long plans and truncates extreme spans", () => {
    const long = buildTimelineModel(snapshot(), [
      node({ id: "a", startsOn: "2026-09-01", endsOn: "2028-03-01" }),
    ])!;
    expect(long.granularity).toBe("quarter");
    expect(long.columns.length).toBeLessThanOrEqual(8);
    expect(long.columns[0]!.label).toMatch(/^Jul–Sep 2026$/);
    expect(long.truncatedHorizon).toBe(false);

    const extreme = buildTimelineModel(snapshot(), [
      node({ id: "a", startsOn: "2026-09-01", endsOn: "2031-01-01" }),
    ])!;
    expect(extreme.granularity).toBe("quarter");
    expect(extreme.columns).toHaveLength(8);
    expect(extreme.truncatedHorizon).toBe(true);
    expect(extreme.rows[0]!.clippedEnd).toBe(true);
    expect(extreme.rows[0]!.endFraction).toBe(1);
  });

  it("respects the row budget and reports omitted steps", () => {
    const nodes = Array.from({ length: 6 }, (_, index) =>
      node({
        id: `n${index}`,
        startsOn: `2026-09-${String(index + 1).padStart(2, "0")}`,
        endsOn: `2026-09-${String(index + 2).padStart(2, "0")}`,
      }),
    );
    const model = buildTimelineModel(snapshot(), nodes, { maxRows: 4 })!;
    expect(model.rows).toHaveLength(4);
    expect(model.omittedRows).toBe(2);
    expect(model.rows.map((row) => row.node.id)).toEqual([
      "n0",
      "n1",
      "n2",
      "n3",
    ]);
  });

  it("places as-of and target markers inside the horizon", () => {
    const model = buildTimelineModel(snapshot(), [
      node({ id: "a", startsOn: "2026-09-01", endsOn: "2026-10-01" }),
    ])!;
    expect(model.asOfFraction).not.toBeNull();
    expect(model.asOfFraction!).toBeGreaterThan(0);
    expect(model.asOfFraction!).toBeLessThan(model.targetFraction!);
    expect(model.targetFraction!).toBeLessThanOrEqual(1);
  });
});

function snapshot(): ExecutiveReportSnapshot {
  return {
    asOf: "2026-08-30",
    strategy: { targetDate: "2026-12-15" },
  } as unknown as ExecutiveReportSnapshot;
}

function node(overrides: Partial<ReportNode>): ReportNode {
  return {
    id: "node",
    kind: "action",
    subject: "deliverable",
    title: "Plan step",
    note: null,
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
