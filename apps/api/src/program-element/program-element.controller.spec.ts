import { ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { TenantContext } from '@capiro/shared';
import { ProgramElementController } from './program-element.controller.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { MANUAL_OVERRIDE_SOURCE } from './types.js';

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
    };
    const writer = { upsertProgramElementYear: jest.fn().mockResolvedValue({ inserted: false, changed: true }) };
    const dataIssues = {
      create: jest.fn(),
      listForPe: jest.fn(),
      listAdmin: jest.fn(),
      resolve: jest.fn(),
    };

    const controller = new ProgramElementController(service as never, writer as never, dataIssues as never);
    return { controller, service, writer, dataIssues };
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

  test('POST resolve delegates to the service with the normalized body + an apply callback', async () => {
    const { controller, service, writer } = makeController();
    service.resolveReconciliation.mockResolvedValue({ resolved: true, id: 'r1', decision: 'keep_current' });

    const res = await controller.resolveReconciliation(adminCtx, 'r1', { decision: 'keep_current' } as never);

    expect(service.resolveReconciliation).toHaveBeenCalledWith(
      'r1',
      { decision: 'keep_current', manualValue: undefined, notes: undefined },
      adminCtx,
      expect.any(Function),
    );
    // keep_current never invokes the apply callback (the service decides), so no writer call.
    expect(writer.upsertProgramElementYear).not.toHaveBeenCalled();
    expect(res.resolved).toBe(true);
  });

  test('resolve apply-callback writes the accepted value through the manual_override source', async () => {
    const { controller, service, writer } = makeController();
    // Drive the callback the controller passes, as the real service would for accept/manual.
    service.resolveReconciliation.mockImplementation(
      async (_id: string, _input: unknown, _ctx: unknown, applyAccepted: (p: string, f: number, n: string, v: number) => Promise<void>) => {
        await applyAccepted('0601102A', 2027, 'hascMark', 250.5);
        return { resolved: true };
      },
    );

    await controller.resolveReconciliation(adminCtx, 'r1', { decision: 'accept_conflicting' } as never);

    expect(writer.upsertProgramElementYear).toHaveBeenCalledWith(
      { peCode: '0601102A', fy: 2027, hascMark: 250.5 },
      MANUAL_OVERRIDE_SOURCE,
    );
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
