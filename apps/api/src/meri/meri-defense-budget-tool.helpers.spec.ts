import {
  fundingClaimForOutput,
  fundingClaimsForModel,
  modelBudgetLineMetadata,
  noReportLanguageCoverageNote,
  reportLanguageNoteForModel,
  searchFundingClaimForModel,
} from './meri-defense-budget-tool.helpers.js';

describe('modelBudgetLineMetadata', () => {
  it('uses explicit line type before appropriation and code shape', () => {
    expect(
      modelBudgetLineMetadata({
        peCode: '5726K99200',
        appropriationType: 'Procurement',
        lineType: 'RDTE_PE',
      }),
    ).toEqual({
      identifierKind: 'pe',
      budgetExhibitType: 'R-1/R-2 RDT&E Program Element',
    });
  });

  it('keeps procurement line items distinct from Program Elements', () => {
    const metadata = modelBudgetLineMetadata({ peCode: '1507N2280' });
    expect(metadata.identifierKind).toBe('procurement_line_item');
    expect(metadata.budgetExhibitType).toContain('NOT a Program Element');
  });

  it('does not classify BA4 alone', () => {
    expect(modelBudgetLineMetadata({ peCode: 'UNKNOWN', budgetActivity: 'BA 04' })).toEqual({
      identifierKind: 'other',
      budgetExhibitType: 'budget line (exhibit type not classified)',
    });
  });
});

describe('fundingClaimsForModel', () => {
  it('keeps legacy shape under off and adds exact semantics under enforce', () => {
    const claim = searchFundingClaimForModel({ valueM: 319.2, fy: 2027, stage: 'hacd' })!;
    expect(fundingClaimForOutput(claim, 'legacy')).toEqual({
      value: 319.2,
      fiscalYear: 2027,
      stage: 'hacd',
      stageLabel: 'HAC-D',
      legislativeVehicle: 'appropriations',
      cycleClass: 'unknown',
      isProjection: false,
      unit: 'USD millions',
    });
    expect(fundingClaimForOutput(claim, 'enforce')).toMatchObject({
      enactmentStatus: 'unknown',
      vehicleType: 'appropriation',
      semantics: 'stage=HAC-D (appropriation vehicle) FY2027 $319.2M enactment=unknown source=unknown',
    });
  });
  it('labels historical, current, and request-only outyear rows without dropping zero', () => {
    const result = fundingClaimsForModel([
      { fy: 2026, request: 5, enacted: 0 },
      { fy: 2027, request: 10, hacDMark: 8 },
      { fy: 2028, request: 12 },
    ]);

    expect(result.currentCycleFy).toBe(2027);
    expect(result.currentFundingClaim).toMatchObject({
      value: 8,
      fiscalYear: 2027,
      stage: 'hacd',
      legislativeVehicle: 'appropriations',
      cycleClass: 'current',
      isProjection: false,
      unit: 'USD millions',
    });
    expect(result.years[0]?.fundingClaim).toMatchObject({
      value: 0,
      stage: 'enacted',
      cycleClass: 'historical',
    });
    expect(result.years[2]?.fundingClaim).toMatchObject({
      value: 12,
      stage: 'request',
      legislativeVehicle: 'request',
      cycleClass: 'outyear',
      isProjection: true,
    });
  });

  it('keeps an explicitly unknown current cycle unknown instead of promoting the furthest request', () => {
    const result = fundingClaimsForModel(
      [
        { fy: 2027, request: 10 },
        { fy: 2028, request: 12 },
      ],
      null,
    );
    expect(result.currentCycleFy).toBeNull();
    expect(result.currentFundingClaim).toBeNull();
    expect(result.years.map((row) => row.fundingClaim?.cycleClass)).toEqual([
      'unknown',
      'unknown',
    ]);
  });
});

describe('searchFundingClaimForModel', () => {
  it('returns a stage-labeled claim with unknown cycle (finder has no catalog FY)', () => {
    expect(
      searchFundingClaimForModel({ valueM: 0, fy: 2027, stage: 'request' }),
    ).toMatchObject({
      value: 0,
      fiscalYear: 2027,
      stage: 'request',
      legislativeVehicle: 'request',
      cycleClass: 'unknown',
      isProjection: false,
    });
  });

  it('rejects non-finite money and preserves unmapped stages as explicit unknown claims', () => {
    expect(searchFundingClaimForModel({ valueM: NaN, fy: 2027, stage: 'request' })).toBeNull();
    expect(searchFundingClaimForModel({ valueM: 1, fy: 2027, stage: 'mystery' })).toMatchObject({
      stage: 'none',
      enactmentStatus: 'unknown',
      vehicleType: 'unknown',
    });
  });
});

describe('report language coverage notes', () => {
  it('refuses to invent justification and discloses unloaded families', () => {
    const note = noReportLanguageCoverageNote();
    expect(note).toContain('loaded source coverage');
    expect(note).toContain('not proof');
    expect(note.toLowerCase()).toContain('does not currently load');
  });

  it('flags program-level matches without exclusive PE attribution', () => {
    expect(reportLanguageNoteForModel([{ matchScope: 'program_level' }])).toContain(
      'not exclusively to this budget line',
    );
    expect(reportLanguageNoteForModel([{ matchScope: 'exact' }])).toBeUndefined();
  });
});
