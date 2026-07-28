import { NotFoundException } from '@nestjs/common';
import { IntelligenceService } from './intelligence.service.js';

describe('IntelligenceService.getClientProfileV1', () => {
  const tenantId = '00000000-0000-0000-0000-000000000001';
  const clientId = '00000000-0000-0000-0000-000000000010';

  const makeService = () => {
    const tenantTx = {
      client: {
        findFirst: jest.fn(async () => ({ id: clientId, name: 'Acme Defense' })),
        findMany: jest.fn(async () => [{ id: clientId }]),
      },
      clientIntelMapping: {
        findMany: jest.fn(async () => []),
        // Compute-on-read alert builders (getContractAwardAlerts,
        // getCompetitorLdaAlerts) read confirmed mappings via withTenant(tx).
        findFirst: jest.fn(async () => null),
      },
      meeting: {
        findMany: jest.fn(async () => []),
      },
      mailThread: {
        findMany: jest.fn(async () => []),
      },
      engagementTask: {
        findMany: jest.fn(async () => []),
      },
      meetingDebrief: {
        findMany: jest.fn(async () => []),
      },
      outreachRecord: {
        findMany: jest.fn(async () => []),
      },
    };

    const prisma: any = {
      withTenant: jest.fn(async (_tenantId: string, run: (tx: any) => Promise<any>) => run(tenantTx)),
      clientIntelMapping: {
        count: jest.fn(async () => 0),
      },
      intelligenceChange: {
        findMany: jest.fn(async () => []),
      },
      meeting: {
        findMany: jest.fn(async () => []),
      },
      mailThread: {
        findMany: jest.fn(async () => []),
      },
      engagementTask: {
        findMany: jest.fn(async () => []),
      },
      meetingDebrief: {
        findMany: jest.fn(async () => []),
      },
      outreachRecord: {
        findMany: jest.fn(async () => []),
      },
      committeeHearing: {
        findMany: jest.fn(async () => []),
      },
      $queryRaw: jest.fn(async () => []),
      $queryRawUnsafe: jest.fn(async () => []),
      $executeRawUnsafe: jest.fn(async () => 0),
    };

    const service = new IntelligenceService(prisma);

    jest.spyOn(service as any, 'getClientProfile').mockResolvedValue({
      lda: {
        matched: false,
        yearlySpend: [],
        totalSpend: 0,
        totalSpending: 0,
        totalFilings: 0,
      },
      contracting: {
        matched: false,
        yearlySpend: [],
        totalObligations: 0,
      },
      lobbyIntel: {
        matched: false,
        trajectory: null,
        growthRate: null,
        totalSpending: 0,
      },
    } as any);

    jest.spyOn(service as any, 'computeEngagementHealth').mockResolvedValue({
      score: 0,
      trend: 'stable',
      confidence: 0,
      components: {
        recency: 0,
        engagementVolume: 0,
        completionRate: 0,
      },
    } as any);

    jest.spyOn(service as any, 'getLobbyingRoi').mockResolvedValue({
      mappedLdaClientId: null,
      lobbySpend: 0,
      contractWins: 0,
      roi: null,
      gap: 0,
    });

    jest.spyOn(service as any, 'buildRoiQuarterSeries').mockResolvedValue([]);
    jest.spyOn(service as any, 'getFecMoneyFlow').mockResolvedValue({ mappedEmployer: null, summary: {} });
    jest.spyOn(service as any, 'getDistrictNexus').mockResolvedValue({ topDistricts: [], capabilities: [] });
    jest.spyOn(service as any, 'getTrackedBills').mockResolvedValue({ total: 0, issueCodes: [], bills: [] });
    jest.spyOn(service as any, 'getBillRegulationLinks').mockResolvedValue({ links: [], totalBills: 0, totalRegulations: 0 });
    jest.spyOn(service as any, 'getKnowledgeGraph').mockResolvedValue({
      resolutionQuality: { avgConfidence: 0, confirmedCount: 0, unconfirmedCount: 0 },
      nodes: [],
      edges: [],
    });
    jest.spyOn(service as any, 'getExStaffers').mockResolvedValue({ total: 0, lobbyists: [] });
    jest.spyOn(service as any, 'getCommentPeriodAlerts').mockResolvedValue({ alerts: [] });

    return { service, prisma, tenantTx };
  };

  test('returns profile-v1 shape for mapped client without throwing', async () => {
    const { service } = makeService();

    const payload = await service.getClientProfileV1(clientId, tenantId);

    expect(payload.client).toEqual({ id: clientId, name: 'Acme Defense' });
    expect(payload.sections).toBeDefined();
    expect(payload.sections.snapshot).toBeDefined();
    expect(payload.sections.financialFootprint).toBeDefined();
    expect(payload.sections.legislativeRegulatory).toBeDefined();
    expect(payload.sections.relationships).toBeDefined();
  });

  test('treats a soft-archived ("deleted") client as not-found', async () => {
    const { service, tenantTx } = makeService();
    // The guard query is the first client.findFirst call; archived → 404 so a
    // deleted client's alerts can never surface (e.g. via a stale deep link).
    tenantTx.client.findFirst.mockResolvedValueOnce({
      id: clientId,
      name: 'Acme Defense',
      status: 'archived',
    } as any);

    await expect(service.getClientProfileV1(clientId, tenantId)).rejects.toThrow(NotFoundException);
  });

  test('returns safe defaults for partially mapped client payloads', async () => {
    const { service } = makeService();

    (service as any).getTrackedBills.mockResolvedValueOnce({
      total: 3,
      issueCodes: ['DEF'],
      bills: [
        {
          identifier: '118-hr-1',
          title: 'Defense Authorization Act',
          latestActionDate: new Date('2026-01-01T00:00:00.000Z'),
          latestActionText: 'Referred to committee',
          sponsorName: 'Rep. Smith',
          sponsorParty: 'R',
          subjectNames: ['Defense'],
          congress: 118,
          billType: 'hr',
          billNumber: '1',
          introducedDate: new Date('2026-01-01T00:00:00.000Z'),
          cosponsorsCount: 7,
        },
      ],
    });

    const payload = await service.getClientProfileV1(clientId, tenantId);

    expect(payload.sections.legislativeRegulatory.kanban.total).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(payload.sections.legislativeRegulatory.kanban.columns)).toBe(true);
    expect(payload.sections.snapshot.changes7dCount).toBeGreaterThanOrEqual(0);
    expect(payload.links).toBeDefined();
  });

  /**
   * Every optional source has an inline fallback literal, and most are written
   * `as unknown as Awaited<ReturnType<...>>` — a double cast, which turns OFF
   * the structural check. On 2026-07-28 that let `billRegulationLinks` ship a
   * fallback of `{ rails: [] }` (the RESPONSE shape, `regulatoryLifecycle.rails`)
   * against a method that returns `{ links: [] }`, so the aggregate ran
   * `for (... of undefined)` and returned 500 for the entire client Intelligence
   * tab whenever that one source failed — which the 20s per-source budget made
   * routine under portfolio-alerts load.
   *
   * The budget spec already proved a source can reject without hanging. Nothing
   * proved the AGGREGATE survives that rejection. This does, for every source,
   * so a fallback that does not satisfy its consumers fails here instead of in
   * production.
   */
  describe('a rejected optional source degrades its section, never the request', () => {
    const optionalSources = [
      'computeEngagementHealth',
      'getLobbyingRoi',
      'buildRoiQuarterSeries',
      'getFecMoneyFlow',
      'getDistrictNexus',
      'getTrackedBills',
      'getBillRegulationLinks',
      'getKnowledgeGraph',
      'getExStaffers',
      'getCommentPeriodAlerts',
    ] as const;

    test.each(optionalSources)('%s rejecting still yields a complete envelope', async (source) => {
      const { service } = makeService();
      (service as any)[source].mockRejectedValue(new Error(`${source} exceeded its budget`));

      const payload = await service.getClientProfileV1(clientId, tenantId);

      expect(payload.client).toEqual({ id: clientId, name: 'Acme Defense' });
      expect(payload.sections.snapshot).toBeDefined();
      expect(payload.sections.financialFootprint).toBeDefined();
      expect(payload.sections.legislativeRegulatory).toBeDefined();
      expect(payload.sections.relationships).toBeDefined();
    });

    test('billRegulationLinks: the section reports zero instead of throwing', async () => {
      // The exact 2026-07-28 regression. `links` is iterated; `totalBills` and
      // `totalRegulations` are read. All three must survive the fallback.
      const { service } = makeService();
      (service as any).getBillRegulationLinks.mockRejectedValue(
        new Error('exceeded its 20000ms budget (still running)'),
      );

      const payload = await service.getClientProfileV1(clientId, tenantId);

      // Cast because normalizeProfileV1Sections spreads a `Record<string, any>`
      // and TS drops the index signature from the resulting literal, so
      // `regulatoryLifecycle` is present at runtime but not on the typed surface.
      const lifecycle = (payload.sections.legislativeRegulatory as Record<string, any>)
        .regulatoryLifecycle;
      expect(lifecycle.totalLinkedBills).toBe(0);
      expect(lifecycle.totalRegulations).toBe(0);
      expect(lifecycle.rails).toEqual([]);
    });
  });

  test('throws NotFoundException when client does not exist in tenant', async () => {
    const { service, prisma } = makeService();
    prisma.withTenant.mockImplementationOnce(async (_tenantId: string, run: (tx: any) => Promise<any>) =>
      run({
        client: {
          findFirst: jest.fn(async () => null),
          findMany: jest.fn(async () => []),
        },
        clientIntelMapping: {
          findMany: jest.fn(async () => []),
        },
        meeting: {
          findMany: jest.fn(async () => []),
        },
        mailThread: {
          findMany: jest.fn(async () => []),
        },
        engagementTask: {
          findMany: jest.fn(async () => []),
        },
        meetingDebrief: {
          findMany: jest.fn(async () => []),
        },
        outreachRecord: {
          findMany: jest.fn(async () => []),
        },
      }),
    );

    await expect(service.getClientProfileV1(clientId, tenantId)).rejects.toBeInstanceOf(NotFoundException);
  });
});
