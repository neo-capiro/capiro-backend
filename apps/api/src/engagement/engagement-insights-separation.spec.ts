// Phase 2 §3.i — client-tracked intelligence must never be represented as
// global discovery, and vice versa. Before this fix, getOutreachInsights()
// filled `recentBills` with the 10 most-recently-updated bills IN CONGRESS
// (nothing to do with the client) whenever the client tracked zero bills,
// which made unrelated legislative activity look like it was selected FOR
// that client. clientTrackedBills now reflects only the client's own tracked
// bills (empty means empty); suggestedPublicDevelopments is a separate,
// honestly-labeled discovery feed that is always present and never merged in.

import { describe, expect, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';

const ctx: TenantContext = {
  tenantId: 'tenant-1',
  tenantSlug: 'capiro',
  userId: 'user-1',
  clerkUserId: 'clerk-1',
  role: 'standard_user',
} as TenantContext;

interface BillRow {
  id: string;
  billNumber: string;
  title: string;
  policyArea: string | null;
  latestActionText: string | null;
  latestActionDate: Date | null;
}

function bill(id: string, extra: Partial<BillRow> = {}): BillRow {
  return {
    id,
    billNumber: id,
    title: `Title ${id}`,
    policyArea: null,
    latestActionText: null,
    latestActionDate: null,
    ...extra,
  };
}

function serviceWith(opts: {
  client?: { name: string; ldaClientIds: number[] } | null;
  trackedBillRefs?: Array<{ billId: string }>;
  /** Returned when congressBill.findMany is called WITH an `id: { in: [...] }` filter (the tracked-bill lookup). */
  trackedCongressBills?: BillRow[];
  /** Returned when congressBill.findMany is called with NO where filter (the global discovery feed). */
  globalCongressBills?: BillRow[];
  onCongress?: (args: Record<string, unknown>) => void;
}): EngagementService {
  const tx = {
    client: { findFirst: async () => opts.client ?? null },
    trackedBill: { findMany: async () => opts.trackedBillRefs ?? [] },
  };
  const prisma = {
    withTenant: (_tenantId: string, fn: (scoped: unknown) => unknown) => fn(tx),
    ldaFiling: { findMany: async () => [] },
    congressBill: {
      findMany: async (args: Record<string, unknown>) => {
        opts.onCongress?.(args);
        // The tracked-bill lookup always passes `where: { id: { in: [...] } }`;
        // the discovery feed (recentGlobalBills) always passes no `where` at all.
        return args.where ? opts.trackedCongressBills ?? [] : opts.globalCongressBills ?? [];
      },
    },
  };
  const service = Object.create(EngagementService.prototype) as EngagementService;
  const patch = service as unknown as Record<string, unknown>;
  patch.gateway = { enabled: false };
  patch.prisma = prisma;
  patch.lobbyIntel = {
    getAiContext: async () => ({ surgingIssues: [], trendingTopics: [], latestQuarter: null }),
  };
  patch.federalSpending = {
    getAiContext: async () => ({ matchedContractor: null, topAgencyTotals: [] }),
  };
  return service;
}

describe('getOutreachInsights — clientTrackedBills / suggestedPublicDevelopments separation', () => {
  test('clientTrackedBills prefers the client tracked bills and preserves their order', async () => {
    let trackedWhere: Record<string, unknown> | undefined;
    const service = serviceWith({
      client: { name: 'Aperture', ldaClientIds: [] },
      trackedBillRefs: [{ billId: '119-hr-2' }, { billId: '119-hr-1' }],
      // Returned out of order — the method must re-order to the tracked order.
      trackedCongressBills: [bill('119-hr-1'), bill('119-hr-2')],
      onCongress: (args) => {
        if (args.where) trackedWhere = args.where as Record<string, unknown>;
      },
    });

    const result = await service.getOutreachInsights(ctx, {
      clientId: '33333333-3333-3333-3333-333333333333',
    });

    expect(trackedWhere).toEqual({ id: { in: ['119-hr-2', '119-hr-1'] } });
    expect(result.clientTrackedBills.map((b) => b.id)).toEqual(['119-hr-2', '119-hr-1']);
  });

  test('clientTrackedBills is empty — NEVER filled with global bills — when the client tracks nothing', async () => {
    const service = serviceWith({
      client: { name: 'Aperture', ldaClientIds: [] },
      trackedBillRefs: [],
      // Global bills exist (suggestedPublicDevelopments will use them) but must
      // never leak into clientTrackedBills. This is the exact bug being fixed.
      globalCongressBills: [bill('g-1'), bill('g-2')],
    });

    const result = await service.getOutreachInsights(ctx, {
      clientId: '44444444-4444-4444-4444-444444444444',
    });

    expect(result.clientTrackedBills).toEqual([]);
  });

  test('clientTrackedBills is empty with no clientId (there is no client to track bills for)', async () => {
    const service = serviceWith({ globalCongressBills: [bill('g-9')] });

    const result = await service.getOutreachInsights(ctx, {});

    expect(result.clientTrackedBills).toEqual([]);
  });

  test('suggestedPublicDevelopments always reflects global recent activity, honestly labeled, regardless of tracked status', async () => {
    const service = serviceWith({
      client: { name: 'Aperture', ldaClientIds: [] },
      trackedBillRefs: [{ billId: '119-hr-1' }],
      trackedCongressBills: [bill('119-hr-1')],
      globalCongressBills: [bill('g-1', { latestActionDate: new Date('2026-07-20T00:00:00Z') })],
    });

    const result = await service.getOutreachInsights(ctx, {
      clientId: '55555555-5555-5555-5555-555555555555',
    });

    // Visibly separate fields — a client WITH tracked bills still sees discovery.
    expect(result.clientTrackedBills.map((b) => b.id)).toEqual(['119-hr-1']);
    expect(result.suggestedPublicDevelopments).toEqual([
      expect.objectContaining({
        id: 'g-1',
        relevanceReason: 'Recently active in Congress',
        sourceDate: '2026-07-20',
      }),
    ]);
    // The reason string never claims client relevance for a global item.
    for (const dev of result.suggestedPublicDevelopments) {
      expect(dev.relevanceReason).not.toMatch(/client/i);
    }
  });

  test('suggestedPublicDevelopments is present with no clientId too — global results are always labeled discovery', async () => {
    const service = serviceWith({ globalCongressBills: [bill('g-9')] });

    const result = await service.getOutreachInsights(ctx, {});

    expect(result.suggestedPublicDevelopments.map((b) => b.id)).toEqual(['g-9']);
  });
});
