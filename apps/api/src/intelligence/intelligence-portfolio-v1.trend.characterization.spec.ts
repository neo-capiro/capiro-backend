import { buildQuarterWindows, foldEngagementTrend } from './intelligence.service.js';
import {
  harness,
  inputOf,
  installHooks,
  tenantId,
} from '../../test/fixtures/intelligence-portfolio.js';

installHooks();

describe('Portfolio quarter window original helpers', () => {
  test('emits six oldest-to-newest local-midnight quarters across year boundaries without changing the clock', () => {
    const clock = new Date(2026, 9, 13, 2, 30);
    const windows = buildQuarterWindows(clock, 6);
    expect(windows.map((window) => window.label)).toEqual([
      "Q3'25",
      "Q4'25",
      "Q1'26",
      "Q2'26",
      "Q3'26",
      "Q4'26",
    ]);
    expect(windows[0]).toEqual({
      label: "Q3'25",
      start: new Date(2025, 6, 1),
      end: new Date(2025, 9, 1),
    });
    expect(windows[5]).toEqual({
      label: "Q4'26",
      start: new Date(2026, 9, 1),
      end: new Date(2027, 0, 1),
    });
    expect(clock.getDate()).toBe(13);
    expect(clock.getHours()).toBe(2);
  });
  test.each([0, -1, NaN])('keeps empty-window count %p without inventing validation', (count) => {
    expect(buildQuarterWindows(new Date(2026, 0, 1), count)).toEqual([]);
  });
  test('keeps half-open boundaries, null/invalid/outside ignores and duplicate row counts', () => {
    const windows = buildQuarterWindows(new Date(2026, 3, 1), 2);
    const original = windows.map((window) => ({ ...window }));
    const value = foldEngagementTrend(
      windows,
      [
        { sentAt: windows[0]!.start },
        { sentAt: windows[1]!.start },
        { sentAt: windows[1]!.start },
        { sentAt: windows[1]!.end },
        { sentAt: null },
        { sentAt: new Date('invalid') },
      ],
      [{ lastMessageAt: windows[0]!.start }, { lastMessageAt: new Date(2025, 11, 31) }],
    );
    expect(
      value.quarters.map((quarter) => [quarter.outreachSends, quarter.clientEmails, quarter.total]),
    ).toEqual([
      [1, 1, 2],
      [2, 0, 2],
    ]);
    expect(value.currentQuarterTotal).toBe(2);
    expect(value.qoqDeltaPct).toBe(0);
    expect(windows).toEqual(original);
  });
});

describe('Portfolio engagement folding defaults and first matching window', () => {
  test('keeps no-prior and zero-prior deltas null and an empty fold fully empty', () => {
    expect(foldEngagementTrend([], [], [])).toEqual({
      quarters: [],
      currentQuarterTotal: 0,
      qoqDeltaPct: null,
    });
    const windows = buildQuarterWindows(new Date(2026, 3, 1), 2);
    expect(
      foldEngagementTrend(windows, [{ sentAt: windows[1]!.start }], []).qoqDeltaPct,
    ).toBeNull();
    expect(
      foldEngagementTrend([windows[1]!], [{ sentAt: windows[1]!.start }], []).qoqDeltaPct,
    ).toBeNull();
  });
  test('computes unrounded fractional and negative quarter deltas', () => {
    const windows = buildQuarterWindows(new Date(2026, 3, 1), 2);
    const prior = Array.from({ length: 3 }, () => ({ sentAt: windows[0]!.start }));
    expect(
      foldEngagementTrend(windows, [...prior, { sentAt: windows[1]!.start }], []).qoqDeltaPct,
    ).toBe((-2 / 3) * 100);
  });
  test('uses the first matching window when caller windows overlap', () => {
    const first = { label: 'first', start: new Date(2026, 0, 1), end: new Date(2026, 6, 1) };
    const second = { label: 'second', start: new Date(2026, 3, 1), end: new Date(2026, 9, 1) };
    expect(
      foldEngagementTrend([first, second], [{ sentAt: new Date(2026, 4, 1) }], []).quarters.map(
        (row) => row.total,
      ),
    ).toEqual([1, 0]);
  });
});

describe('Portfolio engagement trend source scope', () => {
  test('runs two separate tenant reads from the oldest quarter and then the real folder', async () => {
    const h = harness({
      rows: {
        outreach: [{ sentAt: new Date(2026, 9, 1) }],
        mail: [{ lastMessageAt: new Date(2026, 6, 1) }],
      },
    });
    const value = await h.service.getPortfolioEngagementTrend(tenantId);
    expect(inputOf(h, 'outreach')).toEqual({
      where: {
        clientId: { not: null },
        deletedAt: null,
        sentAt: { gte: new Date(2025, 6, 1) },
        client: { status: { not: 'archived' } },
      },
      select: { sentAt: true },
    });
    expect(inputOf(h, 'mail')).toEqual({
      where: {
        clientId: { not: null },
        lastMessageAt: { gte: new Date(2025, 6, 1) },
        client: { status: { not: 'archived' } },
      },
      select: { lastMessageAt: true },
    });
    expect(h.callsOf('outreach')[0]!.transaction).toBe(1);
    expect(h.callsOf('mail')[0]!.transaction).toBe(2);
    expect(value.currentQuarterTotal).toBe(1);
    expect(value.qoqDeltaPct).toBe(0);
  });
  test.each(['outreach', 'mail'])('keeps %s failure fatal', async (operation) => {
    const error = new Error(`${operation} failed`);
    const h = harness({ errors: { [operation]: error } });
    await expect(h.service.getPortfolioEngagementTrend(tenantId)).rejects.toBe(error);
    expect(h.transactions).toHaveLength(2);
  });
});
