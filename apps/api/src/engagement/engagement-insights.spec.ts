// getOutreachInsights (W0.1 + W0.6): LDA history must query the client's real
// LDA registrant id SET (Client.ldaClientIds) — the old code did Number(<uuid>)
// → NaN and silently returned an empty history — and recentBills must prefer the
// client's actively tracked bills, falling back to the global recent list only
// when the client tracks nothing.
//
// Follows the engagement-audiences.spec pattern: a real prototype over a stub
// `prisma` + stub intel deps, so the heavy EngagementService DI graph is skipped.

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
  ldaFilings?: Array<{ filingYear: number; issueCodes: string[] }>;
  congressBills?: BillRow[];
  onLda?: (args: Record<string, unknown>) => void;
  onCongress?: (args: Record<string, unknown>) => void;
}): EngagementService {
  const tx = {
    client: { findFirst: async () => opts.client ?? null },
    trackedBill: { findMany: async () => opts.trackedBillRefs ?? [] },
  };
  const prisma = {
    withTenant: (_tenantId: string, fn: (scoped: unknown) => unknown) => fn(tx),
    ldaFiling: {
      findMany: async (args: Record<string, unknown>) => {
        opts.onLda?.(args);
        return opts.ldaFilings ?? [];
      },
    },
    congressBill: {
      findMany: async (args: Record<string, unknown>) => {
        opts.onCongress?.(args);
        return opts.congressBills ?? [];
      },
    },
  };
  const service = Object.create(EngagementService.prototype) as EngagementService;
  const patch = service as unknown as Record<string, unknown>;
  patch.prisma = prisma;
  patch.lobbyIntel = {
    getAiContext: async () => ({ surgingIssues: [], trendingTopics: [], latestQuarter: null }),
  };
  patch.federalSpending = {
    getAiContext: async () => ({ matchedContractor: null, topAgencyTotals: [] }),
  };
  return service;
}

describe('getOutreachInsights — LDA history (W0.1)', () => {
  test('queries lda_filing by the client ldaClientIds set (not the UUID)', async () => {
    let ldaWhere: Record<string, unknown> | undefined;
    const service = serviceWith({
      client: { name: 'Aperture', ldaClientIds: [42, 99] },
      trackedBillRefs: [],
      ldaFilings: [
        { filingYear: 2025, issueCodes: ['DEF'] },
        { filingYear: 2025, issueCodes: ['APP'] },
        { filingYear: 2024, issueCodes: ['DEF'] },
      ],
      onLda: (args) => {
        ldaWhere = args.where as Record<string, unknown>;
      },
    });

    const result = await service.getOutreachInsights(ctx, {
      clientId: '11111111-1111-1111-1111-111111111111',
    });

    expect(ldaWhere).toEqual({ clientId: { in: [42, 99] } });
    // 2025 (2 filings, 2 issue areas) then 2024 (1 filing), most-recent first.
    expect(result.clientLdaHistory).toEqual([
      { year: 2025, filingCount: 2, issueAreas: ['DEF', 'APP'] },
      { year: 2024, filingCount: 1, issueAreas: ['DEF'] },
    ]);
  });

  test('skips the filing query entirely when the client has no LDA ids', async () => {
    let ldaCalled = false;
    const service = serviceWith({
      client: { name: 'NewCo', ldaClientIds: [] },
      trackedBillRefs: [],
      onLda: () => {
        ldaCalled = true;
      },
    });

    const result = await service.getOutreachInsights(ctx, {
      clientId: '22222222-2222-2222-2222-222222222222',
    });

    expect(ldaCalled).toBe(false);
    expect(result.clientLdaHistory).toEqual([]);
  });
});

describe('getOutreachInsights — recentBills (W0.6)', () => {
  test('prefers the client tracked bills and preserves their order', async () => {
    let congressWhere: Record<string, unknown> | undefined;
    const service = serviceWith({
      client: { name: 'Aperture', ldaClientIds: [] },
      trackedBillRefs: [{ billId: '119-hr-2' }, { billId: '119-hr-1' }],
      // Returned out of order — the method must re-order to the tracked order.
      congressBills: [bill('119-hr-1'), bill('119-hr-2')],
      onCongress: (args) => {
        congressWhere = args.where as Record<string, unknown>;
      },
    });

    const result = await service.getOutreachInsights(ctx, {
      clientId: '33333333-3333-3333-3333-333333333333',
    });

    // Tracked branch: queried by id, ordered by the trackedBill recency order.
    expect(congressWhere).toEqual({ id: { in: ['119-hr-2', '119-hr-1'] } });
    expect(result.recentBills.map((b) => b.id)).toEqual(['119-hr-2', '119-hr-1']);
  });

  test('falls back to global recent bills when the client tracks nothing', async () => {
    let congressArgs: Record<string, unknown> | undefined;
    const service = serviceWith({
      client: { name: 'Aperture', ldaClientIds: [] },
      trackedBillRefs: [],
      congressBills: [bill('g-1'), bill('g-2')],
      onCongress: (args) => {
        congressArgs = args;
      },
    });

    const result = await service.getOutreachInsights(ctx, {
      clientId: '44444444-4444-4444-4444-444444444444',
    });

    // Global branch: most-recently-updated, no id filter.
    expect(congressArgs?.orderBy).toEqual({ updateDate: 'desc' });
    expect(congressArgs?.where).toBeUndefined();
    expect(result.recentBills.map((b) => b.id)).toEqual(['g-1', 'g-2']);
  });

  test('with no clientId, returns global recent bills and empty LDA history', async () => {
    const service = serviceWith({
      congressBills: [bill('g-9')],
    });

    const result = await service.getOutreachInsights(ctx, {});

    expect(result.recentBills.map((b) => b.id)).toEqual(['g-9']);
    expect(result.clientLdaHistory).toEqual([]);
  });
});
