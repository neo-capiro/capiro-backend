import { describe, expect, it } from '@jest/globals';
import { AiUsageService } from './ai-usage.service.js';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ctxA = { tenantId: TENANT_A, userId: 'ua', role: 'standard_user' } as never;

interface Row {
  id: string;
  /** Null = a tenant-agnostic (cached-L1) metering row (Phase 1 M5.0). */
  tenantId: string | null;
  userId: string | null;
  workflow: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  usedTenantKey: boolean;
  createdAt: Date;
}

let seq = 0;
function row(partial: Partial<Row> & { tenantId: string | null }): Row {
  seq += 1;
  return {
    id: `00000000-0000-0000-0000-${String(seq).padStart(12, '0')}`,
    userId: null,
    workflow: 'outreach_campaign',
    provider: 'openai',
    model: 'gpt-4.1',
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: 0.006,
    usedTenantKey: false,
    createdAt: new Date('2026-06-10T12:00:00Z'),
    ...partial,
  };
}

/**
 * In-memory Prisma double that mirrors the REAL isolation mechanism:
 * withTenant scopes every aiUsageEvent read to the GUC tenant (RLS), while
 * withSystem sees all rows (bypass). The cross-tenant leakage test below is
 * the gate the plan requires.
 */
function makePrisma(rows: Row[]) {
  const matches = (r: Row, where: Record<string, unknown>) => {
    if (where.tenantId && r.tenantId !== where.tenantId) return false;
    const createdAt = where.createdAt as { gte?: Date; lte?: Date } | undefined;
    if (createdAt?.gte && r.createdAt < createdAt.gte) return false;
    if (createdAt?.lte && r.createdAt > createdAt.lte) return false;
    return true;
  };
  const delegate = (visible: () => Row[]) => ({
    findMany: async (
      args: {
        where?: Record<string, unknown>;
        orderBy?: { createdAt?: 'desc' | 'asc' };
        take?: number;
      } = {},
    ) => {
      let out = visible().filter((r) => matches(r, args.where ?? {}));
      if (args.orderBy?.createdAt === 'desc') {
        out = [...out].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }
      if (args.take != null) out = out.slice(0, args.take);
      return out.map((r) => ({ ...r }));
    },
  });
  return {
    withTenant: async <T>(tenantId: string, fn: (tx: unknown) => Promise<T>) =>
      fn({ aiUsageEvent: delegate(() => rows.filter((r) => r.tenantId === tenantId)) }),
    withSystem: async <T>(fn: (tx: unknown) => Promise<T>) =>
      fn({
        aiUsageEvent: delegate(() => rows),
        tenant: {
          findMany: async () => [
            { id: TENANT_A, name: 'Alpha Lobbying' },
            { id: TENANT_B, name: 'Bravo Strategies' },
          ],
        },
      }),
  };
}

const seeded = () => [
  row({
    tenantId: TENANT_A,
    workflow: 'outreach_campaign',
    model: 'gpt-4.1',
    costUsd: 0.01,
    inputTokens: 1000,
    outputTokens: 500,
    createdAt: new Date('2026-06-09T08:00:00Z'),
  }),
  row({
    tenantId: TENANT_A,
    workflow: 'outreach_campaign',
    model: 'gpt-4.1',
    costUsd: 0.02,
    inputTokens: 2000,
    outputTokens: 1000,
    createdAt: new Date('2026-06-10T09:00:00Z'),
  }),
  row({
    tenantId: TENANT_A,
    workflow: 'meeting_prep',
    model: 'claude-haiku-4-5-20251001',
    costUsd: 0.05,
    inputTokens: 4000,
    outputTokens: 2000,
    usedTenantKey: true,
    createdAt: new Date('2026-06-10T15:00:00Z'),
  }),
  row({
    tenantId: TENANT_B,
    workflow: 'outreach_campaign',
    model: 'gpt-4.1',
    costUsd: 99.0,
    inputTokens: 9_000_000,
    outputTokens: 9_000_000,
    createdAt: new Date('2026-06-10T10:00:00Z'),
  }),
];

