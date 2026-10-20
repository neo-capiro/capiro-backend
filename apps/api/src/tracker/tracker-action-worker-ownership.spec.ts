import { TrackerChangeDetectorService } from './tracker-change-detector.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { TrackerAlertEvent } from './notifications/tracker-notification.types.js';
import type { SummaryInput } from './notifications/tracker-summary.service.js';

const oldDate = new Date('2026-01-01T00:00:00Z');
const hearingDate = new Date('2026-01-02T00:00:00Z');
const passageDate = new Date('2026-01-03T00:00:00Z');

function workerRows() {
  const row = {
    id: 'tracked-1',
    tenantId: 'tenant-1',
    clientId: 'client-1',
    billId: 'hr10-119',
    lastSeenAt: oldDate as Date | null,
    lastSeenActionText: 'Introduced.',
    lastSeenActionDate: oldDate,
  };
  const bill = {
    id: 'hr10-119',
    title: 'Energy Act',
    latestActionText: 'Passed the House.',
    latestActionDate: passageDate,
    url: 'https://source.example/hr10',
    subjects: [],
    policyArea: null,
  };
  return { row, bill };
}

function workerHarness(flags: { history?: boolean; ownerGuard?: boolean } = {}) {
  const { row, bill } = workerRows();
  const trace: string[] = [];
  const trackedBill = {
    findMany: jest.fn(async () => [row]),
    update: jest.fn(async () => {
      trace.push('snapshot');
      return {};
    }),
  };
  const systemTx = {
    trackedBill,
    $queryRawUnsafe: jest.fn(async () => [] as Array<{ tenant_id: string }>),
  };
  const tenantTx = { client: { findFirst: jest.fn(async () => ({ name: 'Energy Client' })) } };
  const prisma = {
    withSystem: jest.fn(async (fn: (tx: typeof systemTx) => unknown) => fn(systemTx)),
    withTenant: jest.fn(async (_tenantId: string, fn: (tx: typeof tenantTx) => unknown) =>
      fn(tenantTx),
    ),
    congressBill: { findMany: jest.fn(async () => [bill]) },
    congressBillAction: {
      findMany: jest.fn(async () => [
        { billId: 'hr10-119', text: 'Hearing held.', date: hearingDate, chamber: 'Senate' },
      ]),
    },
    intelligenceChange: {
      findFirst: jest.fn(async () => null as { id: string } | null),
      create: jest.fn(async () => {
        trace.push('persist');
        return {};
      }),
    },
  };
  const alerts = {
    fanOut: jest.fn(async (_event: TrackerAlertEvent) => {
      trace.push('deliver');
    }),
  };
  const tracker = { getWatchlist: jest.fn() };
  const summaries = {
    summarize: jest.fn(async (_input: SummaryInput) => {
      trace.push('summary');
      return null;
    }),
  };
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'TRACKER_SCAN_ACTION_HISTORY') return flags.history ?? true;
      if (key === 'TRACKER_SINGLE_SENDER_GUARD') return flags.ownerGuard ?? false;
      return false;
    }),
  };
  type Dependencies = ConstructorParameters<typeof TrackerChangeDetectorService>;
  const service = new TrackerChangeDetectorService(
    prisma as unknown as PrismaService,
    alerts as unknown as Dependencies[1],
    tracker as unknown as Dependencies[2],
    config as unknown as Dependencies[3],
    summaries as unknown as Dependencies[4],
  );
  return {
    service,
    row,
    bill,
    trace,
    prisma,
    systemTx,
    trackedBill,
    tenantTx,
    alerts,
    tracker,
    summaries,
  };
}

it('short-circuits an empty cross-tenant scan before all source and delivery reads', async () => {
  const h = workerHarness({ ownerGuard: true });
  h.trackedBill.findMany.mockResolvedValue([]);
  expect(await h.service.runDetectionCycle()).toEqual({
    scanned: 0,
    baseline: 0,
    changed: 0,
    alerted: 0,
    suppressedOwned: 0,
    byType: {},
  });
  expect(h.prisma.withSystem).toHaveBeenCalledTimes(1);
  expect(h.systemTx.$queryRawUnsafe).not.toHaveBeenCalled();
  expect(h.prisma.congressBill.findMany).not.toHaveBeenCalled();
  expect(h.alerts.fanOut).not.toHaveBeenCalled();
});

