// getOutreachInsights — LDA history (W0.1): must query the client's real LDA
// registrant id SET (Client.ldaClientIds) — the old code did Number(<uuid>) →
// NaN and silently returned an empty history.
//
// Bill-separation behavior (clientTrackedBills vs suggestedPublicDevelopments)
// lives in engagement-insights-separation.spec.ts.
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

function serviceWith(opts: {
  client?: { name: string; ldaClientIds: number[] } | null;
  trackedBillRefs?: Array<{ billId: string }>;
  ldaFilings?: Array<{ filingYear: number; issueCodes: string[] }>;
  onLda?: (args: Record<string, unknown>) => void;
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
      findMany: async () => [],
    },
  };
  const service = Object.create(EngagementService.prototype) as EngagementService;
  const patch = service as unknown as Record<string, unknown>;
  // Phase 1: generateBatchEmails branches on this.gateway.enabled before doing
  // anything else. These specs build the service with Object.create (no
  // constructor), so the injected dependency has to be supplied here. OFF selects
  // the legacy path, which is what these specs exercise.
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
