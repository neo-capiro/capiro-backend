import { describe, expect, it, jest } from '@jest/globals';
import type { PrismaService } from '../prisma/prisma.service.js';
import { collectProfileV1Sources } from './client-profile-v1-sources.js';
import { PROFILE_V1_SOURCE_CONCURRENCY, settleWithConcurrency } from './profile-v1-source-limiter.js';
import type { ProfileV1Context, ProfileV1Ports } from './client-profile-v1.shared.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('settleWithConcurrency', () => {
  it('starts at most `limit` sources at once, in order, and settles every position', async () => {
    const gates = Array.from({ length: 6 }, () => deferred<string>());
    const started: number[] = [];
    const starts = gates.map((gate, index) => () => { started.push(index); return gate.promise; });
    const settled = settleWithConcurrency(starts, 2);
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    gates[1]!.resolve('one');
    await Promise.resolve(); await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    gates[0]!.reject(new Error('zero failed'));
    gates[2]!.resolve('two');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    gates[3]!.resolve('three'); gates[4]!.resolve('four');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
    gates[5]!.resolve('five');
    const results = await settled;
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
    expect(results[0]).toMatchObject({ status: 'rejected', reason: new Error('zero failed') });
    expect(results.slice(1).map((r) => (r as PromiseFulfilledResult<string>).value)).toEqual(['one', 'two', 'three', 'four', 'five']);
  });

  it('handles an empty list and rejects a non-positive limit', async () => {
    await expect(settleWithConcurrency([], 3)).resolves.toEqual([]);
    await expect(settleWithConcurrency([async () => 1], 0)).rejects.toThrow(RangeError);
  });
});

describe('collectProfileV1Sources', () => {
  const now = new Date('2026-11-01T12:00:00Z');
  const context: ProfileV1Context = {
    client: { id: 'client-1', name: 'Synthetic client' }, clientId: 'client-1', tenantId: 'tenant-1', userId: 'user-1',
    now, day14: new Date('2026-11-15T12:00:00Z'), day21: new Date('2026-11-22T12:00:00Z'),
    day7: new Date('2026-10-25T12:00:00Z'), day30: new Date('2026-10-02T12:00:00Z'),
  };

  function harness() {
    let openTransactions = 0;
    let peakTransactions = 0;
    const tx = new Proxy({}, {
      get: () => ({ findMany: async () => { await new Promise((r) => setTimeout(r, 2)); return []; } }),
    });
    const prisma = {
      withTenant: jest.fn(async (_tenant: string, fn: (value: unknown) => Promise<unknown>) => {
        openTransactions += 1; peakTransactions = Math.max(peakTransactions, openTransactions);
        try { return await fn(tx); } finally { openTransactions -= 1; }
      }),
      committeeHearing: { findMany: jest.fn(async () => [{ id: 'h1', title: 'Markup of HR 1234', date: now }]) },
    };
    const tracked = { total: 1, issueCodes: ['DEF'], bills: [{ identifier: '119-hr-1234', subjectNames: [] }] };
    const resolved = <T>(value: T) => jest.fn(async () => value);
    const ports = {
      getClientProfile: resolved({ name: 'Synthetic client' }),
      getLobbyingRoi: resolved({}), getFecMoneyFlow: resolved({}), getDistrictNexus: resolved({ capabilities: [] }),
      getTrackedBills: jest.fn(async () => { await new Promise((r) => setTimeout(r, 5)); return tracked; }),
      getBillRegulationLinks: jest.fn(async (_c: string, _t: string, pre: Promise<typeof tracked>) => ({ links: [], totalBills: (await pre).bills.length, totalRegulations: 0 })),
      getKnowledgeGraph: resolved({}), computeEngagementHealth: resolved(null), getExStaffers: resolved({ lobbyists: [] }),
      getCommentPeriodAlerts: resolved({ alerts: [] }), getChanges: resolved([]), getDistrictNexusSpend: resolved({ linked: false }),
      getOverdueCommentAlerts: resolved([]), getCompetitorLdaAlerts: resolved([]), getContractAwardAlerts: resolved([]),
      getHearingAlerts: jest.fn(async (_c: string, _t: string, _n: Date, _u: Date, pre: Promise<typeof tracked>) =>
        [{ tracked: (await pre).total }]),
      getClientRelevantRegulations: resolved([]),
      withSourceBudget: jest.fn(<T>(_label: string, _client: string, work: Promise<T>) => work),
      warn: jest.fn(),
    } as unknown as ProfileV1Ports;
    return { prisma: prisma as unknown as PrismaService, ports, peak: () => peakTransactions, raw: { prisma, ports } };
  }

  it('bounds concurrent tenant transactions to the source concurrency', async () => {
    const h = harness();
    const { settled, settledSourceLabels } = await collectProfileV1Sources(h.prisma, h.ports, context);
    expect(settled).toHaveLength(settledSourceLabels.length);
    expect(settled.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(h.peak()).toBeLessThanOrEqual(PROFILE_V1_SOURCE_CONCURRENCY);
    expect(h.peak()).toBeGreaterThan(0);
  });

  it('reads tracked bills once and shares them with dependent sources; the hearing window is read once', async () => {
    const h = harness();
    const { settled } = await collectProfileV1Sources(h.prisma, h.ports, context, 3);
    const ports = h.raw.ports as unknown as { getTrackedBills: jest.Mock; getHearingAlerts: jest.Mock; getBillRegulationLinks: jest.Mock; withSourceBudget: jest.Mock };
    expect(ports.getTrackedBills).toHaveBeenCalledTimes(1);
    expect(h.raw.prisma.committeeHearing.findMany).toHaveBeenCalledTimes(1);
    expect(ports.getBillRegulationLinks).toHaveBeenCalledTimes(1);
    expect((settled[5] as PromiseFulfilledResult<{ totalBills: number }>).value.totalBills).toBe(1);
    expect((settled[11] as PromiseFulfilledResult<unknown[]>).value).toHaveLength(1);
    expect((settled[23] as PromiseFulfilledResult<unknown[]>).value).toEqual([{ tracked: 1 }]);
    expect(ports.getHearingAlerts.mock.calls[0]).toHaveLength(5);
    const budgetLabels = ports.withSourceBudget.mock.calls.map((call) => call[0]);
    expect(budgetLabels).toHaveLength(25);
    expect(budgetLabels[4]).toBe('trackedBills');
    expect(budgetLabels[23]).toBe('hearingAlerts');
  });

  it('keeps the positional contract: a failing source settles only its own slot', async () => {
    const h = harness();
    (h.raw.ports as unknown as { getExStaffers: jest.Mock<() => Promise<unknown>> }).getExStaffers.mockRejectedValue(new Error('statement timeout'));
    const { settled } = await collectProfileV1Sources(h.prisma, h.ports, context);
    expect(settled[8]).toMatchObject({ status: 'rejected' });
    expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
});
