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
  programElement: Record<string, jest.Mock>;
  searchProgramElements(ctx: TenantContext, input: Record<string, unknown>): Promise<any>;
  getProgramElementDetail(ctx: TenantContext, input: Record<string, unknown>): Promise<any>;
  getPeBudgetTimeline(input: Record<string, unknown>): Promise<any>;
  getPeReportLanguage(input: Record<string, unknown>): Promise<any>;
};

function harness(programElement: Record<string, jest.Mock>): ToolHarness {
  const service = Object.create(MeriToolsService.prototype) as ToolHarness;
  service.programElement = programElement;
  return service;
}

describe('MeriToolsService defense-budget model contract', () => {
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
