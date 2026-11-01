import { describe, expect, it, jest } from '@jest/globals';
import type { PrismaService } from '../prisma/prisma.service.js';
import { ClientReadCache, clientIntelligenceReads } from './client-read-cache.js';
import { IntelligenceManualBillTracking } from './intelligence-manual-bill-tracking.js';
import { IntelligenceTrackedBillDiscovery } from './intelligence-tracked-bill-discovery.js';
import type { TrackedBillPorts } from './intelligence-bill-discovery.shared.js';
import {
  FEDERAL_HEARING_WINDOW_ROWS,
  readFederalHearingWindow,
} from './federal-hearing-window.js';

describe('clientIntelligenceReads registry', () => {
  it('shares one set of caches per facade instance and invalidates both reads for a client', async () => {
    const hostA = {};
    const hostB = {};
    const reads = clientIntelligenceReads(hostA);
    expect(clientIntelligenceReads(hostA)).toBe(reads);
    expect(clientIntelligenceReads(hostB)).not.toBe(reads);
    const key = ClientReadCache.key('tenant-1', 'client-1');
    await reads.trackedBills.remember(key, async () => ({ total: 0, issueCodes: [], bills: [] }));
    await reads.regulationLinks.remember(key, async () => ({ links: [], totalBills: 0, totalRegulations: 0 }));
    const other = ClientReadCache.key('tenant-1', 'client-2');
    await reads.trackedBills.remember(other, async () => ({ total: 1, issueCodes: [], bills: [] }));
    reads.invalidate('tenant-1', 'client-1');
    expect(reads.trackedBills.get(key)).toBeUndefined();
    expect(reads.regulationLinks.get(key)).toBeUndefined();
    expect(reads.trackedBills.get(other)).toEqual({ total: 1, issueCodes: [], bills: [] });
  });
});

describe('IntelligenceTrackedBillDiscovery cache', () => {
  function harness() {
    const reads = clientIntelligenceReads({});
    const terms = { issueCodes: [], keywordTermsExpanded: [], embeddingPartsClean: [], hasCapabilitySignal: false };
    const ports = {
      clientReads: () => reads,
      getManualTrackedBillIds: jest.fn(async () => ['119-hr-1']),
      getClientRelevanceTerms: jest.fn(async () => terms),
      fetchBillsByIds: jest.fn(async (ids: string[]) => ids.map((identifier) => ({
        identifier, title: 't', latestActionDate: null, latestActionText: null, sponsorName: null, sponsorParty: null, subjectNames: [],
      }))),
      findTrackedBillsByEmbeddings: jest.fn(async () => null),
      findTrackedBillsByKeyword: jest.fn(async () => ({ total: 0, bills: [] })),
      embeddingSimilarityFloor: () => 0.5,
      warn: jest.fn(),
    };
    const discovery = new IntelligenceTrackedBillDiscovery({} as PrismaService, ports as unknown as TrackedBillPorts);
    return { discovery, ports, reads };
  }

  it('builds once per (tenant, client) until invalidated, and never caches tenant-less reads', async () => {
    const { discovery, ports, reads } = harness();
    const first = await discovery.getTrackedBills('client-1', 'tenant-1');
    const second = await discovery.getTrackedBills('client-1', 'tenant-1');
    expect(second).toBe(first);
    expect(first.bills.map((b) => b.identifier)).toEqual(['119-hr-1']);
    expect(ports.getManualTrackedBillIds).toHaveBeenCalledTimes(1);
    await discovery.getTrackedBills('client-1', 'tenant-2');
    expect(ports.getManualTrackedBillIds).toHaveBeenCalledTimes(2);
    reads.invalidate('tenant-1', 'client-1');
    const third = await discovery.getTrackedBills('client-1', 'tenant-1');
    expect(third).not.toBe(first);
    expect(ports.getManualTrackedBillIds).toHaveBeenCalledTimes(3);
    await discovery.getTrackedBills('client-1');
    await discovery.getTrackedBills('client-1');
    expect(ports.getManualTrackedBillIds).toHaveBeenCalledTimes(3); // tenant-less path has no manual read
    expect(ports.getClientRelevanceTerms).toHaveBeenCalledTimes(3);
  });

  it('manual tracking writes drop the cached tracked bills for that client', async () => {
    const { discovery, ports, reads } = harness();
    await discovery.getTrackedBills('client-1', 'tenant-1');
    const tx = {
      client: { findFirst: jest.fn(async () => ({ id: 'client-1' })) },
      trackedBill: {
        upsert: jest.fn(async () => ({ id: 'row', billId: '119-hr-2' })),
        deleteMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    const prisma = {
      $queryRaw: jest.fn(async () => [{ id: '119-hr-2' }]),
      withTenant: jest.fn(async (_tenant: string, fn: (value: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaService;
    const manual = new IntelligenceManualBillTracking(prisma, { clientReads: () => reads, fetchBillsByIds: ports.fetchBillsByIds });
    await manual.addTrackedBill('client-1', 'tenant-1', '119-hr-2');
    expect(reads.trackedBills.get(ClientReadCache.key('tenant-1', 'client-1'))).toBeUndefined();
    await discovery.getTrackedBills('client-1', 'tenant-1');
    expect(ports.getManualTrackedBillIds).toHaveBeenCalledTimes(2);
    await manual.removeTrackedBill('client-1', 'tenant-1', '119-hr-2');
    expect(reads.trackedBills.get(ClientReadCache.key('tenant-1', 'client-1'))).toBeUndefined();
  });
});

describe('readFederalHearingWindow', () => {
  it('runs the bounded federal window query once and shares it across callers', async () => {
    const rows = [{ id: 'h1' }];
    const prisma = { committeeHearing: { findMany: jest.fn(async () => rows) } } as unknown as Pick<PrismaService, 'committeeHearing'>;
    const now = new Date('2026-11-01T15:00:00Z');
    const until = new Date('2026-11-22T15:00:00Z');
    const a = await readFederalHearingWindow(prisma, now, until);
    const b = await readFederalHearingWindow(prisma, new Date('2026-11-01T15:00:01Z'), new Date('2026-11-22T15:00:01Z'));
    expect(a).toBe(rows);
    expect(b).toBe(rows);
    const findMany = (prisma.committeeHearing.findMany as unknown as jest.Mock);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      orderBy: [{ date: 'asc' }, { time: 'asc' }],
      take: FEDERAL_HEARING_WINDOW_ROWS,
      where: { AND: [{ canonicalHearingId: null }, expect.anything(), { date: { gte: new Date('2026-11-01T00:00:00Z'), lte: until } }] },
    });
    await readFederalHearingWindow(prisma, now, new Date('2026-11-23T15:00:00Z'));
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});
