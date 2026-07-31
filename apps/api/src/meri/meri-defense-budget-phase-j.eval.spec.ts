import {
  DEFENSE_BUDGET_DOMAIN_PRIMER,
  defenseBudgetExhibitLabel,
  isProcurementBudgetLine,
  isRdteBudgetLine,
} from '@capiro/shared';
import { buildFundingClaim } from '@capiro/shared/funding-claim';
import { validatePrimaryVehicleClaim } from './meri-pe-structural.helpers.js';
import {
  noReportLanguageCoverageNote,
  reportLanguageNoteForModel,
} from './meri-defense-budget-tool.helpers.js';

describe('Phase 7 deterministic government-affairs evaluation cases', () => {
  test('RDT&E versus procurement', () => {
    expect(isRdteBudgetLine({ peCode: '0604041F', appropriationType: 'RDT&E' })).toBe(true);
    expect(isProcurementBudgetLine({ peCode: '1507N2280' })).toBe(true);
    expect(defenseBudgetExhibitLabel({ peCode: '1507N2280' })).toContain('NOT a Program Element');
    expect(isRdteBudgetLine({ peCode: 'UNKNOWN', budgetActivity: 'BA 04' })).toBe(false);
  });

  test('current request versus FYDP outyear', () => {
    const current = buildFundingClaim({
      value: 100,
      fiscalYear: 2027,
      stage: 'request',
      currentCycleFy: 2027,
    });
    const outyear = buildFundingClaim({
      value: 120,
      fiscalYear: 2028,
      stage: 'request',
      currentCycleFy: 2027,
    });
    expect(current).toMatchObject({ cycleClass: 'current', isProjection: false });
    expect(outyear).toMatchObject({ cycleClass: 'outyear', isProjection: true });
  });

  test('authorization versus appropriations', () => {
    const authorization = buildFundingClaim({
      value: 90,
      fiscalYear: 2027,
      stage: 'hasc',
      currentCycleFy: 2027,
    });
    const appropriation = buildFundingClaim({
      value: 80,
      fiscalYear: 2027,
      stage: 'hacd',
      currentCycleFy: 2027,
    });
    expect(authorization.legislativeVehicle).toBe('authorization');
    expect(appropriation.legislativeVehicle).toBe('appropriations');
  });

  test('program-level report language', () => {
    expect(reportLanguageNoteForModel([{ matchScope: 'program_level' }])).toContain(
      'not exclusively to this budget line',
    );
  });

  test('no justification data', () => {
    expect(noReportLanguageCoverageNote()).toContain('loaded source coverage');
    expect(noReportLanguageCoverageNote()).toContain('not proof');
  });

  test('procurement POC', () => {
    expect(DEFENSE_BUDGET_DOMAIN_PRIMER).toContain(
      'A procurement POC may be shown as program context but must never be recommended as a lobbying target.',
    );
  });

  test('primary funding vehicle claim', () => {
    const warning = validatePrimaryVehicleClaim(
      { peCode: '0604041F', amountM: 10, fy: 2027, identifierKind: 'pe' },
      'PE 0604041F is the primary funding vehicle.',
      [
        {
          peCode: '1507N2280',
          amountM: 100,
          fy: 2027,
          identifierKind: 'procurement_line_item',
        },
      ],
    );
    expect(warning?.message).toContain('same fiscal year');
    expect(warning?.message).toContain('procurement line item 1507N2280');
  });
});
