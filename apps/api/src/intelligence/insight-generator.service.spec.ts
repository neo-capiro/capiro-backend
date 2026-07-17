import { InsightGeneratorService } from './insight-generator.service.js';

describe('InsightGeneratorService.generateClientBriefing PE section', () => {
  const tenantId = '00000000-0000-0000-0000-000000000001';
  const clientId = '00000000-0000-0000-0000-000000000010';

  function makeService(options?: {
    peCodes?: string[];
    peChanges?: Array<{ peCode: string; severity: 'critical' | 'notable' | 'info'; billId?: string; docketId?: string }>;
    aiProgramElementStatus?: Array<{ peCode: string; severity?: 'critical' | 'notable' | 'info'; narrative: string }>;
    profileType?: string | null;
    sectorTag?: string | null;
    openaiModel?: string;
  }) {
    const peCodes = options?.peCodes ?? ['0603270A'];
    const peChanges = options?.peChanges ?? [
      {
        peCode: '0603270A',
        severity: 'notable' as const,
        billId: '119-hr-1234',
        docketId: 'DOD-2026-0001',
      },
    ];

    const client = {
      id: clientId,
      name: 'Acme Defense',
      description: 'Defense autonomy systems',
      capabilities: peCodes.map((code) => ({ name: `Cap ${code}`, peNumber: code })),
      submissionTracks: ['NDAA'],
      intakeData: { peNumber: peCodes[0] },
      profileType: options?.profileType ?? 'DEFENSE_SECTOR',
      sectorTag: options?.sectorTag ?? 'defense',
    };

    const peDetailRows = peCodes.map((code, idx) => ({
      peCode: code,
      title: `Program ${idx + 1}`,
      service: idx % 2 === 0 ? 'Army' : 'Air Force',
      years: [
        {
          fy: 2026,
          request: { toFixed: () => '120.00' },
          hascMark: { toFixed: () => '118.00' },
          sascMark: { toFixed: () => '121.00' },
          hacDMark: { toFixed: () => '117.00' },
          sacDMark: { toFixed: () => '119.00' },
        },
      ],
      conferenceProbabilities: [{ fy: 2026, predicted: { toFixed: () => '0.7300' } }],
    }));

    const peChangeRows = peChanges.map((change, idx) => ({
      id: `change-${idx}`,
      source: 'program_element',
      changeType: 'pe_mark_added',
      severity: change.severity,
      title: `Change ${idx + 1} for ${change.peCode}`,
      description: 'mark moved',
      relatedClientIds: [clientId],
      relatedIssues: [],
      relatedPeCodes: [change.peCode],
      data: {
        billId: change.billId,
        docketId: change.docketId,
      },
      detectedAt: new Date('2026-05-28T12:00:00.000Z'),
      consumed: false,
    }));

    const mockCallAi = jest.fn(async () => ({
      text: JSON.stringify({
        heroSummary: 'Daily snapshot.',
        whatsNew: [],
        whatsComing: [],
        suggestedActions: [],
        programElementStatus:
          options?.aiProgramElementStatus ??
          [
            {
              peCode: peCodes[0],
              severity: 'notable',
              narrative: `${peCodes[0]} is active in markup [${peCodes[0]}] [119-hr-1234] [DOD-2026-0001]`,
            },
          ],
      }),
      provider: 'openai',
      model: 'gpt-4o-mini',
    }));

    const clientIntelMapping = {
      // generateClientBriefing's LDA-mapping read is now RLS-scoped via withTenant(tx).
      findFirst: jest.fn(async () => null),
    };
    const prisma: any = {
      withTenant: jest.fn(async (_tenantId: string, run: (tx: any) => Promise<any>) =>
        run({
          client: {
            findFirst: jest.fn(async () => client),
          },
          clientIntelMapping,
        }),
      ),
      clientIntelMapping,
      $queryRaw: jest.fn(async () => []),
      intelligenceChange: {
        findMany: jest.fn(async (args: any) => {
          if (args?.where?.relatedPeCodes) return peChangeRows;
          return [];
        }),
      },
      committeeHearing: {
        findMany: jest.fn(async () => []),
      },
      federalRegisterDocument: {
        findMany: jest.fn(async () => []),
      },
      programElement: {
        findMany: jest.fn(async () => peDetailRows),
      },
      congressBill: {
        findMany: jest.fn(async () => [
          {
            id: '119-hr-1234',
            title: 'Authorization Act',
            latestActionText: 'In markup',
            latestActionDate: new Date('2026-05-28T00:00:00.000Z'),
            peCodes,
          },
        ]),
      },
    };

    const config: any = {
      get: jest.fn((key: string) => {
        if (key === 'OPENAI_API_KEY') return 'test-openai-key';
        if (key === 'ANTHROPIC_API_KEY') return undefined;
        if (key === 'AI_PROVIDER') return 'openai';
        if (key === 'OPENAI_MODEL') return options?.openaiModel ?? 'gpt-4.1-mini';
        if (key === 'ANTHROPIC_MODEL') return 'claude-sonnet-4-20250514';
        return undefined;
      }),
    };

    const lobbyIntel: any = {
      getAiContext: jest.fn(async () => null),
    };

    const federalSpending: any = {
      getAiContext: jest.fn(async () => null),
    };

    const service = new InsightGeneratorService(config, prisma, lobbyIntel, federalSpending);
    jest.spyOn(service as any, 'callAi').mockImplementation(mockCallAi);

    return { service, prisma, mockCallAi };
  }

  test('mocked IntelligenceChange for watched PE includes Program Element status section with inline source markers', async () => {
    const { service } = makeService();

    const result = await service.generateClientBriefing(clientId, tenantId);

    expect(result.heroSummary).toContain('Program Element status:');
    expect(result.heroSummary).toContain('0603270A');
    expect(result.heroSummary).toContain('[0603270A]');
    expect(result.heroSummary).toContain('[119-hr-1234]');
    expect(result.heroSummary).toContain('[DOD-2026-0001]');
    expect((result as any).dataPoints.programElementStatus).toHaveLength(1);
  });

  test('no recent PE events means no Program Element status section', async () => {
    const { service } = makeService({ peChanges: [], aiProgramElementStatus: [] });

    const result = await service.generateClientBriefing(clientId, tenantId);

    expect(result.heroSummary).not.toContain('Program Element status:');
    expect((result as any).dataPoints).toBeUndefined();
  });

  test('multiple PEs produce one section per PE sorted by severity descending and only one LLM call', async () => {
    const { service, mockCallAi } = makeService({
      peCodes: ['0603270A', '0604220F'],
      peChanges: [
        { peCode: '0603270A', severity: 'info', billId: '119-hr-1000' },
        { peCode: '0604220F', severity: 'critical', docketId: 'DOD-CRIT-01' },
      ],
      aiProgramElementStatus: [
        {
          peCode: '0603270A',
          severity: 'info',
          narrative: 'Info-level movement [0603270A] [119-hr-1000]',
        },
        {
          peCode: '0604220F',
          severity: 'critical',
          narrative: 'Critical movement [0604220F] [DOD-CRIT-01]',
        },
      ],
      openaiModel: 'gpt-4.1',
    });

    const result = await service.generateClientBriefing(clientId, tenantId);

    expect((result as any).dataPoints.programElementStatus).toHaveLength(2);
    const lines = result.heroSummary.split('\n').filter((line) => line.includes('(') && line.includes('-'));
    expect(lines[0]).toContain('0604220F (critical)');
    expect(lines[1]).toContain('0603270A (info)');
    expect(mockCallAi).toHaveBeenCalledTimes(1);
    const callArgs = mockCallAi.mock.calls[0] as unknown[];
    expect(callArgs[3]).toBe('openai');
    expect(callArgs[4]).toBe('gpt-4o-mini');
  });
});

