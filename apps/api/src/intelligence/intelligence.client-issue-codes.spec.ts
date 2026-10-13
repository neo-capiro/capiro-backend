import { IntelligenceService } from './intelligence.service.js';

/**
 * Pins the client-level LDA issue-code override (set in the client summary
 * settings): it must drive bill matching even with NO confirmed LDA mapping, and
 * be unioned (deduped) with the auto codes when an LDA match exists.
 */
describe('IntelligenceService.getTrackedBills — client-level issue-code override', () => {
  const tenantId = '00000000-0000-0000-0000-000000000001';
  const clientId = '00000000-0000-0000-0000-000000000010';

  const makeService = (opts: {
    overrideCodes: string[];
    ldaMapping: { externalId: string } | null;
    ldaClientCodes?: string[];
  }) => {
    const clientIntelMapping = {
      findMany: jest.fn(async () => (opts.ldaMapping ? [opts.ldaMapping] : [])),
    };
    const tenantTx = {
      trackedBill: { findMany: jest.fn(async () => []) },
      clientCapability: { findMany: jest.fn(async () => []) },
      client: { findFirst: jest.fn(async () => ({ issueCodes: opts.overrideCodes })) },
      // getTrackedBills' LDA-mapping read is now RLS-scoped via withTenant(tx).
      clientIntelMapping,
    };
    const prisma: any = {
      withTenant: jest.fn(async (_t: string, run: (tx: any) => Promise<any>) => run(tenantTx)),
      clientIntelMapping,
      $queryRaw: jest.fn(async (strings: any) => {
        const sql = Array.isArray(strings) ? strings.join(' ') : String(strings);
        // Union of issue_codes across all confirmed LDA registrants.
        if (sql.includes('unnest(issue_codes)'))
          return (opts.ldaClientCodes ?? []).map((code) => ({ code }));
        if (sql.includes('lda_issue_code')) return [{ name: 'Defense' }];
        return [];
      }),
      $queryRawUnsafe: jest.fn(async () => []),
      $transaction: jest.fn(async (run: (tx: any) => Promise<any>) =>
        run({
          $queryRaw: prisma.$queryRaw,
          $executeRaw: jest.fn(async () => 0),
        }),
      ),
    };
    const service = new IntelligenceService(prisma);
    // Force the keyword fallback so no real Bedrock embed call is made.
    jest.spyOn(service as any, 'findTrackedBillsByEmbeddings').mockResolvedValue(null);
    return service;
  };

  test('override codes drive matching even with NO LDA mapping', async () => {
    const service = makeService({ overrideCodes: ['DEF'], ldaMapping: null });
    const result = await service.getTrackedBills(clientId, tenantId);
    expect(result.issueCodes).toContain('DEF');
  });

  test('override is unioned and deduped with the LDA-match codes', async () => {
    const service = makeService({
      overrideCodes: ['TEC', 'DEF'],
      ldaMapping: { externalId: '1' },
      ldaClientCodes: ['DEF'],
    });
    const result = await service.getTrackedBills(clientId, tenantId);
    expect([...result.issueCodes].sort()).toEqual(['DEF', 'TEC']);
  });
});
