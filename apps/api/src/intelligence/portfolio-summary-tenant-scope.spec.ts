import { describe, expect, it, jest } from '@jest/globals';
import { IntelligenceService } from './intelligence.service.js';

/**
 * Regression: Portfolio Pulse Active strategies / Tracked bills rendered 0
 * on sole-live while sp_strategy (8) and tracked_bill (19) rows existed.
 *
 * Root cause: getPortfolioSummary counted those tables with bare
 * `this.prisma.$queryRaw` outside `withTenant`. Under capiro_app FORCE RLS
 * that returns 0; the old `.catch(() => 0)` path papered it over.
 *
 * Also: billsTracked must count pinned `tracked_bill` rows (same source as
 * Clients → Intelligence / portfolio-rollup), not the LDA issue-code join.
 */
describe('IntelligenceService.getPortfolioSummary tenant scoping', () => {
  it('counts strategies + tracked bills inside withTenant (not bare $queryRaw)', async () => {
    const tenantId = '17b63099-bc0f-4ac5-b596-496161e9481e';
    let withTenantCalls = 0;
    let bareStrategyRawCalls = 0;
    let txStrategyRawCalls = 0;
    let trackedBillCountCalls = 0;

    const tx = {
      client: {
        findMany: jest.fn(async () => [
          { id: 'c1', profileStatus: 'ACTIVE' },
          { id: 'c2', profileStatus: 'PAUSED' },
        ]),
      },
      clientIntelMapping: {
        findMany: jest.fn(async () => [
          { clientId: 'c1', externalId: '69229' },
        ]),
      },
      meeting: {
        count: jest.fn(async () => 1),
      },
      trackedBill: {
        count: jest.fn(async () => {
          trackedBillCountCalls += 1;
          return 19;
        }),
      },
      $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
        const sql = strings.join('?');
        if (sql.includes('sp_strategy')) {
          txStrategyRawCalls += 1;
          return [{ count: 8n }];
        }
        return [];
      }),
    };

    const prisma = {
      withTenant: jest.fn(async (_tid: string, fn: (t: typeof tx) => Promise<unknown>) => {
        withTenantCalls += 1;
        return fn(tx);
      }),
      $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
        const sql = strings.join('?');
        if (sql.includes('sp_strategy')) {
          bareStrategyRawCalls += 1;
          // Simulate FORCE RLS zero-row result if someone regresses to bare raw.
          return [{ count: 0n }];
        }
        if (sql.includes('lda_filing')) {
          return [{ total: '300000' }];
        }
        return [];
      }),
      federalRegisterDocument: {
        count: jest.fn(async () => 257),
      },
    };

    const svc = new IntelligenceService(prisma as never);
    const summary = await svc.getPortfolioSummary(tenantId);

    expect(withTenantCalls).toBe(1);
    expect(txStrategyRawCalls).toBe(1);
    expect(bareStrategyRawCalls).toBe(0);
    expect(trackedBillCountCalls).toBe(1);
    expect(tx.trackedBill.count).toHaveBeenCalledTimes(1);

    expect(summary.activeClients).toBe(2);
    expect(summary.needAttention).toBe(1);
    expect(summary.meetingsThisWeek).toBe(1);
    expect(summary.activeStrategies).toBe(8);
    expect(summary.billsTracked).toBe(19);
    expect(summary.activeRegulations).toBe(257);
    expect(summary.ldaSpendQtd).toBe(300000);
  });
});