describe('InsightGeneratorService.generateDailyBrief', () => {
  const tenantId = '00000000-0000-0000-0000-000000000001';
  const clientId = '00000000-0000-0000-0000-000000000010';

  function makeDailyBriefService(opts?: {
    meetings?: Array<{ subject: string; startsAt: Date; location?: string | null; organizerName?: string | null; clientId?: string | null }>;
    hearings?: unknown[];
    changes?: unknown[];
  }) {
    const meetings = opts?.meetings ?? [];
    const hearings = opts?.hearings ?? [];
    const changes = opts?.changes ?? [];

    // Spy on the comment-period source so we can assert the daily brief no
    // longer queries it. If this ever fires, the regression has returned.
    const fedRegFindMany = jest.fn(async () => []);

    const prisma: any = {
      withTenant: jest.fn(async (_tenantId: string, run: (tx: any) => Promise<any>) =>
        run({
          client: {
            findMany: jest.fn(async () => [
              { id: clientId, name: 'Acme Defense', sectorTag: 'defense', submissionTracks: ['NDAA'] },
            ]),
          },
          meeting: {
            findMany: jest.fn(async (args: any) => {
              // Honour the date filter so the timezone-bounds assertion is real:
              // only return meetings whose startsAt falls within the queried window.
              const gte = args?.where?.startsAt?.gte as Date | undefined;
              const lte = args?.where?.startsAt?.lte as Date | undefined;
              return meetings.filter(
                (m) => (!gte || m.startsAt >= gte) && (!lte || m.startsAt <= lte),
              );
            }),
          },
        }),
      ),
      committeeHearing: { findMany: jest.fn(async () => hearings) },
      federalRegisterDocument: { findMany: fedRegFindMany },
      intelligenceChange: { findMany: jest.fn(async () => changes) },
    };

    const config: any = {
      get: jest.fn((key: string) => {
        if (key === 'OPENAI_API_KEY') return 'test-openai-key';
        if (key === 'AI_PROVIDER') return 'openai';
        if (key === 'OPENAI_MODEL') return 'gpt-4.1-mini';
        if (key === 'ANTHROPIC_MODEL') return 'claude-sonnet-4-20250514';
        return undefined;
      }),
    };
    const lobbyIntel: any = { getAiContext: jest.fn(async () => null) };
    const federalSpending: any = { getAiContext: jest.fn(async () => null) };

    const service = new InsightGeneratorService(config, prisma, lobbyIntel, federalSpending);
    // Echo the prompt back as the brief text so we can assert on context blocks.
    const freeText = jest
      .spyOn(service as any, 'generateFreeText')
      .mockImplementation(async (...args: unknown[]) => `BRIEF::${args[0] as string}`);

    return { service, prisma, fedRegFindMany, freeText };
  }

  test('does NOT query the federal register (comment-period) source', async () => {
    const { service, fedRegFindMany } = makeDailyBriefService({
      hearings: [{ date: new Date(), time: '10:00', chamber: 'House', committeeName: 'HASC', title: 'Markup' }],
    });
    await service.generateDailyBrief(tenantId);
    expect(fedRegFindMany).not.toHaveBeenCalled();
  });

  test('includes a late-evening ET meeting in the brief (timezone bounds correct)', async () => {
    // 9:00pm ET on the current ET date == next-day UTC. dateBoundsInZone would
    // have excluded this; dayBoundsInZone includes it.
    const now = new Date();
    const etDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
    // Build a 9pm ET instant for today by getting the ET offset for `now`.
    const offRaw =
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' })
        .formatToParts(now)
        .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-05:00';
    const m = offRaw.match(/GMT([+-])(\d{2}):?(\d{2})?/);
    const off = m ? `${m[1]}${m[2]}:${m[3] ?? '00'}` : '-05:00';
    const eveningMeeting = new Date(`${etDate}T21:00:00${off}`);

    const { service } = makeDailyBriefService({
      meetings: [
        { subject: 'Evening strategy w/ Acme', startsAt: eveningMeeting, location: 'Rayburn', organizerName: 'Jordan', clientId },
      ],
    });
    const result = await service.generateDailyBrief(tenantId);
    expect(result.brief).toContain('YOUR MEETINGS TODAY');
    expect(result.brief).toContain('Evening strategy w/ Acme');
    expect(result.brief).toContain('[client: Acme Defense]');
  });

  test('empty day (no hearings, meetings, changes) returns the quiet-day brief without an LLM call', async () => {
    const { service, freeText } = makeDailyBriefService();
    const result = await service.generateDailyBrief(tenantId);
    expect(result.empty).toBe(true);
    expect(result.brief).toContain('quiet day');
    expect(freeText).not.toHaveBeenCalled();
  });
});

