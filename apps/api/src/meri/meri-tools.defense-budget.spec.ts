import type { TenantContext } from '@capiro/shared';
import { MeriToolsService } from './meri-tools.service.js';

const ctx: TenantContext = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  tenantSlug: 'phase-j-test',
  userId: '00000000-0000-4000-8000-000000000002',
  clerkUserId: 'user_phase_j_test',
  role: 'standard_user',
};

type ToolHarness = {
  prisma: { budgetLineRelationship: { findMany: jest.Mock } };
  programElement: Record<string, jest.Mock>;
  logger: { warn: jest.Mock };
  searchProgramElements(ctx: TenantContext, input: Record<string, unknown>): Promise<any>;
  getProgramElementDetail(ctx: TenantContext, input: Record<string, unknown>): Promise<any>;
  getPeBudgetTimeline(input: Record<string, unknown>, ctx?: TenantContext): Promise<any>;
  getPeReportLanguage(input: Record<string, unknown>): Promise<any>;
};

function harness(programElement: Record<string, jest.Mock>): ToolHarness {
  const service = Object.create(MeriToolsService.prototype) as ToolHarness;
  service.prisma = { budgetLineRelationship: { findMany: jest.fn().mockResolvedValue([]) } };
  service.programElement = programElement;
  service.logger = { warn: jest.fn() };
  return service;
}

