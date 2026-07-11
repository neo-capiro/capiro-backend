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
      findFirst: jest.fn().mockImplementation(
        ({
          where,
        }: {
          where: {
            changeType: string;
            sourceRef: string;
            severity?: string;
            evidence?: { path: string[]; equals: unknown };
          };
        }) =>
          Promise.resolve(
            alerts.find((a) => {
              if (a.changeType !== where.changeType || a.sourceRef !== where.sourceRef) {
                return false;
              }
              // Wave-2 closure: the deadline dedup now also keys on the severity
              // column so an escalating info→critical alert isn't suppressed.
              if (where.severity !== undefined && a.severity !== where.severity) {
                return false;
              }
              if (where.evidence) {
                const evidence = (a.evidence ?? {}) as Record<string, unknown>;
                const key = where.evidence.path[0];
                if (key === undefined) return false;
                if (evidence[key] !== where.evidence.equals) return false;
              }
              return true;
            }) ?? null,
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

function makeStateSourceRepo(
  bill: typeof BASE_BILL,
  calendar?: {
    billKey: string;
    committeeCutoffDate: Date | null;
    crossoverDate: Date | null;
    secondCommitteeCutoffDate: Date | null;
    sineDie: Date | null;
  },
) {
  return {
    getStateBillsByIds: jest.fn().mockResolvedValue([bill]),
    getStateBillActionsByIds: jest.fn().mockResolvedValue([]),
    getStateSponsorMomentum: jest.fn().mockResolvedValue([]),
    getStateVotesForBills: jest.fn().mockResolvedValue([]),
    getUpcomingStateEventsForBills: jest.fn().mockResolvedValue([]),
    getMovedCompanions: jest.fn().mockResolvedValue([]),
    getStateSessionCalendars: jest.fn().mockResolvedValue(calendar ? [calendar] : []),
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

/** N days from now, as a Date at UTC midnight (deadline-risk math is date-only). */
function daysFromNow(n: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

describe('BillChangeDetectorService — state deadline-approaching emitter (Phase 1 M2.3, PD5)', () => {
  const ALREADY_SEEN: TrackedBillRow = {
    id: 'tb-deadline',
    tenantId: 't1',
    clientId: 'c1',
    billId: BASE_BILL.id,
    source: 'state',
    lastSeenActionText: 'Filed',
    lastSeenActionDate: new Date('2025-01-15'),
    lastSeenAt: new Date('2025-01-16'),
    lastSeenStatus: 'introduced', // derived-baselined, still in committee
    lastSeenCosponsors: 2,
    lastSeenTextDate: null,
    lastSeenFiscalId: null,
    lastSeenHearingKey: null,
  };

  it('fires a deadline_approaching alert on the new `deadline` trigger key, with cutoff evidence', async () => {
    const calendar = {
      billKey: BASE_BILL.id,
      committeeCutoffDate: daysFromNow(2),
      crossoverDate: null,
      secondCommitteeCutoffDate: null,
      sineDie: daysFromNow(30),
    };
    const { prisma, alerts } = makeHarness([ALREADY_SEEN]);
    const svc = new BillChangeDetectorService(
      prisma,
      FAKE_CONGRESS_SOURCE,
      makeStateSourceRepo(BASE_BILL, calendar),
    );
    const summary = await svc.runDetectionCycle();

    expect(summary.byType['state_bill_deadline_approaching']).toBe(1);
    const alert = alerts.find((a) => a.changeType === 'state_bill_deadline_approaching') as
      | { evidence: Record<string, unknown>; severity: string }
      | undefined;
    expect(alert).toBeDefined();
    expect(alert!.evidence.cutoffType).toBe('committeeCutoff');
    expect(alert!.severity).toBe('critical'); // 2 days out
  });

  it('does NOT fire when nothing is curated for this state/session (graceful degradation, M2.1)', async () => {
    const { prisma, alerts } = makeHarness([ALREADY_SEEN]);
    const svc = new BillChangeDetectorService(
      prisma,
      FAKE_CONGRESS_SOURCE,
      makeStateSourceRepo(BASE_BILL), // no calendar row at all
    );
    await svc.runDetectionCycle();
    expect(alerts.find((a) => a.changeType === 'state_bill_deadline_approaching')).toBeUndefined();
  });

  it('does NOT fire when the nearest cutoff is more than 14 days out', async () => {
    const calendar = {
      billKey: BASE_BILL.id,
      committeeCutoffDate: daysFromNow(40),
      crossoverDate: null,
      secondCommitteeCutoffDate: null,
      sineDie: daysFromNow(60),
    };
    const { prisma, alerts } = makeHarness([ALREADY_SEEN]);
    const svc = new BillChangeDetectorService(
      prisma,
      FAKE_CONGRESS_SOURCE,
      makeStateSourceRepo(BASE_BILL, calendar),
    );
    await svc.runDetectionCycle();
    expect(alerts.find((a) => a.changeType === 'state_bill_deadline_approaching')).toBeUndefined();
  });

  it('dedups a re-run within the 14-day window (M2-C) — the generic changeType/sourceRef dedup applies', async () => {
    const calendar = {
      billKey: BASE_BILL.id,
      committeeCutoffDate: daysFromNow(5),
      crossoverDate: null,
      secondCommitteeCutoffDate: null,
      sineDie: daysFromNow(30),
    };
    const { prisma, alerts } = makeHarness([ALREADY_SEEN]);
    const svc = new BillChangeDetectorService(
      prisma,
      FAKE_CONGRESS_SOURCE,
      makeStateSourceRepo(BASE_BILL, calendar),
    );
    await svc.runDetectionCycle();
    await svc.runDetectionCycle();
    expect(alerts.filter((a) => a.changeType === 'state_bill_deadline_approaching')).toHaveLength(
      1,
    );
  });

  it('REGRESSION (2026-07-10, W2.1): a later CRITICAL cutoff (crossover) still fires after an earlier NOTABLE cutoff (committeeCutoff) already alerted within the same 14-day window — distinct cutoffs no longer collapse into one dedup slot', async () => {
    const { prisma, alerts } = makeHarness([ALREADY_SEEN]);

    // Cycle 1: still in committee (rank 1) — committeeCutoff is the only
    // relevant candidate, 5 days out -> notable.
    const introducedBill = { ...BASE_BILL, status: 'introduced' };
    const calendar1 = {
      billKey: BASE_BILL.id,
      committeeCutoffDate: daysFromNow(5),
      crossoverDate: null,
      secondCommitteeCutoffDate: null,
      sineDie: daysFromNow(30),
    };
    const svc1 = new BillChangeDetectorService(
      prisma,
      FAKE_CONGRESS_SOURCE,
      makeStateSourceRepo(introducedBill, calendar1),
    );
    await svc1.runDetectionCycle();
    const afterCycle1 = alerts.filter((a) => a.changeType === 'state_bill_deadline_approaching');
    expect(afterCycle1).toHaveLength(1);
    expect((afterCycle1[0]!.evidence as Record<string, unknown>).cutoffType).toBe(
      'committeeCutoff',
    );
    expect(afterCycle1[0]!.severity).toBe('notable');

    // Cycle 2 (still inside the same 14-day dedup window): the bill cleared
    // committee — status moved to 'reported' (rank 2 -> crossover is now the
    // relevant candidate) — and crossover is 2 days out -> critical. Before
    // this fix, the generic (bill, changeType, 14d) dedup would find the
    // cycle-1 row and silently swallow this critical warning.
    const reportedBill = { ...BASE_BILL, status: 'reported' };
    const calendar2 = {
      billKey: BASE_BILL.id,
      committeeCutoffDate: daysFromNow(5),
      crossoverDate: daysFromNow(2),
      secondCommitteeCutoffDate: null,
      sineDie: daysFromNow(30),
    };
    const svc2 = new BillChangeDetectorService(
      prisma,
      FAKE_CONGRESS_SOURCE,
      makeStateSourceRepo(reportedBill, calendar2),
    );
    await svc2.runDetectionCycle();

    const afterCycle2 = alerts.filter((a) => a.changeType === 'state_bill_deadline_approaching');
    expect(afterCycle2).toHaveLength(2); // committeeCutoff (cycle 1) + crossover (cycle 2)
    const crossoverAlert = afterCycle2.find(
      (a) => (a.evidence as Record<string, unknown>).cutoffType === 'crossover',
    );
    expect(crossoverAlert).toBeDefined();
    expect(crossoverAlert!.severity).toBe('critical');
  });

  it('REGRESSION (2026-07-10, Wave-2 closure): the SAME cutoff escalating info→critical still fires the critical <3-day warning — an early info row must NOT swallow it', async () => {
    // The dominant real case (and the one the pre-closure dedup broke): a bill
    // sitting in front of its OWN committee cutoff as it counts down. The cutoff
    // never changes; only the severity band does. Keying the dedup on cutoffType
    // alone let the first (info, ~14d-out) row suppress the later critical (<3d)
    // one for the whole 14-day window. Keying ALSO on severity fixes it.
    const { prisma, alerts } = makeHarness([ALREADY_SEEN]);
    const repo = makeStateSourceRepo(BASE_BILL);
    const svc = new BillChangeDetectorService(prisma, FAKE_CONGRESS_SOURCE, repo);
    const calendars = repo.getStateSessionCalendars as jest.Mock;

    // Cycle 1: committeeCutoff 12 days out -> 'info'.
    calendars.mockResolvedValue([
      {
        billKey: BASE_BILL.id,
        committeeCutoffDate: daysFromNow(12),
        crossoverDate: null,
        secondCommitteeCutoffDate: null,
        sineDie: daysFromNow(40),
      },
    ]);
    await svc.runDetectionCycle();

    // Cycle 2 (same cutoff, still in committee): committeeCutoff now 2 days out
    // -> 'critical'. Same cutoffType, DIFFERENT severity -> must fire.
    calendars.mockResolvedValue([
      {
        billKey: BASE_BILL.id,
        committeeCutoffDate: daysFromNow(2),
        crossoverDate: null,
        secondCommitteeCutoffDate: null,
        sineDie: daysFromNow(40),
      },
    ]);
    await svc.runDetectionCycle();

    const deadlineAlerts = alerts.filter(
      (a) => a.changeType === 'state_bill_deadline_approaching',
    );
    const bySeverity = deadlineAlerts.map((a) => a.severity).sort();
    expect(bySeverity).toEqual(['critical', 'info']); // BOTH fired, same cutoffType
    const critical = deadlineAlerts.find((a) => a.severity === 'critical');
    expect((critical!.evidence as Record<string, unknown>).cutoffType).toBe('committeeCutoff');

    // Cycle 3: still critical, same cutoff, same band -> deduped (no per-cycle spam).
    await svc.runDetectionCycle();
    expect(
      alerts.filter((a) => a.changeType === 'state_bill_deadline_approaching').length,
    ).toBe(2);
  });
});
