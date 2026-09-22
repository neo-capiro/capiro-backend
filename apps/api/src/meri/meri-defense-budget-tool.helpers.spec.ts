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

  it('uses the ladder claim in legacy and the read-service provenance claim in enforce', () => {
    const provenanceClaim = {
      value: 77,
      fiscalYear: 2027,
      stage: 'enacted' as const,
      stageLabel: 'Enacted',
      legislativeVehicle: 'enacted' as const,
      cycleClass: 'current' as const,
      isProjection: false,
      unit: 'USD millions' as const,
      enactmentStatus: 'enacted' as const,
      vehicleType: 'appropriation' as const,
      originalUnit: 'thousands' as const,
      originalValue: 77_000,
      source: {
        sourceDocumentId: 'doc-1',
        documentType: 'R-2',
        budgetCycle: 'PB27',
        publisher: 'USAF',
        sourceUrl: 'https://example.test/r2.pdf',
        pageNumber: 9,
        observedAt: '2026-03-01T00:00:00.000Z',
      },
    };
    const row = { fy: 2027, request: 10, hacDMark: 8, fundingClaim: provenanceClaim };

    expect(fundingClaimsForModel([row], 2027, 'legacy').years[0]?.fundingClaim).toEqual({
      value: 8,
      fiscalYear: 2027,
      stage: 'hacd',
      stageLabel: 'HAC-D',
      legislativeVehicle: 'appropriations',
      cycleClass: 'current',
      isProjection: false,
      unit: 'USD millions',
    });
    expect(fundingClaimsForModel([row], 2027, 'enforce').years[0]?.fundingClaim).toMatchObject({
      ...provenanceClaim,
      semantics: expect.stringContaining('source=R-2/USAF p.9'),
    });
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

  it('rejects non-finite money and keeps unmapped stages null in legacy mode', () => {
    expect(searchFundingClaimForModel({ valueM: NaN, fy: 2027, stage: 'request' })).toBeNull();
    expect(searchFundingClaimForModel({ valueM: 1, fy: 2027, stage: 'mystery' })).toBeNull();
  });

  it('preserves unmapped stages as explicit unknown claims in enforce mode', () => {
    const claim = searchFundingClaimForModel(
      { valueM: 1, fy: 2027, stage: 'mystery' },
      'enforce',
    );
    expect(claim).toMatchObject({
      stage: 'none',
      enactmentStatus: 'unknown',
      vehicleType: 'unknown',
    });
    expect(fundingClaimForOutput(claim, 'enforce')?.semantics).toContain('stage=unmapped');
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
