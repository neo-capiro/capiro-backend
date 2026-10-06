import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import type { PrismaClient } from '@prisma/client';
import { INTERACTIVE_LEGISCAN_TRANSPORT } from '../external/legiscan/legiscan.client.js';
import {
  STATE_BILL_LIVE_LOOKUP_COST,
  currentLegiscanSessions,
  lookupStateBillLive,
  resetStateBillLiveMisses,
  type StateBillLiveDeps,
} from './meri-state-bill-live.js';

const now = () => new Date('2026-10-06T12:00:00.000Z');

function quotaPrisma(cursors: Array<{ id: string; queriesUsed: number; quotaMonth: string | null }>) {
  const executed: string[] = [];
  const upserts: unknown[] = [];
  const tx = {
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      executed.push(strings.join('?'));
      if (strings.join('?').startsWith('UPDATE state_sync_cursor')) {
        const cursorId = values[values.length - 1] as string;
        const cost = values[1] as number;
        const row = cursors.find((cursor) => cursor.id === cursorId);
        if (row) row.queriesUsed += cost;
      }
      return 1;
    }),
    stateSyncCursor: {
      findMany: jest.fn(async () => cursors.map((cursor) => ({ ...cursor }))),
      upsert: jest.fn(async (args: { where: { id: string }; create: Record<string, unknown> }) => {
        upserts.push(args);
        if (!cursors.some((cursor) => cursor.id === args.where.id))
          cursors.push({ id: args.where.id, queriesUsed: 0, quotaMonth: '2026-10' });
        return args.create;
      }),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient;
  return { prisma, tx, executed, upserts, cursors };
}

function deps(overrides: Partial<StateBillLiveDeps> = {}): StateBillLiveDeps {
  return {
    apiKey: 'legiscan-key',
    now,
    softBudget: 28_000,
    liveMonthlyBudget: 1_000,
    getSessionList: jest.fn(async () => [
      { session_id: 1, year_start: 2023, year_end: 2024, session_name: 'Old', special: 0, prior: 1 },
      { session_id: 3, year_start: 2025, year_end: 2026, session_name: 'Special', special: 1, prior: 0 },
      { session_id: 2, year_start: 2025, year_end: 2026, session_name: 'Regular', special: 0, prior: 0 },
    ]) as unknown as StateBillLiveDeps['getSessionList'],
    getMasterListRaw: jest.fn(async (_key: string, sessionId: number) =>
      sessionId === 2
        ? [
            { bill_id: 70, number: 'HB1233', change_hash: 'a' },
            { bill_id: 77, number: 'HB1234', change_hash: 'b' },
          ]
        : [],
    ) as unknown as StateBillLiveDeps['getMasterListRaw'],
    getBill: jest.fn(async () => ({ bill_id: 77 })) as unknown as StateBillLiveDeps['getBill'],
    persist: jest.fn(async () => 'tx-2025-hb1234'),
    ...overrides,
  };
}

