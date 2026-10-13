import {
  clientId,
  day,
  deferred,
  harness,
  hearingRow,
  installHooks,
  now,
  tenantId,
  trackedBill,
  until,
  type TrackedBills,
} from '../../test/fixtures/intelligence-alerts.js';

installHooks();
type TB = never;

it('hearing alerts keep precomputed tracked data authoritative and empty-bill guards before catalog reads', async () => {
  const h = harness({ rows: { 'port:tracked': { total: 1, bills: [trackedBill()] } } });
  expect(
    await h.service.getHearingAlerts(clientId, tenantId, now, until, { total: 0, bills: [] } as TB),
  ).toEqual([]);
  expect(h.ports.tracked).not.toHaveBeenCalled();
  expect(h.callsOf('hearings')).toEqual([]);
  const other = harness();
  expect(await other.service.getHearingAlerts(clientId, tenantId, now, until)).toEqual([]);
  expect(other.ports.tracked).toHaveBeenCalledWith(clientId, tenantId);
  expect(other.ports.tracked.mock.contexts[0]).toBe(other.service);
});

it('hearing alerts await precomputed promises and pin Eastern-date federal geography and query bounds', async () => {
  const held = deferred<TrackedBills>();
  const h = harness({ rows: { hearings: [hearingRow()] } });
  const early = new Date('2026-10-13T02:00:00.000Z');
  const pending = h.service.getHearingAlerts(clientId, tenantId, early, until, held.promise);
  expect(h.callsOf('hearings')).toEqual([]);
  held.resolve({ total: 1, bills: [trackedBill()] } as unknown as TrackedBills);
  expect((await pending)[0]!.id).toBe('hearing:hearing-one');
  expect(h.callsOf('hearings')[0]).toMatchObject({
    scope: 'global',
    args: [
      {
        where: {
          AND: [
            { canonicalHearingId: null },
            { OR: [{ geographicJurisdiction: 'US' }, { geographicJurisdiction: null }] },
            { date: { gte: new Date('2026-10-12T00:00:00.000Z'), lte: until } },
          ],
        },
        orderBy: [{ date: 'asc' }, { time: 'asc' }],
        take: 40,
      },
    ],
  });
  expect(h.ports.tracked).not.toHaveBeenCalled();
});

it('hearing alerts preserve identifier variants, source linkage order, subtitle cap and encoded href', async () => {
  const tracked = {
    total: 4,
    bills: [
      trackedBill({ identifier: '119-hr-1' }),
      trackedBill({ identifier: '119-hr-10' }),
      trackedBill({ identifier: '119-hr-100' }),
      trackedBill({ identifier: '119-hr-1000' }),
    ],
  };
  const h = harness({
    rows: {
      hearings: [
        hearingRow({ title: 'Markup 119-hr-1000' }),
        hearingRow({ id: 'spaced', title: '119 hr 1' }),
        hearingRow({ id: 'dotted', title: '119.HR.1' }),
        hearingRow({ id: 'unrelated', title: 'Unrelated hearing' }),
      ],
    },
  });
  const result = await h.service.getHearingAlerts(
    'client/ one',
    tenantId,
    now,
    until,
    tracked as unknown as TrackedBills,
  );
  expect(result.map((alert) => alert.id)).toEqual([
    'hearing:hearing-one',
    'hearing:spaced',
    'hearing:dotted',
  ]);
  expect(result[0]).toMatchObject({
    subtitle: 'House hearing · 119-hr-1, 119-hr-10, 119-hr-100',
    href: '/intelligence/bills/119-hr-1?clientId=client%2F%20one',
    _typeRank: 2,
  });
});

it.each<{ days: number; severity: string; label: string; urgency: number }>([
  { days: -60, severity: 'critical', label: 'Overdue 60d', urgency: 130 },
  { days: 0, severity: 'critical', label: 'Due today', urgency: 100 },
  { days: 1, severity: 'critical', label: '1d left', urgency: 99 },
  { days: 3, severity: 'notable', label: '3d left', urgency: 97 },
  { days: 8, severity: 'info', label: '8d left', urgency: 92 },
  { days: 150, severity: 'info', label: '150d left', urgency: 0 },
])('hearing alerts preserve date/severity/countdown/rank at $days days', async (example) => {
  const date = new Date(now.getTime() + example.days * day);
  const h = harness({
    rows: { hearings: [hearingRow({ date, title: `119-hr-1 ${'T'.repeat(150)}` })] },
  });
  const countdown = jest.spyOn(h.subject, 'alertCountdownLabel');
  const result = await h.service.getHearingAlerts(clientId, tenantId, now, until, {
    total: 1,
    bills: [trackedBill()],
  } as unknown as TrackedBills);
  expect(result[0]).toMatchObject({
    type: 'hearing',
    severity: example.severity,
    when: date.toISOString(),
    countdownDays: example.days,
    countdownLabel: example.label,
    _urgencyScore: example.urgency,
    _typeRank: 2,
  });
  expect(result[0]!.title).toHaveLength(140);
  expect(countdown).toHaveBeenCalledWith(example.days);
  expect(countdown.mock.contexts[0]).toBe(h.service);
});

it('alert countdown retains nullish, fractional and unvalidated numeric-string behavior', () => {
  const h = harness();
  expect(h.subject.alertCountdownLabel(null)).toBeNull();
  expect(h.subject.alertCountdownLabel(undefined as unknown as number)).toBeNull();
  expect(h.subject.alertCountdownLabel(-1.5)).toBe('Overdue 1.5d');
  expect(h.subject.alertCountdownLabel('0' as unknown as number)).toBe('0d left');
});

it.each(['port:tracked', 'hearings'])(
  'hearing alerts warn and return empty after %s read failures',
  async (operation) => {
    const h = harness({
      rows: { 'port:tracked': { total: 1, bills: [trackedBill()] } },
      errors: { [operation]: 'plain failure' },
    });
    expect(await h.service.getHearingAlerts(clientId, tenantId, now, until)).toEqual([]);
    expect(h.warnings).toEqual([`getHearingAlerts failed for ${clientId}: plain failure`]);
  },
);

it('hearing alerts discard already projected rows when a later date is malformed', async () => {
  const h = harness({
    rows: { hearings: [hearingRow(), hearingRow({ id: 'bad', date: new Date('invalid') })] },
  });
  expect(
    await h.service.getHearingAlerts(clientId, tenantId, now, until, {
      total: 1,
      bills: [trackedBill()],
    } as unknown as TrackedBills),
  ).toEqual([]);
  expect(h.warnings[0]).toContain(`getHearingAlerts failed for ${clientId}:`);
});