describe('MeriToolsService defense-budget model contract', () => {
  const accuracyEnv = process.env;
  afterEach(() => {
    process.env = accuracyEnv;
    jest.restoreAllMocks();
  });

  it('enforces canonical claim semantics and shadow logs once without changing output', async () => {
    const programElement = {
      listProgramElements: jest.fn().mockResolvedValue({
        data: [{ peCode: '0604041F', latestCurrent: 319.2, latestCurrentFy: 2027,
          latestCurrentStage: 'hacd', latestRequest: 300, latestRequestFy: 2027,
          latestEnacted: null, latestEnactedFy: null, deltaPct: null }],
        total: 1, page: 1, limit: 20,
      }),
    };
    process.env = { ...accuracyEnv, MERI_EVIDENCE_ACCURACY_MODE: 'enforce',
      MERI_EVIDENCE_ACCURACY_TENANTS: ctx.tenantId, MERI_EVIDENCE_ACCURACY_SURFACES: 'chat' };
    const enforced = await harness(programElement).searchProgramElements(ctx, {});
    expect(enforced.data[0].currentFundingClaim).toMatchObject({
      enactmentStatus: 'unknown', vehicleType: 'appropriation',
      semantics: 'stage=HAC-D (appropriation vehicle) FY2027 $319.2M enactment=unknown source=unknown',
    });

    process.env = { ...accuracyEnv, MERI_EVIDENCE_ACCURACY_MODE: 'shadow',
      MERI_EVIDENCE_ACCURACY_TENANTS: ctx.tenantId, MERI_EVIDENCE_ACCURACY_SURFACES: 'chat' };
    const shadowService = harness(programElement);
    const shadow = await shadowService.searchProgramElements(ctx, {});
    expect(shadow.data[0].currentFundingClaim).not.toHaveProperty('enactmentStatus');
    expect(shadowService.logger.warn).toHaveBeenCalledTimes(1);
    expect(shadowService.logger.warn).toHaveBeenCalledWith('meri.evidence_accuracy.shadow', expect.objectContaining({
      tool: 'search_program_elements', claims: 1, unknownEnactment: 1, withSource: 0,
    }));
  });
  it('search results use the shared noun and preserve a zero-dollar claim without guessing cycle', async () => {
    const service = harness({
      listProgramElements: jest.fn().mockResolvedValue({
        data: [
          {
            peCode: '1507N2280',
            title: 'Target Systems',
            appropriationType: null,
            budgetActivity: '07',
            lineType: null,
            latestCurrent: 0,
            latestCurrentFy: 2027,
            latestCurrentStage: 'request',
            latestRequest: 0,
            latestRequestFy: 2027,
            latestEnacted: null,
            latestEnactedFy: null,
            deltaPct: null,
            spark: [0],
          },
        ],
        total: 1,
        page: 1,
        limit: 20,
      }),
    });

    const result = await service.searchProgramElements(ctx, {});
    expect(result.data[0]).toMatchObject({
      peCode: '1507N2280',
      identifierKind: 'procurement_line_item',
      currentFundingClaim: {
        value: 0,
        fiscalYear: 2027,
        stage: 'request',
        legislativeVehicle: 'request',
        cycleClass: 'unknown',
      },
    });
    expect(result.data[0].budgetExhibitType).toContain('NOT a Program Element');
    expect(result.data[0]).not.toHaveProperty('spark');
  });

  it('detail uses the catalog current cycle instead of promoting the furthest FYDP request', async () => {
    const service = harness({
      getProgramElement: jest.fn().mockResolvedValue({
        peCode: '0604041F',
        appropriationType: 'RDT&E',
        budgetActivity: '04',
        lineType: 'RDTE_PE',
        currentCycleFy: 2027,
        years: [
          { fy: 2027, request: 100 },
          { fy: 2028, request: 120 },
        ],
      }),
    });

    const result = await service.getProgramElementDetail(ctx, { peCode: '0604041F' });
    expect(result).toMatchObject({
      identifierKind: 'pe',
      currentCycleFy: 2027,
      currentFundingClaim: {
        value: 100,
        fiscalYear: 2027,
        stage: 'request',
        cycleClass: 'current',
        isProjection: false,
      },
      budgetExhibitType: 'R-1/R-2 RDT&E Program Element',
    });
    expect(result.programElement.years[1].fundingClaim).toMatchObject({
      value: 120,
      fiscalYear: 2028,
      cycleClass: 'outyear',
      isProjection: true,
    });
    expect(result).not.toHaveProperty('lineage');
    expect(service.prisma.budgetLineRelationship.findMany).not.toHaveBeenCalled();
  });

  it('adds reviewed lineage only in enforce and keeps off output unchanged', async () => {
    const programElement = {
      getProgramElement: jest.fn().mockResolvedValue({
        peCode: '020400INTL', appropriationType: 'PROC', budgetActivity: '02',
        currentCycleFy: 2027, years: [{ fy: 2027, request: 319.241 }],
      }),
    };
    const offService = harness(programElement);
    const off = await offService.getProgramElementDetail(ctx, { peCode: '020400INTL' });
    expect(off).toEqual({
      tool: 'get_program_element',
      generatedAt: expect.any(String),
      identifierKind: 'procurement_line_item',
      budgetExhibitType: expect.stringContaining('NOT a Program Element'),
      currentCycleFy: 2027,
      currentFundingClaim: expect.objectContaining({
        value: 319.241, fiscalYear: 2027, stage: 'request', cycleClass: 'current',
      }),
      programElement: {
        peCode: '020400INTL', appropriationType: 'PROC', budgetActivity: '02',
        currentCycleFy: 2027,
        years: [expect.objectContaining({ fy: 2027, request: 319.241 })],
      },
    });
    expect(offService.prisma.budgetLineRelationship.findMany).not.toHaveBeenCalled();

    process.env = { ...accuracyEnv, MERI_EVIDENCE_ACCURACY_MODE: 'enforce',
      MERI_EVIDENCE_ACCURACY_TENANTS: ctx.tenantId, MERI_EVIDENCE_ACCURACY_SURFACES: 'chat' };
    const enforceService = harness(programElement);
    enforceService.prisma.budgetLineRelationship.findMany.mockResolvedValue([
      { relType: 'same_program', status: 'candidate', fromPeCode: '020400INTL', toPeCode: 'DCGS-SOF',
        transitionFyFrom: null, transitionFyTo: null, evidenceJson: [{ file: 'pseries.md' }] },
      { relType: 'predecessor_successor', status: 'accepted', fromPeCode: 'OLD', toPeCode: '020400INTL',
        transitionFyFrom: 2026, transitionFyTo: 2027, evidenceJson: [] },
    ]);
    const enforced = await enforceService.getProgramElementDetail(ctx, { peCode: '020400INTL' });
    expect(enforced.lineage).toEqual({
      accepted: [expect.objectContaining({ status: 'accepted', fromCode: 'OLD' })],
      candidates: [expect.objectContaining({ status: 'candidate', toCode: 'DCGS-SOF' })],
      note: 'Candidate lineage is unverified. A changed stage label or a shared narrative does not establish that one line was consolidated into another.',
    });
  });

  it('timeline classifies procurement lines and keeps marked outyears as projections', async () => {
    const service = harness({
      getTimeline: jest.fn().mockResolvedValue({
        peCode: '1507N2280',
        appropriationType: 'PROC',
        budgetActivity: '02',
        currentCycleFy: 2027,
        years: [
          { fy: 2027, request: 50, enacted: 40 },
          { fy: 2028, request: 55 },
        ],
      }),
    });

    const result = await service.getPeBudgetTimeline({ peCode: '1507N2280' });
    expect(result.identifierKind).toBe('procurement_line_item');
    expect(result.budgetExhibitType).toContain('NOT a Program Element');
    expect(result.years[1].fundingClaim).toMatchObject({
      cycleClass: 'outyear',
      isProjection: true,
    });
  });

  it('timeline shadow reads lineage for counts but omits it from output', async () => {
    process.env = { ...accuracyEnv, MERI_EVIDENCE_ACCURACY_MODE: 'shadow',
      MERI_EVIDENCE_ACCURACY_TENANTS: ctx.tenantId, MERI_EVIDENCE_ACCURACY_SURFACES: 'chat' };
    const service = harness({ getTimeline: jest.fn().mockResolvedValue({
      peCode: 'LINE', appropriationType: 'PROC', budgetActivity: '02', currentCycleFy: 2027,
      years: [{ fy: 2027, request: 1 }],
    }) });
    service.prisma.budgetLineRelationship.findMany.mockResolvedValue([
      { relType: 'same_program', status: 'candidate', fromPeCode: 'LINE', toPeCode: 'OTHER',
        transitionFyFrom: null, transitionFyTo: null, evidenceJson: [] },
    ]);
    const result = await service.getPeBudgetTimeline({ peCode: 'LINE' }, ctx);
    expect(result).not.toHaveProperty('lineage');
    expect(service.logger.warn).toHaveBeenCalledWith('meri.evidence_accuracy.shadow',
      expect.objectContaining({ lineageAccepted: 0, lineageCandidates: 1 }));

    process.env = { ...accuracyEnv, MERI_EVIDENCE_ACCURACY_MODE: 'enforce',
      MERI_EVIDENCE_ACCURACY_TENANTS: ctx.tenantId, MERI_EVIDENCE_ACCURACY_SURFACES: 'chat' };
    const enforced = await service.getPeBudgetTimeline({ peCode: 'LINE' }, ctx);
    expect(enforced.lineage).toEqual({
      accepted: [],
      candidates: [expect.objectContaining({ status: 'candidate', toCode: 'OTHER' })],
      note: 'Candidate lineage is unverified. A changed stage label or a shared narrative does not establish that one line was consolidated into another.',
    });
  });

  it('report language empty path discloses loaded-source limits; program_level stays non-exclusive', async () => {
    const empty = harness({
      getProvisionsForPe: jest.fn().mockResolvedValue([]),
    });
    const emptyNote = (await empty.getPeReportLanguage({ peCode: '0604041F' })).note as string;
    expect(emptyNote.toLowerCase()).toContain('loaded source');
    expect(emptyNote.toLowerCase()).toContain('does not currently load');

    const program = harness({
      getProvisionsForPe: jest.fn().mockResolvedValue([{ matchScope: 'program_level', text: 'x' }]),
    });
    const note = (await program.getPeReportLanguage({ peCode: '0604041F' })).note as string;
    expect(note).toContain('not exclusively to this budget line');
  });
});
