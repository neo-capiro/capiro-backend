import { IntelAlertService, type DedupeStateAlertCandidate } from './intel-alert.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * dedupeStateActionAlerts — the D-2 cleanup for the 2026-07-10 state-rail
 * double-emit hot-fix (bill-change-detector.service.ts). Report-first,
 * apply-gated, never touches a human-reviewed row.
 */

interface FakeAlert {
  id: string;
  tenantId: string;
  clientId: string;
  sourceRef: string;
  changeType: string | null;
  title: string;
  status: string;
  createdAt: Date;
}

function makeHarness(rows: FakeAlert[]) {
  const store = rows.map((r) => ({ ...r }));
  const updateManyArgs: Array<{ where: unknown; data: unknown }> = [];
  const tx = {
    intelAlert: {
      findMany: jest.fn().mockImplementation(() => Promise.resolve(store)),
      updateMany: jest
        .fn()
        .mockImplementation(
          ({
            where,
            data,
          }: {
            where: { id: { in: string[] }; status: string };
            data: { status: string };
          }) => {
            updateManyArgs.push({ where, data });
            let count = 0;
            for (const row of store) {
              if (where.id.in.includes(row.id) && row.status === where.status) {
                row.status = data.status;
                count += 1;
              }
            }
            return Promise.resolve({ count });
          },
        ),
    },
  };
  const prisma = {
    withSystem: jest.fn((fn: (tx: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  return { prisma, store, updateManyArgs };
}

function alert(overrides: Partial<FakeAlert>): FakeAlert {
  return {
    id: 'a1',
    tenantId: 't1',
    clientId: 'c1',
    sourceRef: 'tx-2025-hb1234',
    changeType: 'state_bill_vetoed',
    title: 'TX HB 1234: Vetoed',
    status: 'new',
    createdAt: new Date('2025-06-01T12:00:00Z'),
    ...overrides,
  };
}

describe('IntelAlertService.dedupeStateActionAlerts', () => {
  it('DRY RUN: finds a same-cycle coded+action-text pair as a candidate but does not mutate', async () => {
    const rows = [
      alert({
        id: 'coded-1',
        changeType: 'state_bill_vetoed',
        createdAt: new Date('2025-06-01T12:00:00Z'),
      }),
      alert({
        id: 'text-1',
        changeType: 'bill_failed',
        title: 'TX HB 1234: Failed / rejected',
        createdAt: new Date('2025-06-01T12:00:03Z'), // 3s later — same cycle
      }),
    ];
    const { prisma, store } = makeHarness(rows);
    const svc = new IntelAlertService(prisma, {} as never, {} as never, {} as never, {} as never);
    const log = jest.fn();

    const r = await svc.dedupeStateActionAlerts({ apply: false }, log);

    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0] as DedupeStateAlertCandidate;
    expect(c.keptChangeType).toBe('state_bill_vetoed');
    expect(c.suppressChangeType).toBe('bill_failed');
    expect(r.suppressed).toBe(0);
    // no mutation in dry-run
    expect(store.find((s) => s.id === 'text-1')?.status).toBe('new');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('DEDUPE_CANDIDATE'));
  });

  it('APPLY: suppresses the action-text duplicate, keeps the coded alert untouched', async () => {
    const rows = [
      alert({ id: 'coded-1', changeType: 'state_bill_vetoed' }),
      alert({
        id: 'text-1',
        changeType: 'bill_failed',
        createdAt: new Date('2025-06-01T12:00:03Z'),
      }),
    ];
    const { prisma, store } = makeHarness(rows);
    const svc = new IntelAlertService(prisma, {} as never, {} as never, {} as never, {} as never);

    const r = await svc.dedupeStateActionAlerts({ apply: true }, jest.fn());

    expect(r.suppressed).toBe(1);
    expect(store.find((s) => s.id === 'text-1')?.status).toBe('suppressed');
    expect(store.find((s) => s.id === 'coded-1')?.status).toBe('new');
  });

  it('does NOT pair two distinct historical events sharing a triggerKey weeks apart (not a bug — legitimate separate events)', async () => {
    const rows = [
      alert({
        id: 'rule-reported',
        changeType: 'bill_rule_reported',
        createdAt: new Date('2025-02-01T00:00:00Z'),
      }),
      alert({
        id: 'passed-later',
        changeType: 'state_bill_passed_chamber',
        createdAt: new Date('2025-04-15T00:00:00Z'), // months later, distinct event
      }),
    ];
    const { prisma } = makeHarness(rows);
    const svc = new IntelAlertService(prisma, {} as never, {} as never, {} as never, {} as never);

    const r = await svc.dedupeStateActionAlerts({ apply: false }, jest.fn());
    expect(r.candidates).toHaveLength(0);
  });

  it('never touches a row a human already reviewed/sent/dismissed (status != new is excluded from the apply update, even if selected as a candidate)', async () => {
    const rows = [
      alert({ id: 'coded-1', changeType: 'state_bill_vetoed' }),
      alert({
        id: 'text-1',
        changeType: 'bill_failed',
        status: 'reviewed', // a human already looked at this one
        createdAt: new Date('2025-06-01T12:00:03Z'),
      }),
    ];
    const { prisma, store } = makeHarness(rows);
    const svc = new IntelAlertService(prisma, {} as never, {} as never, {} as never, {} as never);

    const r = await svc.dedupeStateActionAlerts({ apply: true }, jest.fn());
    // still reported as a candidate (visible in the dry-run/report output)...
    expect(r.candidates).toHaveLength(1);
    // ...but the apply update's WHERE clause requires status='new', so a
    // 'reviewed' row is never flipped.
    expect(r.suppressed).toBe(0);
    expect(store.find((s) => s.id === 'text-1')?.status).toBe('reviewed');
  });

  it('does not pair changeTypes from different triggerKey groups (e.g. a hearing alert never collides with a status transition)', async () => {
    const rows = [
      alert({ id: 'coded-1', changeType: 'state_bill_reported' }),
      alert({
        id: 'hearing-1',
        changeType: 'bill_hearing',
        createdAt: new Date('2025-06-01T12:00:01Z'),
      }),
    ];
    const { prisma } = makeHarness(rows);
    const svc = new IntelAlertService(prisma, {} as never, {} as never, {} as never, {} as never);

    const r = await svc.dedupeStateActionAlerts({ apply: false }, jest.fn());
    expect(r.candidates).toHaveLength(0);
  });

  it('scopes pairing to the SAME (tenant, client, sourceRef) — never cross-bill or cross-client', async () => {
    const rows = [
      alert({ id: 'coded-bill-a', changeType: 'state_bill_vetoed', sourceRef: 'tx-2025-hb1' }),
      alert({
        id: 'text-bill-b',
        changeType: 'bill_failed',
        sourceRef: 'tx-2025-hb2', // different bill
        createdAt: new Date('2025-06-01T12:00:03Z'),
      }),
    ];
    const { prisma } = makeHarness(rows);
    const svc = new IntelAlertService(prisma, {} as never, {} as never, {} as never, {} as never);

    const r = await svc.dedupeStateActionAlerts({ apply: false }, jest.fn());
    expect(r.candidates).toHaveLength(0);
  });

  it('no candidates, no rows scanned -> clean empty result', async () => {
    const { prisma } = makeHarness([]);
    const svc = new IntelAlertService(prisma, {} as never, {} as never, {} as never, {} as never);
    const r = await svc.dedupeStateActionAlerts({ apply: true }, jest.fn());
    expect(r.candidates).toHaveLength(0);
    expect(r.suppressed).toBe(0);
  });
});