describe('AiUsageService.tenantSummary', () => {
  it('aggregates totals, byWorkflow, byModel, byDay for the tenant', async () => {
    const svc = new AiUsageService(makePrisma(seeded()) as never);
    const s = await svc.tenantSummary(ctxA, {
      from: new Date('2026-06-01T00:00:00Z'),
      to: new Date('2026-06-11T00:00:00Z'),
    });

    expect(s.eventCount).toBe(3);
    expect(s.totalCostUsd).toBeCloseTo(0.08, 6);
    expect(s.totalInputTokens).toBe(7000);
    expect(s.totalOutputTokens).toBe(3500);
    expect(s.tenantKeyEventCount).toBe(1);

    expect(s.byWorkflow).toEqual([
      expect.objectContaining({
        workflow: 'meeting_prep',
        costUsd: expect.closeTo(0.05, 6),
        count: 1,
      }),
      expect.objectContaining({
        workflow: 'outreach_campaign',
        costUsd: expect.closeTo(0.03, 6),
        count: 2,
      }),
    ]);
    expect(s.byModel).toEqual([
      expect.objectContaining({
        model: 'claude-haiku-4-5-20251001',
        costUsd: expect.closeTo(0.05, 6),
      }),
      expect.objectContaining({ model: 'gpt-4.1', costUsd: expect.closeTo(0.03, 6) }),
    ]);
    expect(s.byDay).toEqual([
      expect.objectContaining({ day: '2026-06-09', costUsd: expect.closeTo(0.01, 6), count: 1 }),
      expect.objectContaining({ day: '2026-06-10', costUsd: expect.closeTo(0.07, 6), count: 2 }),
    ]);
  });

  it('CROSS-TENANT GATE: tenant A summary never includes tenant B rows', async () => {
    const svc = new AiUsageService(makePrisma(seeded()) as never);
    const s = await svc.tenantSummary(ctxA, {
      from: new Date('2026-06-01T00:00:00Z'),
      to: new Date('2026-06-11T00:00:00Z'),
    });
    // Tenant B's $99 row must be invisible in every breakdown.
    expect(s.totalCostUsd).toBeLessThan(1);
    expect(s.byWorkflow.reduce((sum, w) => sum + w.costUsd, 0)).toBeLessThan(1);
    expect(s.totalInputTokens).toBeLessThan(1_000_000);
  });

  it('applies the date range filter', async () => {
    const svc = new AiUsageService(makePrisma(seeded()) as never);
    const s = await svc.tenantSummary(ctxA, {
      from: new Date('2026-06-10T00:00:00Z'),
      to: new Date('2026-06-11T00:00:00Z'),
    });
    expect(s.eventCount).toBe(2); // the 06-09 row is excluded
  });

  it('defaults to a trailing-30-day range', async () => {
    const old = row({
      tenantId: TENANT_A,
      costUsd: 5,
      createdAt: new Date('2020-01-01T00:00:00Z'),
    });
    const recent = row({ tenantId: TENANT_A, costUsd: 0.5, createdAt: new Date() });
    const svc = new AiUsageService(makePrisma([old, recent]) as never);
    const s = await svc.tenantSummary(ctxA);
    expect(s.eventCount).toBe(1);
    expect(s.totalCostUsd).toBeCloseTo(0.5, 6);
  });
});

describe('AiUsageService.tenantRecentEvents', () => {
  it('returns own-tenant events newest-first with clamped limit', async () => {
    const svc = new AiUsageService(makePrisma(seeded()) as never);
    const events = await svc.tenantRecentEvents(ctxA, { limit: 2 });
    expect(events).toHaveLength(2);
    expect(events[0]?.workflow).toBe('meeting_prep'); // newest A row
    expect(events.every((e) => e.tenantId === TENANT_A)).toBe(true);
  });
});

describe('AiUsageService.adminAllTenantsSummary', () => {
  it('returns all tenants with names, sorted by spend desc', async () => {
    const svc = new AiUsageService(makePrisma(seeded()) as never);
    const all = await svc.adminAllTenantsSummary({
      from: new Date('2026-06-01T00:00:00Z'),
      to: new Date('2026-06-11T00:00:00Z'),
    });
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({
      tenantId: TENANT_B,
      tenantName: 'Bravo Strategies',
      eventCount: 1,
    });
    expect(all[0]?.totalCostUsd).toBeCloseTo(99.0, 6);
    expect(all[1]).toMatchObject({
      tenantId: TENANT_A,
      tenantName: 'Alpha Lobbying',
      eventCount: 3,
    });
    expect(all[1]?.totalCostUsd).toBeCloseTo(0.08, 6);
  });

  it('PINNED (Phase 1 M5.0): excludes tenant-agnostic (tenant_id = NULL) rows from the per-tenant report', async () => {
    const rows = [
      ...seeded(),
      row({
        tenantId: null,
        workflow: 'legiwatch_alert_enrichment',
        costUsd: 500.0,
        createdAt: new Date('2026-06-09T09:00:00Z'),
      }),
    ];
    const svc = new AiUsageService(makePrisma(rows) as never);
    const all = await svc.adminAllTenantsSummary({
      from: new Date('2026-06-01T00:00:00Z'),
      to: new Date('2026-06-11T00:00:00Z'),
    });
    // Still exactly the 2 real tenants — the huge $500 tenant-agnostic row
    // must never surface as (or inflate) a per-tenant entry.
    expect(all).toHaveLength(2);
    expect(all.some((t) => t.tenantId == null)).toBe(false);
    expect(all.find((t) => t.tenantId === TENANT_A)?.totalCostUsd).toBeCloseTo(0.08, 6);
    expect(all.find((t) => t.tenantId === TENANT_B)?.totalCostUsd).toBeCloseTo(99.0, 6);
  });
});