it('baselines a new tracking row without alerting on historical material events', async () => {
  const h = workerHarness();
  h.trackedBill.findMany.mockResolvedValue([{ ...h.row, lastSeenAt: null }]);
  expect(await h.service.runDetectionCycle()).toEqual({
    scanned: 1,
    baseline: 1,
    changed: 0,
    alerted: 0,
    suppressedOwned: 0,
    byType: {},
  });
  expect(h.trackedBill.update).toHaveBeenCalledWith({
    where: { id: 'tracked-1' },
    data: {
      lastSeenActionText: 'Passed the House.',
      lastSeenActionDate: passageDate,
      lastSeenAt: expect.any(Date),
    },
  });
  expect(h.prisma.intelligenceChange.create).not.toHaveBeenCalled();
  expect(h.summaries.summarize).not.toHaveBeenCalled();
  expect(h.alerts.fanOut).not.toHaveBeenCalled();
});

it('advances routine procedural churn without creating a critical failure alert', async () => {
  const h = workerHarness();
  h.bill.latestActionText = 'Motion to recommit failed.';
  h.prisma.congressBillAction.findMany.mockResolvedValue([]);
  expect(await h.service.runDetectionCycle()).toEqual({
    scanned: 1,
    baseline: 0,
    changed: 0,
    alerted: 0,
    suppressedOwned: 0,
    byType: {},
  });
  expect(h.trace).toEqual(['snapshot']);
  expect(h.prisma.intelligenceChange.create).not.toHaveBeenCalled();
  expect(h.alerts.fanOut).not.toHaveBeenCalled();
});