describe('InsightGeneratorService.getInsights tenant isolation (GAI-01)', () => {
  // The runtime API role (capiro_app) bypasses row-level security, so tenant
  // isolation for the intelligence feed MUST be enforced by the query WHERE, not
  // the RLS policy. This locks in that filter so a refactor can't silently drop
  // it and reintroduce the cross-tenant global feed.
  const tenantId = '00000000-0000-0000-0000-0000000000aa';

  function makeService() {
    let capturedWhere: any = null;
    const prisma: any = {
      withTenant: jest.fn(async (_t: string, run: (tx: any) => Promise<any>) =>
        run({
          intelligenceInsight: {
            findMany: jest.fn(async (args: any) => {
              capturedWhere = args?.where;
              return [];
            }),
          },
        }),
      ),
    };
    const config: any = { get: jest.fn(() => undefined) };
    const service = new InsightGeneratorService(config, prisma, {} as any, {} as any);
    return { service, prisma, getWhere: () => capturedWhere };
  }

  test('scopes the read to this tenant + reviewed public (NULL-tenant) rows only', async () => {
    const { service, prisma, getWhere } = makeService();
    await service.getInsights(tenantId);

    expect(prisma.withTenant).toHaveBeenCalledWith(tenantId, expect.any(Function));
    const where = getWhere();
    // The tenant clause must be present and must be an OR of own-tenant + public.
    const tenantClause = (where.AND as any[]).find((c) =>
      Array.isArray(c.OR) && c.OR.some((o: any) => 'tenantId' in o),
    );
    expect(tenantClause).toBeDefined();
    expect(tenantClause.OR).toEqual(
      expect.arrayContaining([{ tenantId }, { tenantId: null }]),
    );
    // A different tenant's id must NOT appear anywhere in the filter.
    expect(JSON.stringify(where)).not.toContain('00000000-0000-0000-0000-0000000000bb');
  });
});
