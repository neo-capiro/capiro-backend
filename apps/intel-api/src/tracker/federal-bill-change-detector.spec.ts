import { BillChangeDetectorService } from './bill-change-detector.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { SourceBill, SourceDataRepository } from '../sourcedata/source-data.repository.js';
import type { StateSourceDataRepository } from '../sourcedata/state-source-data.repository.js';

/**
 * Gate B phase b (P0-04, b-11 items 19-20) — federal-rail integration for the
 * alert-relevance explainer, exercised through the REAL watchlistFor() Prisma
 * shape (topics/terms select, priority + typedTerms threading), not just the
 * pure explainMatch unit tests in relevance.spec.ts. Modeled on the same
 * fake-prisma-proxy pattern as state-bill-change-detector.spec.ts, adapted
 * for the federal (`this.source`) partition instead of the state one.
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

interface WatchlistTopicRow {
  id: string;
  label: string;
  priority: string;
}
interface WatchlistTermRow {
  id: string;
  topicId: string;
  termType: string;
  value: string;
}

function makeHarness(
  trackedRows: TrackedBillRow[],
  watchlist: { issueAreas: string[]; topics: WatchlistTopicRow[]; terms: WatchlistTermRow[] } | null,
) {
  const tracked = trackedRows.map((r) => ({ ...r }));
  const alerts: Array<Record<string, unknown>> = [];

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
        ({ where }: { where: { changeType: string; sourceRef: string } }) =>
          Promise.resolve(
            alerts.find((a) => a.changeType === where.changeType && a.sourceRef === where.sourceRef) ?? null,
          ),
      ),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        alerts.push(data);
        return Promise.resolve(data);
      }),
    },
    watchlist: {
      findFirst: jest
        .fn()
        .mockResolvedValue(watchlist ? { issueAreas: watchlist.issueAreas } : null),
    },
    watchlistTopic: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          (watchlist?.topics ?? []).map((t) => ({ id: t.id, label: t.label, priority: t.priority })),
        ),
    },
    watchlistTerm: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          (watchlist?.terms ?? []).map((t) => ({ id: t.id, topicId: t.topicId, termType: t.termType, value: t.value })),
        ),
    },
  };

  const prisma = {
    withSystem: jest.fn((fn: (tx: unknown) => unknown) => fn(tx)),
    withTenant: jest.fn((_t: string, fn: (tx: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;

  return { prisma, tracked, alerts, tx };
}

const BASE_BILL: SourceBill = {
  id: '119-hr-1234',
  congress: 119,
  billType: 'hr',
  billNumber: '1234',
  title: 'A defense modernization act',
  latestActionText: 'Introduced in House',
  latestActionDate: new Date('2025-01-15'),
  policyArea: null,
  subjects: [],
  peCodes: null,
  url: 'https://congress.gov/x',
  status: null,
  statusAt: null,
  updateDateIncludingText: null,
  cosponsorsCount: null,
};

function makeFederalSourceRepo(bill: SourceBill) {
  return {
    getBillsByIds: jest.fn().mockResolvedValue([bill]),
    getBillActionsByIds: jest.fn().mockResolvedValue([]),
    getGoverningRuleVotes: jest.fn().mockResolvedValue([]),
    getNewFiscalNotes: jest.fn().mockResolvedValue([]),
    getCosponsorMomentum: jest.fn().mockResolvedValue([]),
    getUpcomingHearingsForBills: jest.fn().mockResolvedValue([]),
  } as unknown as SourceDataRepository;
}

const NO_STATE_REPO = {
  getStateBillsByIds: jest.fn().mockResolvedValue([]),
  getStateBillActionsByIds: jest.fn().mockResolvedValue([]),
  getStateSponsorMomentum: jest.fn().mockResolvedValue([]),
  getStateVotesForBills: jest.fn().mockResolvedValue([]),
  getUpcomingStateEventsForBills: jest.fn().mockResolvedValue([]),
  getMovedCompanions: jest.fn().mockResolvedValue([]),
  getStateSessionCalendars: jest.fn().mockResolvedValue([]),
} as unknown as StateSourceDataRepository;

const BASELINED_ROW: TrackedBillRow = {
  id: 'tb-fed-1',
  tenantId: 't1',
  clientId: 'c1',
  billId: BASE_BILL.id,
  source: 'congress',
  lastSeenActionText: 'Introduced in House',
  lastSeenActionDate: new Date('2025-01-15'),
  lastSeenAt: new Date('2025-01-16'), // already baselined
  lastSeenStatus: null,
  lastSeenCosponsors: null,
  lastSeenTextDate: null,
  lastSeenFiscalId: null,
  lastSeenHearingKey: null,
};

describe('BillChangeDetectorService — federal rail, P0-04 explainMatch integration', () => {
  it('19. a program_element-only watchlist link produces a non-null whyItMatters and includes the topic label in matchedTags', async () => {
    const movedBill: SourceBill = {
      ...BASE_BILL,
      latestActionText: 'Became Public Law No. 119-1',
      peCodes: ['0604256F'],
    };
    const { prisma, alerts } = makeHarness([BASELINED_ROW], {
      issueAreas: [],
      topics: [{ id: 'topic-1', label: 'PE program', priority: 'med' }],
      terms: [{ id: 'term-1', topicId: 'topic-1', termType: 'program_element', value: '0604256F' }],
    });
    const svc = new BillChangeDetectorService(prisma, makeFederalSourceRepo(movedBill), NO_STATE_REPO);

    const summary = await svc.runDetectionCycle();
    expect(summary.alertsWritten).toBe(1);
    expect(alerts).toHaveLength(1);
    const alert = alerts[0] as { whyItMatters: string | null; evidence: Record<string, unknown> };
    expect(alert.whyItMatters).not.toBeNull();
    expect(alert.evidence.matchedTags).toContain('PE program');
  });

  it('20. a watchlist with only legacy synonym/entity/risk terms produces the same whyItMatters shape as before typed-term routing', async () => {
    const movedBill: SourceBill = {
      ...BASE_BILL,
      title: 'A bill concerning PJM reliability standards',
      latestActionText: 'Became Public Law No. 119-2',
    };
    const { prisma, alerts } = makeHarness([{ ...BASELINED_ROW, id: 'tb-fed-2' }], {
      issueAreas: [],
      topics: [{ id: 'topic-2', label: 'grid', priority: 'med' }],
      terms: [
        { id: 'term-2', topicId: 'topic-2', termType: 'synonym', value: 'load shedding' },
        { id: 'term-3', topicId: 'topic-2', termType: 'entity', value: 'PJM' },
        { id: 'term-4', topicId: 'topic-2', termType: 'risk', value: 'moratorium' },
      ],
    });
    const svc = new BillChangeDetectorService(prisma, makeFederalSourceRepo(movedBill), NO_STATE_REPO);

    const summary = await svc.runDetectionCycle();
    expect(summary.alertsWritten).toBe(1);
    const alert = alerts[0] as { whyItMatters: string | null; evidence: Record<string, unknown> };
    // Pre-routing behavior: 'PJM' is an entity term AND lives in the title, so
    // it is the entity hit — unaffected by phase b's additive typedTerms fold-in
    // (this topic has none), and unaffected by the label-implicit-keyword path
    // (the label 'grid' does not itself appear in the title).
    expect(alert.whyItMatters).toBe('Matches your watchlist term "PJM".');
    expect(alert.evidence.matchedTags).toEqual(['grid']);
  });
});
