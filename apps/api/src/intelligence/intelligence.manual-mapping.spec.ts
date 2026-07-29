import { IntelligenceService } from './intelligence.service.js';

/**
 * Manual LDA mapping: searchLdaClients (free-text / by-id lookup that powers the
 * attach panel) and createManualMapping (pins an exact lda_client.id as a
 * confirmed mapping — the reliable, name-independent way to fold a registrant
 * variant the fuzzy matcher can't reach into a client's footprint).
 */
describe('IntelligenceService — manual LDA mapping', () => {
  const tenantId = '00000000-0000-0000-0000-000000000001';
  const clientId = '00000000-0000-0000-0000-000000000010';

  describe('searchLdaClients', () => {
    test('empty query short-circuits to [] without hitting the DB', async () => {
      const $queryRaw = jest.fn();
      const service = new IntelligenceService({ $queryRaw } as any);
      expect(await service.searchLdaClients('   ')).toEqual([]);
      expect($queryRaw).not.toHaveBeenCalled();
    });

    test('maps raw rows to the typed shape (id as string, numeric stats)', async () => {
      const $queryRaw = jest.fn(async () => [
        {
          id: 4321,
          name: 'RAYTHEON TECHNOLOGIES CORPORATION',
          state: 'VA',
          total_filings: 180,
          latest_filing_year: 2026,
          total_spending: 90000000,
          issue_codes: ['DEF', 'AVI'],
          similarity: 0.31,
        },
      ]);
      const service = new IntelligenceService({ $queryRaw } as any);
      const out = await service.searchLdaClients('raytheon');
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        id: '4321',
        name: 'RAYTHEON TECHNOLOGIES CORPORATION',
        state: 'VA',
        totalFilings: 180,
        latestFilingYear: 2026,
        totalSpending: 90000000,
        issueCodes: ['DEF', 'AVI'],
      });
      expect(typeof out[0]!.id).toBe('string');
    });

    test('a numeric query is allowed (exact-id lookup path)', async () => {
      const $queryRaw = jest.fn(async () => []);
      const service = new IntelligenceService({ $queryRaw } as any);
      await service.searchLdaClients('4321');
      expect($queryRaw).toHaveBeenCalledTimes(1);
    });
  });

  describe('createManualMapping', () => {
    const input = {
      source: 'lda',
      externalId: '4321',
      externalName: 'RAYTHEON TECHNOLOGIES CORPORATION',
      actorUserId: '00000000-0000-0000-0000-000000000099',
    };

    test('pins an exact id as a confirmed mapping (confidence=1)', async () => {
      const upsert = jest.fn(async (args: any) => ({ id: 'm1', ...args.create }));
      // The upsert is now RLS-scoped via withTenant(tx), so expose it on the tx.
      const prisma: any = {
        withTenant: jest.fn(async (_t: string, run: (tx: any) => Promise<any>) =>
          run({
            client: { findFirst: jest.fn(async () => ({ id: clientId })) },
            clientIntelMapping: {
              findUnique: jest.fn(async () => null),
              upsert,
            },
            auditLog: { create: jest.fn(async () => ({})) },
          }),
        ),
        clientIntelMapping: { upsert },
      };
      const service = new IntelligenceService(prisma);
      await service.createManualMapping(clientId, tenantId, input);
      expect(upsert).toHaveBeenCalledTimes(1);
      const args = upsert.mock.calls[0]![0];
      expect(args.create).toMatchObject({
        clientId,
        source: 'lda',
        externalId: '4321',
        confirmed: true,
        confidence: 1,
      });
      expect(args.update).toMatchObject({ confirmed: true });
    });


    test.each(['contracting', 'assistance_recipient'])(
      '%s requires an explicit reviewed relationship and roll-up decision',
      async (source) => {
        const prisma: any = {
          withTenant: jest.fn(async (_t: string, run: (tx: any) => Promise<any>) =>
            run({ client: { findFirst: jest.fn(async () => ({ id: clientId })) } }),
          ),
        };
        const service = new IntelligenceService(prisma);
        await expect(
          service.createManualMapping(clientId, tenantId, {
            ...input,
            source,
            externalId: 'ABC123456789',
          }),
        ).rejects.toThrow('explicit award roll-up decision');
      },
    );

    test('a reviewed assistance-recipient pin persists self/roll-up semantics', async () => {
      const upsert = jest.fn(async (args: any) => ({ id: 'm-assist', ...args.create }));
      const prisma: any = {
        withTenant: jest.fn(async (_t: string, run: (tx: any) => Promise<any>) =>
          run({
            client: { findFirst: jest.fn(async () => ({ id: clientId })) },
            clientIntelMapping: { findUnique: jest.fn(async () => null), upsert },
            auditLog: { create: jest.fn(async () => ({})) },
          }),
        ),
      };
      const service = new IntelligenceService(prisma);
      await service.createManualMapping(clientId, tenantId, {
        ...input,
        source: 'assistance_recipient',
        externalId: 'ABC123456789',
        relationshipType: 'self',
        rollUpAwards: true,
      });
      expect(upsert.mock.calls[0]![0].create).toEqual(
        expect.objectContaining({
          source: 'assistance_recipient',
          relationshipType: 'self',
          rollUpAwards: true,
          reviewStatus: 'confirmed',
        }),
      );
    });

    test('rejects a client outside the tenant', async () => {
      const upsert = jest.fn();
      const prisma: any = {
        withTenant: jest.fn(async (_t: string, run: (tx: any) => Promise<any>) =>
          run({ client: { findFirst: jest.fn(async () => null) } }),
        ),
        clientIntelMapping: { upsert },
      };
      const service = new IntelligenceService(prisma);
      await expect(service.createManualMapping(clientId, tenantId, input)).rejects.toThrow(
        'Client not found',
      );
      expect(upsert).not.toHaveBeenCalled();
    });
  });

  describe('getIssueCodeSignal', () => {
    test('unions LDA codes across registrants + override, with names and counts', async () => {
      // getIssueCodeSignal's LDA-mapping read is now RLS-scoped via withTenant(tx).
      const clientIntelMapping = {
        findMany: jest.fn(async () => [
          { externalId: '1', externalName: 'RTX CORPORATION' },
          { externalId: '2', externalName: 'RAYTHEON COMPANY' },
        ]),
      };
      const prisma: any = {
        clientIntelMapping,
        $queryRaw: jest.fn(async (strings: any) => {
          const sql = Array.isArray(strings) ? strings.join(' ') : String(strings);
          if (sql.includes('unnest(issue_codes)')) return [{ code: 'DEF' }, { code: 'AVI' }];
          if (sql.includes('lda_issue_code'))
            return [
              { code: 'DEF', name: 'Defense' },
              { code: 'AVI', name: 'Aviation' },
              { code: 'TAX', name: 'Taxation' },
            ];
          return [];
        }),
        withTenant: jest.fn(async (_t: string, run: (tx: any) => Promise<any>) =>
          run({
            client: { findFirst: jest.fn(async () => ({ issueCodes: ['TAX'] })) },
            clientCapability: {
              findMany: jest.fn(async () => [{ tags: ['hypersonics'], description: 'Strike.' }]),
            },
            clientIntelMapping,
          }),
        ),
      };
      const service = new IntelligenceService(prisma);
      const out = await service.getIssueCodeSignal(clientId, tenantId);
      expect(out.ldaRegistrantCount).toBe(2);
      expect(out.codes.map((c) => c.code).sort()).toEqual(['AVI', 'DEF', 'TAX']);
      // TAX comes only from the client-level override.
      expect(out.codes.find((c) => c.code === 'TAX')!.source).toBe('manual');
      expect(out.codes.find((c) => c.code === 'DEF')!.source).toBe('lda');
      expect(out.codes.find((c) => c.code === 'AVI')!.name).toBe('Aviation');
      expect(out.capabilityTagCount).toBe(1);
      expect(out.capabilityDescCount).toBe(1);
    });
  });

  describe('searchFecEmployers', () => {
    test('empty query short-circuits to [] without hitting the DB', async () => {
      const $queryRaw = jest.fn();
      const service = new IntelligenceService({ $queryRaw } as any);
      expect(await service.searchFecEmployers('  ')).toEqual([]);
      expect($queryRaw).not.toHaveBeenCalled();
    });

    test('maps employer aggregate rows; id and name are the employer string', async () => {
      const $queryRaw = jest.fn(async () => [
        {
          employer: 'RAYTHEON TECHNOLOGIES',
          contribution_count: 412,
          total_amount: 1875000,
          latest_year: 2026,
          similarity: 0.4,
        },
      ]);
      const service = new IntelligenceService({ $queryRaw } as any);
      const out = await service.searchFecEmployers('raytheon');
      expect(out[0]).toMatchObject({
        id: 'RAYTHEON TECHNOLOGIES',
        name: 'RAYTHEON TECHNOLOGIES',
        contributionCount: 412,
        totalAmount: 1875000,
        latestYear: 2026,
      });
    });
  });
});
