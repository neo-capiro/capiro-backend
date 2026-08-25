import { buildQuarterWindows, foldEngagementTrend } from './intelligence.service.js';

describe('buildQuarterWindows', () => {
  it('builds `count` labeled windows, oldest to newest, ending at the quarter containing `now`', () => {
    // Feb 15 2026 falls in Q1'26.
    const now = new Date(2026, 1, 15);
    const windows = buildQuarterWindows(now, 6);
    expect(windows.map((w) => w.label)).toEqual(["Q4'24", "Q1'25", "Q2'25", "Q3'25", "Q4'25", "Q1'26"]);
  });

  it('each window end is an exclusive bound equal to the next window start (contiguous, no gaps/overlap)', () => {
    const now = new Date(2026, 1, 15);
    const windows = buildQuarterWindows(now, 6);
    for (let i = 0; i < windows.length - 1; i++) {
      expect(windows[i]!.end.getTime()).toBe(windows[i + 1]!.start.getTime());
    }
  });

  it('rolls the year boundary correctly on both ends', () => {
    const now = new Date(2026, 1, 15); // Q1'26
    const windows = buildQuarterWindows(now, 6);
    const q4_24 = windows[0]!;
    expect(q4_24.start).toEqual(new Date(2024, 9, 1)); // Oct 1 2024
    expect(q4_24.end).toEqual(new Date(2025, 0, 1)); // Jan 1 2025 (start of Q1'25)
    const q1_26 = windows[5]!;
    expect(q1_26.start).toEqual(new Date(2026, 0, 1)); // Jan 1 2026
    expect(q1_26.end).toEqual(new Date(2026, 3, 1)); // Apr 1 2026 (start of Q2'26)
  });

  it('parameterizes on count', () => {
    const now = new Date(2026, 1, 15);
    expect(buildQuarterWindows(now, 1).map((w) => w.label)).toEqual(["Q1'26"]);
    expect(buildQuarterWindows(now, 3).map((w) => w.label)).toEqual(["Q3'25", "Q4'25", "Q1'26"]);
  });
});

describe('foldEngagementTrend', () => {
  // Fixed 6-quarter window ending Q1'26, shared by every case below so bucket
  // boundaries are identical across tests.
  const now = new Date(2026, 1, 15);
  const quarters = buildQuarterWindows(now, 6);
  const CURRENT = 5; // Q1'26
  const PRIOR = 4; // Q4'25

  it('buckets outreach sends + client emails into the matching quarter and sums per-quarter totals', () => {
    const outreach = [
      { sentAt: new Date(2026, 0, 10) }, // Q1'26
      { sentAt: new Date(2026, 1, 20) }, // Q1'26
      { sentAt: new Date(2026, 2, 1) }, // Q1'26
      { sentAt: new Date(2025, 10, 5) }, // Q4'25
      { sentAt: new Date(2025, 10, 6) }, // Q4'25
    ];
    const mail = [
      { lastMessageAt: new Date(2026, 0, 3) }, // Q1'26
      { lastMessageAt: new Date(2025, 9, 15) }, // Q4'25
      { lastMessageAt: new Date(2025, 11, 20) }, // Q4'25
      { lastMessageAt: new Date(2025, 11, 21) }, // Q4'25
      { lastMessageAt: new Date(2025, 11, 22) }, // Q4'25
    ];

    const result = foldEngagementTrend(quarters, outreach, mail);

    expect(result.quarters[CURRENT]).toMatchObject({
      label: "Q1'26",
      outreachSends: 3,
      clientEmails: 1,
      total: 4,
    });
    expect(result.quarters[PRIOR]).toMatchObject({
      label: "Q4'25",
      outreachSends: 2,
      clientEmails: 4,
      total: 6,
    });
    // Untouched buckets stay honestly zero, not omitted.
    for (const i of [0, 1, 2, 3]) {
      expect(result.quarters[i]).toMatchObject({ outreachSends: 0, clientEmails: 0, total: 0 });
    }
    expect(result.currentQuarterTotal).toBe(4);
    // (4 - 6) / 6 * 100
    expect(result.qoqDeltaPct).not.toBeNull();
    expect(result.qoqDeltaPct as number).toBeCloseTo(-33.333, 2);
  });

  it('never fabricates a percentage from a zero prior-quarter denominator — qoqDeltaPct is null', () => {
    const outreach = [{ sentAt: new Date(2026, 0, 10) }, { sentAt: new Date(2026, 1, 1) }];
    const mail: Array<{ lastMessageAt: Date | null }> = [];

    const result = foldEngagementTrend(quarters, outreach, mail);

    expect(result.quarters[PRIOR]!.total).toBe(0);
    expect(result.currentQuarterTotal).toBe(2);
    expect(result.qoqDeltaPct).toBeNull();
  });

  it('handles empty input: every bucket zero, current total zero, delta null', () => {
    const result = foldEngagementTrend(quarters, [], []);

    expect(result.quarters).toHaveLength(6);
    for (const q of result.quarters) {
      expect(q.outreachSends).toBe(0);
      expect(q.clientEmails).toBe(0);
      expect(q.total).toBe(0);
    }
    expect(result.currentQuarterTotal).toBe(0);
    expect(result.qoqDeltaPct).toBeNull();
  });

  it('skips rows with a null timestamp instead of throwing or miscounting', () => {
    const outreach = [{ sentAt: null }, { sentAt: new Date(2026, 0, 1) }];
    const mail = [{ lastMessageAt: null }];

    const result = foldEngagementTrend(quarters, outreach, mail);

    expect(result.quarters[CURRENT]!.outreachSends).toBe(1);
    expect(result.quarters[CURRENT]!.clientEmails).toBe(0);
  });

  it('serializes quarter start/end as ISO strings in the response', () => {
    const result = foldEngagementTrend(quarters, [], []);
    expect(result.quarters[CURRENT]!.start).toBe(new Date(2026, 0, 1).toISOString());
    expect(result.quarters[CURRENT]!.end).toBe(new Date(2026, 3, 1).toISOString());
  });
});
