import { NotFoundException } from '@nestjs/common';
import { IntelligenceService } from './intelligence.service.js';

/**
 * Covers the alerts-worklist feature added to the client-profile "Top alerts":
 *  - per-user alert state (acknowledge / dismiss / snooze) filtering
 *  - alertsHiddenCount math
 *  - new compute-on-read alert sources (hearings, bill movement)
 *  - alert-state + client-brief CRUD service methods
 */
describe('IntelligenceService alerts worklist', () => {
  const tenantId = '00000000-0000-0000-0000-000000000001';
  const clientId = '00000000-0000-0000-0000-000000000010';
  const userId = 'user_abc';

  // A tenant tx whose model methods are individually overridable per test.
  const makeTenantTx = (overrides: Record<string, any> = {}): any => ({
    client: {
      findFirst: jest.fn(async () => ({ id: clientId, name: 'Acme Defense', sectorTag: null, capabilities: [] })),
      findMany: jest.fn(async () => [{ id: clientId }]),
    },
    clientIntelMapping: { findMany: jest.fn(async () => []) },
    meeting: { findMany: jest.fn(async () => []) },
    mailThread: { findMany: jest.fn(async () => []) },
    engagementTask: { findMany: jest.fn(async () => []) },
    meetingDebrief: { findMany: jest.fn(async () => []) },
    outreachRecord: { findMany: jest.fn(async () => []) },
    trackedBill: { findMany: jest.fn(async () => []) },
    alertState: {
      findMany: jest.fn(async () => []),
      upsert: jest.fn(async (args: any) => ({ id: 'as1', ...args.create })),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
    clientBrief: {
      findMany: jest.fn(async () => []),
      create: jest.fn(async (args: any) => ({ id: 'b1', createdAt: new Date(), updatedAt: new Date(), ...args.data })),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
    ...overrides,
  });

  const makeService = (tenantTx = makeTenantTx()) => {
    const prisma: any = {
      withTenant: jest.fn(async (_t: string, run: (tx: any) => Promise<any>) => run(tenantTx)),
      clientIntelMapping: { count: jest.fn(async () => 0), findFirst: jest.fn(async () => null) },
      intelligenceChange: { findMany: jest.fn(async () => []) },
      committeeHearing: { findMany: jest.fn(async () => []) },
      federalRegisterDocument: { findMany: jest.fn(async () => []) },
      ldaFiling: { findMany: jest.fn(async () => []) },
      federalAward: { findMany: jest.fn(async () => []) },
      $queryRaw: jest.fn(async () => []),
      $queryRawUnsafe: jest.fn(async () => []),
      $executeRawUnsafe: jest.fn(async () => 0),
    };

    const service = new IntelligenceService(prisma);

    jest.spyOn(service as any, 'getClientProfile').mockResolvedValue({
      lda: { matched: false, yearlySpend: [], totalSpend: 0, totalSpending: 0, totalFilings: 0 },
      contracting: { matched: false, yearlySpend: [], totalObligations: 0 },
      lobbyIntel: { matched: false, trajectory: null, growthRate: null, totalSpending: 0 },
    } as any);
    jest.spyOn(service as any, 'computeEngagementHealth').mockResolvedValue({ score: 0, trend: 'stable', confidence: 0, components: {} } as any);
    jest.spyOn(service as any, 'getLobbyingRoi').mockResolvedValue({ mappedLdaClientId: null, lobbySpend: 0, contractWins: 0, roi: null, gap: 0 });
    jest.spyOn(service as any, 'buildRoiQuarterSeries').mockResolvedValue([]);
    jest.spyOn(service as any, 'getFecMoneyFlow').mockResolvedValue({ mappedEmployer: null, summary: {} });
    jest.spyOn(service as any, 'getDistrictNexus').mockResolvedValue({ topDistricts: [], capabilities: [] });
    jest.spyOn(service as any, 'getTrackedBills').mockResolvedValue({ total: 0, issueCodes: [], bills: [] });
    jest.spyOn(service as any, 'getBillRegulationLinks').mockResolvedValue({ links: [], totalBills: 0, totalRegulations: 0 });
    jest.spyOn(service as any, 'getKnowledgeGraph').mockResolvedValue({ resolutionQuality: { avgConfidence: 0, confirmedCount: 0, unconfirmedCount: 0 }, nodes: [], edges: [] });
    jest.spyOn(service as any, 'getExStaffers').mockResolvedValue({ total: 0, lobbyists: [] });
    jest.spyOn(service as any, 'getCommentPeriodAlerts').mockResolvedValue({ alerts: [] });
    // New compute-on-read sources: default empty so each test opts into the one it exercises.
    jest.spyOn(service as any, 'getHearingAlerts').mockResolvedValue([]);
    jest.spyOn(service as any, 'getOverdueCommentAlerts').mockResolvedValue([]);
    jest.spyOn(service as any, 'getCompetitorLdaAlerts').mockResolvedValue([]);
    jest.spyOn(service as any, 'getContractAwardAlerts').mockResolvedValue([]);
    jest.spyOn(service as any, 'getClientRelevantRegulations').mockResolvedValue([]);

    return { service, prisma, tenantTx };
  };

  const commentAlert = (id: string, days: number, severity = 'notable') => ({
    documentId: id,
    title: `Doc ${id}`,
    type: 'PROPOSED_RULE',
    commentEndDate: new Date(Date.now() + days * 86_400_000),
    daysToDeadline: days,
    severity,
    agencies: ['EPA'],
    clientId,
    clientName: 'Acme Defense',
    relevanceScore: 1,
  });

  test('without userId: no alert-state query and acknowledged flag is null', async () => {
    const { service, tenantTx } = makeService();
    (service as any).getCommentPeriodAlerts.mockResolvedValue({ alerts: [commentAlert('d1', 5)] });

    const payload = await service.getClientProfileV1(clientId, tenantId); // no userId

    expect(tenantTx.alertState.findMany).not.toHaveBeenCalled();
    const alerts = payload.sections.snapshot.topAlerts;
    expect(alerts.length).toBe(1);
    expect(alerts[0]?.state).toBeNull();
    expect(payload.sections.snapshot.alertsHiddenCount).toBe(0);
  });

  test('dismissed alerts are filtered out; acknowledged kept + flagged', async () => {
    const tenantTx = makeTenantTx();
    tenantTx.alertState.findMany = jest.fn(async () => [
      { alertId: 'comment:d1', state: 'dismissed', snoozedUntil: null },
      { alertId: 'comment:d2', state: 'acknowledged', snoozedUntil: null },
    ]);
    const { service } = makeService(tenantTx);
    (service as any).getCommentPeriodAlerts.mockResolvedValue({
      alerts: [commentAlert('d1', 3), commentAlert('d2', 5), commentAlert('d3', 9)],
    });

    const payload = await service.getClientProfileV1(clientId, tenantId, userId);
    const alerts = payload.sections.snapshot.topAlerts;
    const ids = alerts.map((a: any) => a.id);

    expect(ids).not.toContain('comment:d1'); // dismissed
    expect(ids).toContain('comment:d2');
    expect(ids).toContain('comment:d3');
    expect(alerts.find((a: any) => a.id === 'comment:d2')?.state).toBe('acknowledged');
    expect(alerts.find((a: any) => a.id === 'comment:d3')?.state).toBeNull();
  });

  test('snoozed-until-future hidden; snoozed-until-past shown', async () => {
    const tenantTx = makeTenantTx();
    tenantTx.alertState.findMany = jest.fn(async () => [
      { alertId: 'comment:future', state: 'snoozed', snoozedUntil: new Date(Date.now() + 86_400_000) },
      { alertId: 'comment:past', state: 'snoozed', snoozedUntil: new Date(Date.now() - 86_400_000) },
      { alertId: 'comment:nountil', state: 'snoozed', snoozedUntil: null },
    ]);
    const { service } = makeService(tenantTx);
    (service as any).getCommentPeriodAlerts.mockResolvedValue({
      alerts: [commentAlert('future', 4), commentAlert('past', 6), commentAlert('nountil', 8)],
    });

    const ids = (await service.getClientProfileV1(clientId, tenantId, userId)).sections.snapshot.topAlerts.map((a: any) => a.id);
    expect(ids).not.toContain('comment:future'); // still snoozed
    expect(ids).toContain('comment:past'); // snooze elapsed
    expect(ids).not.toContain('comment:nountil'); // open-ended snooze stays hidden
  });

  test('alertsHiddenCount counts visible alerts beyond the top 5', async () => {
    const { service } = makeService();
    (service as any).getCommentPeriodAlerts.mockResolvedValue({
      alerts: Array.from({ length: 8 }, (_, i) => commentAlert(`d${i}`, i + 1)),
    });

    const payload = await service.getClientProfileV1(clientId, tenantId, userId);
    expect(payload.sections.snapshot.topAlerts.length).toBe(8); // up to 20 returned
    expect(payload.sections.snapshot.alertsHiddenCount).toBe(3); // 8 visible - 5 shown
  });

  test('hearing alerts merge into topAlerts', async () => {
    const { service } = makeService();
    (service as any).getHearingAlerts.mockResolvedValue([
      {
        id: 'hearing:h1',
        type: 'hearing',
        severity: 'notable',
        title: 'Armed Services: NDAA markup',
        subtitle: 'House markup · 118-hr-1',
        when: new Date(Date.now() + 5 * 86_400_000).toISOString(),
        countdownDays: 5,
        countdownLabel: '5d left',
        href: '/intelligence/bills/118-hr-1',
        _urgencyScore: 95,
        _typeRank: 2,
      },
    ]);

    const payload = await service.getClientProfileV1(clientId, tenantId, userId);
    const hearing: any = payload.sections.snapshot.topAlerts.find((a: any) => a.type === 'hearing');
    expect(hearing).toBeDefined();
    expect(hearing.id).toBe('hearing:h1');
    expect(hearing.countdownDays).toBe(5);
  });

  test('bill-movement alert derived from a recently-actioned tracked bill', async () => {
    const { service } = makeService();
    (service as any).getTrackedBills.mockResolvedValue({
      total: 1,
      issueCodes: ['DEF'],
      bills: [
        {
          identifier: '119-hr-22',
          title: 'Some Defense Bill',
          latestActionDate: new Date(Date.now() - 2 * 86_400_000),
          latestActionText: 'Passed House by voice vote',
          isManual: true,
        },
      ],
    });

    const payload = await service.getClientProfileV1(clientId, tenantId, userId);
    const mv: any = payload.sections.snapshot.topAlerts.find((a: any) => a.type === 'bill_movement');
    expect(mv).toBeDefined();
    expect(mv.id).toBe('bill:119-hr-22');
    expect(mv.severity).toBe('critical'); // "passed"/"vote" escalates
  });

  // ── state + brief CRUD ────────────────────────────────────────────────────

  test('setAlertState upserts; non-snooze clears snoozedUntil', async () => {
    const tenantTx = makeTenantTx();
    const { service } = makeService(tenantTx);

    await service.setAlertState(tenantId, userId, clientId, 'comment:d1', 'acknowledged');
    expect(tenantTx.alertState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ state: 'acknowledged', snoozedUntil: null, userId, clientId }),
        update: expect.objectContaining({ state: 'acknowledged', snoozedUntil: null }),
      }),
    );
  });

  test('setAlertState snooze persists snoozedUntil', async () => {
    const tenantTx = makeTenantTx();
    const { service } = makeService(tenantTx);
    const until = new Date(Date.now() + 3 * 86_400_000);

    await service.setAlertState(tenantId, userId, clientId, 'hearing:h1', 'snoozed', until);
    expect(tenantTx.alertState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ state: 'snoozed', snoozedUntil: until }) }),
    );
  });

  test('setAlertState throws NotFound for a client outside the tenant', async () => {
    const tenantTx = makeTenantTx({ client: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) } });
    const { service } = makeService(tenantTx);
    await expect(
      service.setAlertState(tenantId, userId, clientId, 'comment:x', 'dismissed'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  test('addClientBrief persists with createdBy + defaults sourceType', async () => {
    const tenantTx = makeTenantTx();
    const { service } = makeService(tenantTx);

    await service.addClientBrief(tenantId, clientId, userId, { title: 'Watch NDAA', body: 'markup next week' });
    expect(tenantTx.clientBrief.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ createdBy: userId, title: 'Watch NDAA', body: 'markup next week', sourceType: 'manual' }),
      }),
    );
  });

  test('listClientBriefs + deleteClientBrief are tenant + client scoped', async () => {
    const tenantTx = makeTenantTx();
    const { service } = makeService(tenantTx);

    await service.listClientBriefs(tenantId, clientId);
    expect(tenantTx.clientBrief.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { clientId } }));

    await service.deleteClientBrief(tenantId, clientId, 'b1');
    expect(tenantTx.clientBrief.deleteMany).toHaveBeenCalledWith({ where: { id: 'b1', clientId } });
  });

  test('clearAlertState deletes by user+client+alert', async () => {
    const tenantTx = makeTenantTx();
    const { service } = makeService(tenantTx);
    await service.clearAlertState(tenantId, userId, clientId, 'comment:d1');
    expect(tenantTx.alertState.deleteMany).toHaveBeenCalledWith({ where: { userId, clientId, alertId: 'comment:d1' } });
  });
});