it('processes only post-watermark history plus a missing rollup, preserving source chamber', async () => {
  const h = workerHarness();
  h.prisma.congressBillAction.findMany.mockResolvedValue([
    { billId: 'hr10-119', text: 'Markup held.', date: oldDate, chamber: 'House' },
    { billId: 'hr10-119', text: 'Hearing held.', date: hearingDate, chamber: 'Senate' },
    { billId: 'hr10-119', text: 'Hearing held again.', date: passageDate, chamber: 'House' },
  ]);
  expect(await h.service.runDetectionCycle()).toEqual({
    scanned: 1,
    baseline: 0,
    changed: 1,
    alerted: 2,
    suppressedOwned: 0,
    byType: { bill_hearing: 1, bill_passed_chamber: 1 },
  });
  expect(h.prisma.congressBillAction.findMany).toHaveBeenCalledWith({
    where: { billId: { in: ['hr10-119'] } },
    select: { billId: true, date: true, text: true, chamber: true },
    orderBy: { date: 'asc' },
  });
  expect(h.summaries.summarize.mock.calls.map(([input]) => input)).toEqual([
    expect.objectContaining({
      label: 'Hearing scheduled',
      actionText: 'Hearing held.',
      chamber: 'Senate',
      actionDate: '2026-01-02',
    }),
    expect.objectContaining({
      label: 'Passed a chamber',
      actionText: 'Passed the House.',
      chamber: 'House',
      actionDate: '2026-01-03',
    }),
  ]);
  expect(h.alerts.fanOut.mock.calls.map(([event]) => event)).toEqual([
    expect.objectContaining({
      tenantId: 'tenant-1',
      clientId: 'client-1',
      changeType: 'bill_hearing',
      severity: 'info',
    }),
    expect.objectContaining({
      tenantId: 'tenant-1',
      clientId: 'client-1',
      changeType: 'bill_passed_chamber',
      severity: 'notable',
    }),
  ]);
  expect(h.trace).toEqual([
    'summary',
    'persist',
    'deliver',
    'summary',
    'persist',
    'deliver',
    'snapshot',
  ]);
  expect(h.prisma.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
  expect(h.tracker.getWatchlist).not.toHaveBeenCalled();
});

it('uses only the rollup when action-history scanning is disabled', async () => {
  const h = workerHarness({ history: false });
  expect(await h.service.runDetectionCycle()).toEqual({
    scanned: 1,
    baseline: 0,
    changed: 1,
    alerted: 1,
    suppressedOwned: 0,
    byType: { bill_passed_chamber: 1 },
  });
  expect(h.prisma.congressBillAction.findMany).not.toHaveBeenCalled();
  expect(h.alerts.fanOut).toHaveBeenCalledWith(
    expect.objectContaining({
      changeType: 'bill_passed_chamber',
      triggerKey: 'floorVote',
      label: 'Passed a chamber',
      tone: 'success',
      severity: 'notable',
      detail: 'Passed the House.',
      actionDate: '2026-01-03',
    }),
  );
  expect(h.trace).toEqual(['summary', 'persist', 'deliver', 'snapshot']);
});

it('leaves the watermark unchanged after delivery failure and safely retries persisted events', async () => {
  const h = workerHarness({ history: false });
  h.alerts.fanOut.mockRejectedValueOnce(new Error('offline delivery seam failure'));
  expect(await h.service.runDetectionCycle()).toEqual({
    scanned: 1,
    baseline: 0,
    changed: 0,
    alerted: 0,
    suppressedOwned: 0,
    byType: {},
  });
  expect(h.prisma.intelligenceChange.create).toHaveBeenCalledTimes(1);
  expect(h.trackedBill.update).not.toHaveBeenCalled();
  h.prisma.intelligenceChange.findFirst.mockResolvedValue({ id: 'existing-change' });
  expect(await h.service.runDetectionCycle()).toEqual({
    scanned: 1,
    baseline: 0,
    changed: 1,
    alerted: 1,
    suppressedOwned: 0,
    byType: { bill_passed_chamber: 1 },
  });
  expect(h.prisma.intelligenceChange.create).toHaveBeenCalledTimes(1);
  expect(h.alerts.fanOut).toHaveBeenCalledTimes(2);
  expect(h.trackedBill.update).toHaveBeenCalledTimes(1);
});

it('suppresses only delivery for an Intel-owned tenant while surfacing and snapshotting the event', async () => {
  const h = workerHarness({ history: false, ownerGuard: true });
  h.systemTx.$queryRawUnsafe.mockResolvedValue([{ tenant_id: 'tenant-1' }]);
  expect(await h.service.runDetectionCycle()).toEqual({
    scanned: 1,
    baseline: 0,
    changed: 1,
    alerted: 0,
    suppressedOwned: 1,
    byType: { bill_passed_chamber: 1 },
  });
  expect(h.systemTx.$queryRawUnsafe).toHaveBeenCalledWith(
    "SELECT tenant_id FROM intel_feature_flag WHERE feature = 'tracker_owner_intel' AND enabled = true",
  );
  expect(h.prisma.withSystem).toHaveBeenCalledTimes(3);
  expect(h.trace).toEqual(['summary', 'persist', 'snapshot']);
  expect(h.alerts.fanOut).not.toHaveBeenCalled();
});

it('aborts before source reads and side effects when sender ownership cannot be read', async () => {
  const h = workerHarness({ ownerGuard: true });
  h.systemTx.$queryRawUnsafe.mockRejectedValue(new Error('offline ownership read failure'));
  await expect(h.service.runDetectionCycle()).rejects.toThrow('offline ownership read failure');
  expect(h.prisma.congressBill.findMany).not.toHaveBeenCalled();
  expect(h.prisma.intelligenceChange.create).not.toHaveBeenCalled();
  expect(h.trackedBill.update).not.toHaveBeenCalled();
  expect(h.alerts.fanOut).not.toHaveBeenCalled();
});

it('does not advance or deliver when the summary seam fails before persistence', async () => {
  const h = workerHarness({ history: false });
  h.summaries.summarize.mockRejectedValue(new Error('offline summary seam failure'));
  expect(await h.service.runDetectionCycle()).toEqual({
    scanned: 1,
    baseline: 0,
    changed: 0,
    alerted: 0,
    suppressedOwned: 0,
    byType: {},
  });
  expect(h.prisma.intelligenceChange.create).not.toHaveBeenCalled();
  expect(h.alerts.fanOut).not.toHaveBeenCalled();
  expect(h.trackedBill.update).not.toHaveBeenCalled();
});

it('does not advance or deliver when event persistence fails', async () => {
  const h = workerHarness({ history: false });
  h.prisma.intelligenceChange.create.mockRejectedValue(new Error('offline storage seam failure'));
  expect(await h.service.runDetectionCycle()).toEqual({
    scanned: 1,
    baseline: 0,
    changed: 0,
    alerted: 0,
    suppressedOwned: 0,
    byType: {},
  });
  expect(h.summaries.summarize).toHaveBeenCalledTimes(1);
  expect(h.alerts.fanOut).not.toHaveBeenCalled();
  expect(h.trackedBill.update).not.toHaveBeenCalled();
});