describe('live LegiScan state bill lookup', () => {
  beforeEach(() => resetStateBillLiveMisses());

  it('does nothing without a LegiScan key', async () => {
    const { prisma } = quotaPrisma([]);
    const injected = deps({ apiKey: undefined });
    const previous = process.env.LEGISCAN_API_KEY;
    delete process.env.LEGISCAN_API_KEY;
    try {
      await expect(
        lookupStateBillLive(prisma, { state: 'TX', billNumber: 'hb1234' }, injected),
      ).resolves.toEqual({ kind: 'unavailable', reason: 'not_configured' });
    } finally {
      if (previous !== undefined) process.env.LEGISCAN_API_KEY = previous;
    }
    expect(injected.getSessionList).not.toHaveBeenCalled();
  });

  it('reserves quota, reads the current regular session first, and stores the bill through the sync writers', async () => {
    const quota = quotaPrisma([{ id: 'TX-2', queriesUsed: 100, quotaMonth: '2026-10' }]);
    const injected = deps();

    await expect(
      lookupStateBillLive(quota.prisma, { state: 'tx', billNumber: 'hb1234' }, injected),
    ).resolves.toEqual({ kind: 'found', billKey: 'tx-2025-hb1234' });

    expect(quota.executed[0]).toContain('pg_advisory_xact_lock');
    expect(quota.cursors.find((cursor) => cursor.id === 'meri-live-TX')?.queriesUsed).toBe(
      STATE_BILL_LIVE_LOOKUP_COST,
    );
    expect(quota.upserts[0]).toMatchObject({
      where: { id: 'meri-live-TX' },
      create: { state: 'TX', sessionId: 0, sessionKey: 'meri-live' },
    });
    expect(injected.getSessionList).toHaveBeenCalledWith(
      'legiscan-key',
      'TX',
      INTERACTIVE_LEGISCAN_TRANSPORT,
    );
    expect(injected.getMasterListRaw).toHaveBeenCalledTimes(1);
    expect(injected.getMasterListRaw).toHaveBeenCalledWith(
      'legiscan-key',
      2,
      INTERACTIVE_LEGISCAN_TRANSPORT,
    );
    expect(injected.getBill).toHaveBeenCalledWith(
      'legiscan-key',
      77,
      undefined,
      INTERACTIVE_LEGISCAN_TRANSPORT,
    );
    expect(injected.persist).toHaveBeenCalledWith({ bill_id: 77 }, 'TX');
  });

  it('refuses before any provider call once the shared or live budget is spent', async () => {
    const shared = quotaPrisma([{ id: 'TX-2', queriesUsed: 27_998, quotaMonth: '2026-10' }]);
    const injectedShared = deps();
    await expect(
      lookupStateBillLive(shared.prisma, { state: 'TX', billNumber: 'hb1234' }, injectedShared),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'quota' });
    expect(injectedShared.getSessionList).not.toHaveBeenCalled();

    const live = quotaPrisma([{ id: 'meri-live-CA', queriesUsed: 998, quotaMonth: '2026-10' }]);
    const injectedLive = deps();
    await expect(
      lookupStateBillLive(live.prisma, { state: 'TX', billNumber: 'hb1234' }, injectedLive),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'quota' });
    expect(injectedLive.getSessionList).not.toHaveBeenCalled();
  });

  it('remembers a miss for an hour so a repeat spends no quota', async () => {
    const quota = quotaPrisma([]);
    const injected = deps();
    await expect(
      lookupStateBillLive(quota.prisma, { state: 'TX', billNumber: 'hb9999' }, injected),
    ).resolves.toEqual({ kind: 'not_found' });
    expect(injected.getMasterListRaw).toHaveBeenCalledTimes(2);
    await expect(
      lookupStateBillLive(quota.prisma, { state: 'TX', billNumber: 'HB 9999' }, injected),
    ).resolves.toEqual({ kind: 'not_found' });
    expect(injected.getSessionList).toHaveBeenCalledTimes(1);
    expect(quota.cursors.find((cursor) => cursor.id === 'meri-live-TX')?.queriesUsed).toBe(
      STATE_BILL_LIVE_LOOKUP_COST,
    );
  });

  it('reports a provider failure instead of a missing bill', async () => {
    const quota = quotaPrisma([]);
    const injected = deps({
      getSessionList: jest.fn(async () => {
        throw new Error('LegiScan HTTP 503 for op=getSessionList');
      }) as unknown as StateBillLiveDeps['getSessionList'],
    });
    await expect(
      lookupStateBillLive(quota.prisma, { state: 'TX', billNumber: 'hb1234' }, injected),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'provider_error' });
  });

  it('orders current sessions regular first and drops prior sessions', () => {
    expect(
      currentLegiscanSessions([
        { session_id: 1, year_start: 2023, year_end: 2024, session_name: 'a', special: 0, prior: 1 },
        { session_id: 4, year_start: 2025, year_end: 2026, session_name: 'b', special: 1, prior: 0 },
        { session_id: 5, year_start: 2025, year_end: 2026, session_name: 'c', special: 0, prior: 0 },
      ]).map((session) => session.session_id),
    ).toEqual([5, 4]);
  });
});
