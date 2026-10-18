import { describe, expect, it } from "@jest/globals";
import {
  buildColumns,
  columnIndexFor,
  endOfMonth,
  monthsBetween,
  parseDay,
  startOfMonth,
  startOfQuarter,
  timelineHorizonLabel,
} from "./report-timeline-calendar.js";
import {
  parseDay as timelineParseDay,
} from "./report-timeline.js";

describe("report timeline UTC calendar", () => {
  it("keeps month boundaries and current-column placement across a year", () => {
    const start = Date.UTC(2026, 11, 1);
    const end = Date.UTC(2027, 1, 1) - 1;
    const columns = buildColumns(start, end, "month", Date.UTC(2027, 0, 1));

    expect(columns.map(({ key, label, isCurrent }) => ({ key, label, isCurrent }))).toEqual([
      { key: "2026-12", label: "Dec ’26", isCurrent: false },
      { key: "2027-01", label: "Jan ’27", isCurrent: true },
    ]);
    expect(columnIndexFor(columns, start - 1)).toBe(0);
    expect(columnIndexFor(columns, Date.UTC(2026, 11, 31, 23, 59, 59, 999))).toBe(0);
    expect(columnIndexFor(columns, Date.UTC(2027, 0, 1))).toBe(1);
    expect(columnIndexFor(columns, end + 1)).toBe(1);
  });

  it("keeps inclusive quarter and leap-month end dates", () => {
    const start = Date.UTC(2026, 9, 1);
    const end = Date.UTC(2027, 1, 16) - 1;
    const columns = buildColumns(start, end, "quarter", Date.UTC(2026, 11, 15));

    expect(columns.map((column) => column.label)).toEqual([
      "Oct–Dec 2026",
      "Jan–Feb 2027",
    ]);
    expect(columns.map((column) => column.isCurrent)).toEqual([true, false]);
    expect(columns[1]!.endMs).toBe(end);
    const leapDay = Date.UTC(2028, 1, 29);
    expect(startOfMonth(leapDay)).toBe(Date.UTC(2028, 1, 1));
    expect(endOfMonth(leapDay)).toBe(Date.UTC(2028, 2, 1) - 1);
    expect(startOfQuarter(leapDay)).toBe(Date.UTC(2028, 0, 1));
    expect(monthsBetween(Date.UTC(2027, 11, 1), leapDay)).toBe(3);
  });

  it("keeps public date parsing and horizon label output", () => {
    expect(timelineParseDay).toBe(parseDay);
    expect(parseDay("2028-02-29T19:30:00Z")).toBe(Date.UTC(2028, 1, 29));
    expect(parseDay(null)).toBeNull();
    expect(parseDay("bad-date")).toBeNull();
    expect(
      timelineHorizonLabel({
        startMs: Date.UTC(2026, 7, 1),
        endMs: Date.UTC(2027, 2, 31),
      }),
    ).toBe("Aug 2026 – Mar 2027");
  });
});
