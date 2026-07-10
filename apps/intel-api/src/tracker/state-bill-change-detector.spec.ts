import { BillChangeDetectorService } from './bill-change-detector.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { SourceDataRepository } from '../sourcedata/source-data.repository.js';
import type { StateSourceDataRepository } from '../sourcedata/state-source-data.repository.js';

/**
 * State-rail partition tests for BillChangeDetectorService (State Legislation
 * Platform Phase 0 S4). No existing federal detector spec exists in this repo
 * to mirror byte-for-byte (verified: only tracker-tenant-scoping.spec.ts
 * exercises this service, and only for withTenant call-shape), so this spec
 * is authored fresh against the same fake-prisma-proxy pattern that file uses.
 */

interface TrackedBillRow {
  id: string;
  tenantId: string;
  clientId: string;
  billId: string;
  source: string;
  lastSeenActionText: string | null;
  lastSeenActionDate: Date | null;
  lastSeenAt: Date | null;
  lastSeenStatus: string | null;
  lastSeenCosponsors: number | null;
  lastSeenTextDate: Date | null;
  lastSeenFiscalId: string | null;
  lastSeenHearingKey: string | null;
}

function makeHarness(trackedRows: TrackedBillRow[]) {
  const tracked = trackedRows.map((r) => ({ ...r }));
  const alerts: Array<Record<string, unknown>> = [];
  const watchlistFindFirst = jest.fn().mockResolvedValue(null); // no watchlist -> empty WatchlistLike

  const tx = {
    trackedBill: {
      findMany: jest.fn().mockImplementation(() => Promise.resolve(tracked)),
      update: jest
        .fn()
        .mockImplementation(
          ({ where, data }: { where: { id: string }; data: Partial<TrackedBillRow> }) => {
            const row = tracked.find((t) => t.id === where.id);
            if (row) Object.assign(row, data);
            return Promise.resolve(row);
          },
        ),
    },
    intelAlert: {
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: { where: { changeType: string; sourceRef: string } }) =>
          Promise.resolve(
            alerts.find(
              (a) => a.changeType === where.changeType && a.sourceRef === where.sourceRef,
            ) ?? null,
          ),
        ),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        alerts.push(data);
        return Promise.resolve(data);
      }),
    },
    watchlist: { findFirst: watchlistFindFirst },
    watchlistTopic: { findMany: jest.fn().mockResolvedValue([]) },
    watchlistTerm: { findMany: jest.fn().mockResolvedValue([]) },
  };

  const prisma = {
    withSystem: jest.fn((fn: (tx: unknown) => unknown) => fn(tx)),
    withTenant: jest.fn((_t: string, fn: (tx: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;

  return { prisma, tracked, alerts, tx };
}

const BASE_BILL = {
  id: 'tx-2025-hb1234',
  state: 'TX',
  sessionKey: '2025',
  identifier: 'HB 1234',
  title: 'An act relating to a study.',
  status: 'introduced' as string | null,
  statusAt: null as Date | null,
  latestActionText: 'Filed',
  latestActionDate: new Date('2025-01-15'),
  textDate: null as Date | null,
  sponsorCount: 2,
  stateUrl: 'https://capitol.texas.gov/x',
  url: 'https://legiscan.com/x',
  subjects: ['Government Operations'],
};

function makeStateSourceRepo(bill: typeof BASE_BILL) {
  return {
    getStateBillsByIds: jest.fn().mockResolvedValue([bill]),
    getStateBillActionsByIds: jest.fn().mockResolvedValue([]),
    getStateSponsorMomentum: jest.fn().mockResolvedValue([]),
    getStateVotesForBills: jest.fn().mockResolvedValue([]),
    getUpcomingStateEventsForBills: jest.fn().mockResolvedValue([]),
    getMovedCompanions: jest.fn().mockResolvedValue([]),
  } as unknown as StateSourceDataRepository;
}

const FAKE_CONGRESS_SOURCE = {
  getBillsByIds: jest.fn().mockResolvedValue([]),
  getBillActionsByIds: jest.fn().mockResolvedValue([]),
  getGoverningRuleVotes: jest.fn().mockResolvedValue([]),
  getNewFiscalNotes: jest.fn().mockResolvedValue([]),
  getCosponsorMomentum: jest.fn().mockResolvedValue([]),
  getUpcomingHearingsForBills: jest.fn().mockResolvedValue([]),
} as unknown as SourceDataRepository;

describe('BillChangeDetectorService — state partition (DD3)', () => {
  it('baseline: first sighting of a state-tracked bill snapshots but never alerts', async () => {
    const row: TrackedBillRow = {
      id: 'tb-1',
      tenantId: 't1',
      clientId: 'c1',
      billId: BASE_BILL.id,
      source: 'state',
      lastSeenActionText: null,
      lastSeenActionDate: null,
      lastSeenAt: null, // first sighting
      lastSeenStatus: null,
      lastSeenCosponsors: null,
      lastSeenTextDate: null,
      lastSeenFiscalId: null,
      lastSeenHearingKey: null,
    };
    const { prisma, tracked, alerts } = makeHarness([row]);
    const svc = new BillChangeDetectorService(
      prisma,
      FAKE_CONGRESS_SOURCE,
      makeStateSourceRepo(BASE_BILL),
    );
    const summary = await svc.runDetectionCycle();

    expect(summary.baseline).toBe(1);
    expect(summary.alertsWritten).toBe(0);
    expect(alerts).toHaveLength(0);
    expect(tracked[0]?.lastSeenAt).not.toBeNull();
    expect(tracked[0]?.lastSeenStatus).toBe('introduced');
  });

  it('fires exactly once on a status transition, stamps jurisdiction + state displayNum, and dedups a re-run', async () => {
    const alreadySeen: TrackedBillRow = {
      id: 'tb-2',
      tenantId: 't1',
      clientId: 'c1',
      billId: BASE_BILL.id,
      source: 'state',
      lastSeenActionText: 'Filed',
      lastSeenActionDate: new Date('2025-01-15'),
      lastSeenAt: new Date('2025-01-16'), // already baselined
      lastSeenStatus: 'introduced', // derived-baselined
      lastSeenCosponsors: 2,
      lastSeenTextDate: null,
      lastSeenFiscalId: null,
      lastSeenHearingKey: null,
    };
    const movedBill = { ...BASE_BILL, status: 'passed_chamber', statusAt: new Date('2025-02-01') };
    const { prisma, alerts } = makeHarness([alreadySeen]);
    const svc = new BillChangeDetectorService(
      prisma,
      FAKE_CONGRESS_SOURCE,
      makeStateSourceRepo(movedBill),
    );

    const summary = await svc.runDetectionCycle();
    expect(summary.alertsWritten).toBe(1);
    expect(summary.byType['state_bill_passed_chamber']).toBe(1);
    expect(alerts).toHaveLength(1);
    const alert = alerts[0] as { sourceType: string; evidence: Record<string, unknown> };
    expect(alert.sourceType).toBe('state_bill');
    expect(alert.evidence.jurisdiction).toBe('TX');
    expect(alert.evidence.displayNum).toBe('TX HB 1234');

    // Re-run against the SAME (now-advanced) watermark: no new event fires
    // because the row's own watermark already reflects the new status —
    // this proves the watermark-advance path, distinct from dedup.
    const summary2 = await svc.runDetectionCycle();
    expect(summary2.alertsWritten).toBe(0);
    expect(alerts).toHaveLength(1);
  });

  it('REGRESSION (2026-07-10 hot-fix): a veto fires exactly ONE alert, correctly labeled "Vetoed" — not a second mislabeled "Failed / rejected" action-text duplicate', async () => {
    const alreadySeen: TrackedBillRow = {
      id: 'tb-veto',
      tenantId: 't1',
      clientId: 'c1',
      billId: BASE_BILL.id,
      source: 'state',
      lastSeenActionText: 'Filed',
      lastSeenActionDate: new Date('2025-01-15'),
      lastSeenAt: new Date('2025-01-16'),
      lastSeenStatus: 'to_governor', // derived-baselined
      lastSeenCosponsors: 2,
      lastSeenTextDate: null,
      lastSeenFiscalId: null,
      lastSeenHearingKey: null,
    };
    // Both the coded status AND the action text advance together — the
    // exact scenario that double-emitted before the fix: the coded
    // classifier (classifyStateStatusChange) fires 'state_bill_vetoed', and
    // the action-text classifier (classifyChange) ALSO matches the generic
    // /veto/ pattern and would fire 'bill_failed' ("Failed / rejected") for
    // the SAME transition.
    const vetoedBill = {
      ...BASE_BILL,
      status: 'vetoed',
      statusAt: new Date('2025-06-01'),
      latestActionText: 'Vetoed by the Governor',
      latestActionDate: new Date('2025-06-01'),
    };
    const { prisma, alerts } = makeHarness([alreadySeen]);
    const svc = new BillChangeDetectorService(
      prisma,
      FAKE_CONGRESS_SOURCE,
      makeStateSourceRepo(vetoedBill),
    );

    const summary = await svc.runDetectionCycle();
    expect(summary.alertsWritten).toBe(1);
    expect(alerts).toHaveLength(1);
    expect(summary.byType['state_bill_vetoed']).toBe(1);
    expect(summary.byType['bill_failed']).toBeUndefined();
    const alert = alerts[0] as { changeType: string; title: string };
    expect(alert.changeType).toBe('state_bill_vetoed');
    expect(alert.title).not.toMatch(/Failed \/ rejected/i);
  });

  it('REGRESSION (2026-07-10 hot-fix): an unrelated action-text signal (hearing scheduled) on the SAME cycle as a status transition is NOT suppressed — only the colliding triggerKey is dropped', async () => {
    const alreadySeen: TrackedBillRow = {
      id: 'tb-hearing',
      tenantId: 't1',
      clientId: 'c1',
      billId: BASE_BILL.id,
      source: 'state',
      lastSeenActionText: 'Filed',
      lastSeenActionDate: new Date('2025-01-15'),
      lastSeenAt: new Date('2025-01-16'),
      lastSeenStatus: 'introduced',
      lastSeenCosponsors: 2,
      lastSeenTextDate: null,
      lastSeenFiscalId: null,
      lastSeenHearingKey: null,
    };
    const reportedBill = {
      ...BASE_BILL,
      status: 'reported', // classifyStateStatusChange -> triggerKey 'committeeVote'
      statusAt: new Date('2025-02-01'),
      latestActionText: 'Hearing scheduled for March 3', // classifyChange -> triggerKey 'hearing' (no collision)
      latestActionDate: new Date('2025-02-01'),
    };
    const { prisma, alerts } = makeHarness([alreadySeen]);
    const svc = new BillChangeDetectorService(
      prisma,
      FAKE_CONGRESS_SOURCE,
      makeStateSourceRepo(reportedBill),
    );

    const summary = await svc.runDetectionCycle();
    expect(summary.alertsWritten).toBe(2);
    expect(alerts).toHaveLength(2);
    expect(summary.byType['state_bill_reported']).toBe(1);
    expect(summary.byType['bill_hearing']).toBe(1);
  });

  it('does not touch the congress partition when only state rows are tracked', async () => {
    const row: TrackedBillRow = {
      id: 'tb-3',
      tenantId: 't1',
      clientId: 'c1',
      billId: BASE_BILL.id,
      source: 'state',
      lastSeenActionText: null,
      lastSeenActionDate: null,
      lastSeenAt: null,
      lastSeenStatus: null,
      lastSeenCosponsors: null,
      lastSeenTextDate: null,
      lastSeenFiscalId: null,
      lastSeenHearingKey: null,
    };
    const { prisma } = makeHarness([row]);
    const svc = new BillChangeDetectorService(
      prisma,
      FAKE_CONGRESS_SOURCE,
      makeStateSourceRepo(BASE_BILL),
    );
    await svc.runDetectionCycle();
    expect(FAKE_CONGRESS_SOURCE.getBillsByIds).not.toHaveBeenCalled();
  });
});
