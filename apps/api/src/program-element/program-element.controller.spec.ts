import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { TenantContext } from '@capiro/shared';
import { ProgramElementController } from './program-element.controller.js';
import { RolesGuard } from '../auth/roles.guard.js';

describe('ProgramElementController', () => {
  const ctx: TenantContext = {
    tenantId: '00000000-0000-0000-0000-000000000001',
    tenantSlug: 'capiro',
    userId: '00000000-0000-0000-0000-000000000002',
    clerkUserId: 'user_test',
    role: 'standard_user',
  };
  const adminCtx: TenantContext = { ...ctx, role: 'capiro_admin' };

  const makeController = () => {
    const service = {
      listProgramElements: jest.fn(),
      getProgramElement: jest.fn(),
      getTimeline: jest.fn(),
      getBills: jest.fn(),
      getContractors: jest.fn(),
      getProjects: jest.fn(),
      getSources: jest.fn(),
      getBudgetPositions: jest.fn(),
      getPbComparison: jest.fn(),
      getDeltas: jest.fn(),
      getNeedsAttention: jest.fn(),
      getRelatedProgramElements: jest.fn(),
      getProgramsForPe: jest.fn(),
      getProvisionsForPe: jest.fn(),
      getOpportunitiesForPe: jest.fn(),
      setWatching: jest.fn(),
      listReconciliationQueue: jest.fn(),
      resolveReconciliation: jest.fn(),
      approveReconciliation: jest.fn(),
    };
    const writer = { upsertProgramElementYear: jest.fn().mockResolvedValue({ inserted: false, changed: true }) };
    const dataIssues = {
      create: jest.fn(),
      listForPe: jest.fn(),
      listAdmin: jest.fn(),
      resolve: jest.fn(),
    };
    // Phase 7 WS K: the governed override port the controller now proposes into.
    const overrides = {
      findLatestForTarget: jest.fn().mockResolvedValue(null),
      findById: jest.fn(),
      insert: jest.fn().mockResolvedValue(undefined),
      markApproved: jest.fn().mockResolvedValue(undefined),
    };

    const controller = new ProgramElementController(
      service as never,
      writer as never,
      dataIssues as never,
      overrides as never,
    );
    return { controller, service, writer, dataIssues, overrides };
  };

  test('GET /api/program-elements applies defaults and pagination shape', async () => {
    const { controller, service } = makeController();
    service.listProgramElements.mockResolvedValue({
      data: [{ peCode: '0603270A', title: 'Electronic Warfare Advanced Payloads' }],
      total: 1,
      page: 1,
      limit: 50,
    });

    const result = await controller.list(ctx, {} as never);

    expect(service.listProgramElements).toHaveBeenCalledWith(
      {
        service: undefined,
        budgetActivity: undefined,
        q: undefined,
        page: undefined,
        limit: undefined,
        mode: undefined,
        divergenceThreshold: undefined,
      },
      ctx,
    );
    expect(result.limit).toBe(50);
    expect(result.total).toBe(1);
  });

  test('GET /api/program-elements enforces max limit in service contract', async () => {
    const { controller, service } = makeController();
    service.listProgramElements.mockResolvedValue({ data: [], total: 0, page: 1, limit: 100 });

    const result = await controller.list(ctx, { limit: 500, page: 1, q: 'gps' } as never);

    expect(service.listProgramElements).toHaveBeenCalledWith(
      {
        service: undefined,
        budgetActivity: undefined,
        q: 'gps',
        page: 1,
        limit: 500,
        mode: undefined,
        divergenceThreshold: undefined,
      },
      ctx,
    );
    expect(result.limit).toBe(100);
  });

  test('GET /api/program-elements markup monitor mode passes tenant context + monitor params', async () => {
    const { controller, service } = makeController();
    service.listProgramElements.mockResolvedValue({
      data: [
        {
          peCode: '0603270A',
          title: 'Electronic Warfare Advanced Payloads',
          service: 'Army',
          request: 100,
          hascMark: 120,
          sascMark: 90,
          hacDMark: null,
          sacDMark: 130,
          divergencePct: 40,
        },
      ],
      total: 1,
      page: 1,
      limit: 1,
    });

    const result = await controller.list(
      ctx,
      {
        mode: 'markup-monitor',
        service: 'Army',
        divergence_threshold: 15,
      } as never,
    );

    expect(service.listProgramElements).toHaveBeenCalledWith(
      {
        service: 'Army',
        budgetActivity: undefined,
        q: undefined,
        page: undefined,
        limit: undefined,
        mode: 'markup-monitor',
        divergenceThreshold: 15,
      },
      ctx,
    );
    expect((result.data[0] as { divergencePct?: number } | undefined)?.divergencePct).toBe(40);
  });

  test('GET /api/program-elements/:peCode includes currentUserIsWatching', async () => {
    const { controller, service } = makeController();
    service.getProgramElement.mockResolvedValue({ peCode: '0603270A', currentUserIsWatching: true });

    const result = await controller.detail(ctx, '0603270A');

    expect(service.getProgramElement).toHaveBeenCalledWith('0603270A', ctx);
    expect(result.currentUserIsWatching).toBe(true);
  });

  test('GET /api/program-elements/:peCode/timeline includes predictedConferenceAmount field placeholder', async () => {
    const { controller, service } = makeController();
    service.getTimeline.mockResolvedValue({
      peCode: '0603270A',
      years: [{ fy: 2027, request: '278.50', predictedConferenceAmount: null }],
      milestones: [],
    });

    const result = await controller.timeline('0603270A');

    expect(service.getTimeline).toHaveBeenCalledWith('0603270A');
    expect(result.years[0]?.predictedConferenceAmount).toBeNull();
  });

  test('GET /api/program-elements/:peCode/bills returns related bills by pe_code', async () => {
    const { controller, service } = makeController();
    service.getBills.mockResolvedValue([{ id: '119-hr-1234', title: 'DoD Authorization' }]);

    const result = await controller.bills('0603270A');

    expect(service.getBills).toHaveBeenCalledWith('0603270A');
    expect(result).toHaveLength(1);
  });

  test('GET /api/program-elements/:peCode/related returns similarity suggestions', async () => {
    const { controller, service } = makeController();
    service.getRelatedProgramElements.mockResolvedValue({
      related: [{ peCode: '0603271A', title: 'Adjacent program', service: 'Army', similarity: 0.83 }],
      todo: null,
    });

    const result = await controller.related('0603270A');

    expect(service.getRelatedProgramElements).toHaveBeenCalledWith('0603270A');
    expect(result.related).toHaveLength(1);
    expect(result.related[0]?.similarity).toBe(0.83);
  });

  test('GET /api/program-elements/:peCode/programs delegates to the read service (Step 2.1)', async () => {
    const { controller, service } = makeController();
    service.getProgramsForPe.mockResolvedValue({
      peCode: '0601102A',
      acceptedMatches: [
        { id: 'm1', program: { canonicalName: 'PATRIOT' }, status: 'accepted', confidenceBand: 'high', whyShown: 'curated MDAP map' },
      ],
      candidateMatches: [],
    });

    const result = await controller.programs('0601102A');

    expect(service.getProgramsForPe).toHaveBeenCalledWith('0601102A');
    expect(result.acceptedMatches).toHaveLength(1);
    expect(result.acceptedMatches[0]?.program?.canonicalName).toBe('PATRIOT');
    expect(result.candidateMatches).toEqual([]);
  });

  test('GET /api/program-elements/:peCode/provisions delegates to the read service (Step 2.4)', async () => {
    const { controller, service } = makeController();
    service.getProvisionsForPe.mockResolvedValue([
      {
        id: 'prov-1',
        committee: 'HASC',
        fy: 2027,
        heading: 'Increase for long-range fires development',
        text: 'The committee recommends an increase of $25.0 million ...',
        pageStart: 143,
        pageEnd: 144,
        actionType: 'adds',
        sourceUrl: 'https://www.congress.gov/report.pdf',
        matchBasis: 'pe_code',
        reviewStatus: 'accepted',
        confidence: 0.99,
      },
    ]);

    const result = await controller.provisions('0604801F');

    expect(service.getProvisionsForPe).toHaveBeenCalledWith('0604801F');
    expect(result).toHaveLength(1);
    expect(result[0]?.matchBasis).toBe('pe_code');
    expect(result[0]?.reviewStatus).toBe('accepted');
  });

  test('GET /api/program-elements/:peCode/opportunities delegates to the read service (Step 3.1)', async () => {
    const { controller, service } = makeController();
    service.getOpportunitiesForPe.mockResolvedValue([
      {
        id: 'opp-1',
        noticeId: 'SAM-NOTICE-1',
        title: 'Long-Range Fires Components',
        noticeType: 'Solicitation',
        agency: 'Department of the Army',
        office: 'ACC-RSA',
        pscCode: '1410',
        naicsCode: '336414',
        postedDate: '2026-05-01T00:00:00.000Z',
        responseDeadline: '2026-07-01T00:00:00.000Z',
        sourceUrl: 'https://sam.gov/opp/abc',
        pocName: 'Jane Contracting',
        pocEmail: 'jane@army.mil',
        matchBasis: 'description_pe_code',
        reviewStatus: 'accepted',
        confidence: 0.99,
      },
    ]);

    const result = await controller.opportunities('0604801F');

    expect(service.getOpportunitiesForPe).toHaveBeenCalledWith('0604801F');
    expect(result).toHaveLength(1);
    expect(result[0]?.noticeId).toBe('SAM-NOTICE-1');
    expect(result[0]?.reviewStatus).toBe('accepted');
  });

  test('GET /api/program-elements/:peCode/contractors returns [] + TODO when federal_award table missing', async () => {
    const { controller, service } = makeController();
    service.getContractors.mockResolvedValue({
      data: [],
      todo: 'federal_award table not yet created (Step 28)',
    });

    const result = await controller.contractors('0603270A');

    expect(service.getContractors).toHaveBeenCalledWith('0603270A');
    expect(result.data).toEqual([]);
    expect(result.todo).toContain('Step 28');
  });

  test('GET /api/program-elements/:peCode/projects delegates to the read service', async () => {
    const { controller, service } = makeController();
    service.getProjects.mockResolvedValue([
      { id: 'p1', projectCode: 'AA1', title: 'Basic research', pageNumber: 12, sourceUrl: 'http://x.pdf' },
    ]);

    const result = await controller.projects('0601102A');

    expect(service.getProjects).toHaveBeenCalledWith('0601102A');
    expect(result).toHaveLength(1);
    expect(result[0]?.projectCode).toBe('AA1');
  });

  test('GET /api/program-elements/:peCode/sources delegates to the read service', async () => {
    const { controller, service } = makeController();
    service.getSources.mockResolvedValue([
      { id: 's1', docType: 'R', exhibitType: 'R-2A', fy: 2027, pageNumber: 12, sourceUrl: 'http://x.pdf' },
    ]);

    const result = await controller.sources('0601102A');

    expect(service.getSources).toHaveBeenCalledWith('0601102A');
    expect(result[0]?.exhibitType).toBe('R-2A');
  });

  test('GET /api/program-elements/:peCode/positions delegates to the read service (Step 1.3)', async () => {
    const { controller, service } = makeController();
    service.getBudgetPositions.mockResolvedValue([
      { positionCycle: 'pb_fy2027', assertedFy: 2027, amount: 278.5, valueKind: 'total', pageNumber: 12 },
    ]);

    const result = await controller.positions('0601102A');

    // No ?fy → undefined fy passed through.
    expect(service.getBudgetPositions).toHaveBeenCalledWith('0601102A', undefined);
    expect(result).toHaveLength(1);
    expect((result[0] as { positionCycle?: string }).positionCycle).toBe('pb_fy2027');
  });

  test('GET /api/program-elements/:peCode/positions parses ?fy= to a number', async () => {
    const { controller, service } = makeController();
    service.getBudgetPositions.mockResolvedValue([]);

    await controller.positions('0601102A', '2028');
    expect(service.getBudgetPositions).toHaveBeenCalledWith('0601102A', 2028);

    // Non-numeric / empty fy is ignored (passed as undefined).
    await controller.positions('0601102A', 'notanumber');
    expect(service.getBudgetPositions).toHaveBeenLastCalledWith('0601102A', undefined);
  });

  test('GET /api/program-elements/:peCode/pb-comparison delegates to the read service (Step 1.3)', async () => {
    const { controller, service } = makeController();
    service.getPbComparison.mockResolvedValue({
      peCode: '0601102A',
      comparison: [
        { assertedFy: 2027, pbCurrent: 250, pbPrior: 200, deltaAbs: 50, deltaPct: 0.25, newInPb: false, droppedFromPb: false },
      ],
    });

    const result = await controller.pbComparison('0601102A');

    expect(service.getPbComparison).toHaveBeenCalledWith('0601102A');
    expect(result.comparison[0]?.deltaAbs).toBe(50);
  });

  test('POST /api/program-elements/:peCode/watch is tenant-scoped', async () => {
    const { controller, service } = makeController();
    service.setWatching.mockResolvedValue({ peCode: '0603270A', watching: true });

    const result = await controller.watch(ctx, '0603270A', { watching: true });

    expect(service.setWatching).toHaveBeenCalledWith('0603270A', true, ctx);
    expect(result.watching).toBe(true);
  });

  test('404 on unknown peCode from read endpoint', async () => {
    const { controller, service } = makeController();
    service.getProgramElement.mockRejectedValue(new NotFoundException('Program element BAD not found'));

    await expect(controller.detail(ctx, 'BAD')).rejects.toBeInstanceOf(NotFoundException);
  });

  test('404 on unknown peCode from watch endpoint', async () => {
    const { controller, service } = makeController();
    service.setWatching.mockRejectedValue(new NotFoundException('Program element BAD not found'));

    await expect(controller.watch(ctx, 'BAD', { watching: false })).rejects.toBeInstanceOf(NotFoundException);
  });

  test('POST resolve delegates to the service with the normalized body + a propose callback', async () => {
    const { controller, service, writer } = makeController();
    service.resolveReconciliation.mockResolvedValue({ resolved: true, id: 'r1', decision: 'keep_current' });

    const res = await controller.resolveReconciliation(adminCtx, 'r1', { decision: 'keep_current' } as never);

    expect(service.resolveReconciliation).toHaveBeenCalledWith(
      'r1',
      { decision: 'keep_current', manualValue: undefined, notes: undefined },
      adminCtx,
      expect.any(Function),
    );
    expect(writer.upsertProgramElementYear).not.toHaveBeenCalled();
    expect(res.resolved).toBe(true);
  });

  /*
   * Phase 7 Workstream K. The callback used to write straight into
   * program_element_year through the writer's manual_override source, which made
   * one admin's decision look like a parsed J-book line and flipped a winner
   * flag. It now records a governed proposal and touches nothing canonical.
   */
  test('resolve propose-callback records a governed proposal and never calls the writer', async () => {
    const { controller, service, writer, overrides } = makeController();
    service.resolveReconciliation.mockImplementation(
      async (
        _id: string,
        _input: unknown,
        _ctx: unknown,
        propose: (e: { peCode: string; fy: number; fieldName: string }, v: string) => Promise<string>,
      ) => {
        const overrideId = await propose({ peCode: '0601102A', fy: 2027, fieldName: 'hascMark' }, '250.5');
        return { resolved: false, pendingApproval: true, proposedOverrideId: overrideId };
      },
    );

    await controller.resolveReconciliation(adminCtx, 'r1', { decision: 'accept_conflicting' } as never);

    expect(writer.upsertProgramElementYear).not.toHaveBeenCalled();
    expect(overrides.insert).toHaveBeenCalledTimes(1);

    const [record] = overrides.insert.mock.calls[0] as [
      {
        value: { originalValue: string; originalUnit: string; valueMillions: string };
        governance: { authorActorId: string; approverActorId?: string };
      },
    ];
    expect(record).toMatchObject({
      canonicalEntity: 'canonical_rdte_program_element_year',
      naturalKey: '0601102A|2027',
      fiscalYear: 2027,
      fundingField: 'hascMark',
      status: 'proposed',
      version: 1,
    });
    // Exact decimal string, in millions, with no approver — it is a proposal.
    expect(record).toMatchObject({
      value: { originalValue: '250.5', originalUnit: 'millions', valueMillions: '250.5' },
    });
    expect(record.governance).toMatchObject({ authorActorId: adminCtx.userId });
    expect(record.governance.approverActorId).toBeUndefined();
  });

  test('a fractional JSON manualValue is a 400 rather than a rounded override', () => {
    const { controller, service } = makeController();
    // Thrown synchronously, before the service is ever reached — the value is
    // rejected at the boundary rather than rounded on the way in.
    expect(() =>
      controller.resolveReconciliation(adminCtx, 'r1', {
        decision: 'manual_value',
        manualValue: 250.5,
      } as never),
    ).toThrow(BadRequestException);
    expect(service.resolveReconciliation).not.toHaveBeenCalled();
  });

  test('an integer JSON manualValue is accepted, because its string form is exact', async () => {
    const { controller, service } = makeController();
    service.resolveReconciliation.mockResolvedValue({ resolved: false, pendingApproval: true });

    await controller.resolveReconciliation(adminCtx, 'r1', {
      decision: 'manual_value',
      manualValue: 199,
    } as never);

    expect(service.resolveReconciliation).toHaveBeenCalledWith(
      'r1',
      { decision: 'manual_value', manualValue: '199', notes: undefined },
      adminCtx,
      expect.any(Function),
    );
  });

  /** A complete proposed override, as the repository would return one. */
  const proposedOverride = (authorActorId: string) => ({
    schemaVersion: 'defense_budget_manual_override_v1',
    overrideId: 'ovr-1',
    canonicalEntity: 'canonical_rdte_program_element_year',
    naturalKey: '0601102A|2027',
    fiscalYear: 2027,
    fundingField: 'hascMark',
    value: { originalValue: '250.5', originalUnit: 'millions', valueMillions: '250.5' },
    governance: {
      authorActorId,
      reason: 'transposed in the published PDF',
      evidenceIds: ['reconciliation_review_queue:r1'],
    },
    status: 'proposed',
    version: 1,
    effectiveFrom: '2026-08-01T00:00:00.000Z',
    proposedAt: '2026-07-31T00:00:00.000Z',
  });

  test('POST approve puts the proposal in force through the governed path', async () => {
    const { controller, service, overrides } = makeController();
    overrides.findById.mockResolvedValue(proposedOverride('someone-else'));
    service.approveReconciliation.mockImplementation(
      async (_id: string, _ctx: unknown, approve: (o: string) => Promise<void>) => {
        await approve('ovr-1');
        return { approved: true, overrideId: 'ovr-1' };
      },
    );

    const res = await controller.approveReconciliation(adminCtx, 'r1');

    expect(overrides.markApproved).toHaveBeenCalledWith(
      expect.objectContaining({ overrideId: 'ovr-1', approverActorId: adminCtx.userId }),
    );
    expect(res.approved).toBe(true);
  });

  test('approving your own proposal is a 400, not a silent self-approval', async () => {
    const { controller, service, overrides } = makeController();
    overrides.findById.mockResolvedValue(proposedOverride(adminCtx.userId));
    service.approveReconciliation.mockImplementation(
      async (_id: string, _ctx: unknown, approve: (o: string) => Promise<void>) => {
        await approve('ovr-1');
        return { approved: true };
      },
    );

    await expect(controller.approveReconciliation(adminCtx, 'r1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(overrides.markApproved).not.toHaveBeenCalled();
  });

  test('admin reconciliation endpoints require capiro_admin → standard_user gets 403 (RolesGuard)', () => {
    const guard = new RolesGuard(new Reflector());
    const mkCtx = (role: TenantContext['role'], handler: unknown): ExecutionContext =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ tenantContext: { ...ctx, role } }) }),
        getHandler: () => handler,
        getClass: () => ProgramElementController,
      }) as unknown as ExecutionContext;

    for (const handler of [
      ProgramElementController.prototype.resolveReconciliation,
      ProgramElementController.prototype.reconciliationQueue,
    ]) {
      expect(() => guard.canActivate(mkCtx('standard_user', handler))).toThrow(ForbiddenException);
      expect(guard.canActivate(mkCtx('capiro_admin', handler))).toBe(true);
    }
  });

  test('GET /api/program-elements/:peCode/deltas delegates with filters', async () => {
    const { controller, service } = makeController();
    service.getDeltas.mockResolvedValue({
      data: [{ id: 'd1', deltaType: 'mark_vs_request' }],
      total: 1,
      page: 1,
      limit: 50,
    });

    const result = await controller.deltas('0601102A', {
      deltaType: 'mark_vs_request',
      fy: 2027,
      page: 1,
      limit: 50,
    } as never);

    expect(service.getDeltas).toHaveBeenCalledWith('0601102A', {
      deltaType: 'mark_vs_request',
      fy: 2027,
      page: 1,
      limit: 50,
    });
    expect(result.data[0]?.deltaType).toBe('mark_vs_request');
  });

  test('GET /api/program-elements/deltas/needs-attention delegates with tenant ctx', async () => {
    const { controller, service } = makeController();
    service.getNeedsAttention.mockResolvedValue({
      data: [{ id: 'd1', materialityScore: 0.8 }],
      total: 1,
      minScore: 0.4,
    });

    const result = await controller.needsAttention(ctx, { minScore: 0.4, fy: 2027, limit: 100 } as never);

    expect(service.getNeedsAttention).toHaveBeenCalledWith(ctx, { minScore: 0.4, fy: 2027, limit: 100 });
    expect(result.data[0]?.materialityScore).toBe(0.8);
  });

  test('POST/GET :peCode/data-issues route to dataIssues service', async () => {
    const { controller, dataIssues } = makeController();
    dataIssues.create.mockResolvedValueOnce({ id: 'i1', status: 'open' });
    dataIssues.listForPe.mockResolvedValueOnce({ data: [], total: 0, page: 1, limit: 25 });

    await controller.createDataIssue(ctx, '0603270a', {
      issueType: 'other',
      description: 'x',
    } as never);
    await controller.listDataIssues(ctx, '0603270a', {} as never);

    expect(dataIssues.create).toHaveBeenCalledWith(
      '0603270a',
      expect.objectContaining({ issueType: 'other', description: 'x' }),
      ctx,
    );
    expect(dataIssues.listForPe).toHaveBeenCalledWith('0603270a', ctx, expect.any(Object));
  });

  test('admin data-issue resolve is wired', async () => {
    const { controller, dataIssues } = makeController();
    dataIssues.resolve.mockResolvedValueOnce({ id: 'i1', status: 'resolved' });
    await controller.resolveDataIssue(adminCtx, 'i1', { status: 'resolved' } as never);
    expect(dataIssues.resolve).toHaveBeenCalledWith(
      'i1',
      { status: 'resolved', resolutionNotes: undefined },
      adminCtx,
    );
  });

});
