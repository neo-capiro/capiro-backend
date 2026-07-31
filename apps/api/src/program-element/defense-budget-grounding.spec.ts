import { describe, expect, test } from '@jest/globals';
import {
  DEFENSE_BUDGET_DOMAIN_PRIMER,
  defenseBudgetExhibitLabel,
  isProcurementBudgetLine,
  isRdteBudgetLine,
  PE_SOURCE_FAMILY_COVERAGE,
  peSourceCoverageModelCaveat,
  sourceKeyForbiddenForCanonical,
} from '@capiro/shared';

describe('Phase 7 shared defense-budget classifier', () => {
  test('does not classify RDT&E from BA4 alone', () => {
    expect(isRdteBudgetLine({ peCode: 'UNKNOWN', budgetActivity: 'BA 04' })).toBe(false);
    expect(isRdteBudgetLine({ peCode: 'UNKNOWN', budgetActivity: '4' })).toBe(false);
    expect(defenseBudgetExhibitLabel({ peCode: 'UNKNOWN', budgetActivity: '04' })).toBe(
      'budget line (exhibit type not classified)',
    );
  });

  test('classifies RDT&E by appropriation or R-1 code shape', () => {
    expect(isRdteBudgetLine({ peCode: '0604041F', appropriationType: 'RDT&E' })).toBe(true);
    expect(isRdteBudgetLine({ peCode: '0603270A' })).toBe(true);
    expect(defenseBudgetExhibitLabel({ peCode: '0603270A' })).toBe('R-1/R-2 RDT&E Program Element');
  });

  test('never calls procurement lines Program Elements', () => {
    expect(isProcurementBudgetLine({ peCode: '1507N2280' })).toBe(true);
    expect(defenseBudgetExhibitLabel({ peCode: '1507N2280' })).toContain('NOT a Program Element');
    expect(defenseBudgetExhibitLabel({ peCode: '1242C93000', appropriationType: 'PROC' })).toContain(
      'NOT a Program Element',
    );
  });

  test('explicit lineType wins over conflicting appropriation/code shape', () => {
    expect(
      isRdteBudgetLine({
        peCode: '5726K99200',
        appropriationType: 'Procurement',
        lineType: 'RDTE_PE',
      }),
    ).toBe(true);
  });

  test('primer forbids BA4-only RDT&E, procurement POC lobbying, stays compact', () => {
    expect(DEFENSE_BUDGET_DOMAIN_PRIMER.length).toBeLessThanOrEqual(2000);
    expect(DEFENSE_BUDGET_DOMAIN_PRIMER.length).toBeGreaterThan(200);
    const p = DEFENSE_BUDGET_DOMAIN_PRIMER.toLowerCase();
    expect(p).toContain('budget activity 4 alone');
    expect(p).toContain('not program elements');
    expect(p).toContain('authorization and appropriations');
    expect(DEFENSE_BUDGET_DOMAIN_PRIMER).toContain(
      'A procurement POC may be shown as program context but must never be recommended as a lobbying target.',
    );
    expect(p).toContain('unsupported');
  });
});

describe('Phase 7 Phase L source coverage fail-closed', () => {
  test('matrix documents L1–L7 families', () => {
    const ids = new Set(PE_SOURCE_FAMILY_COVERAGE.map((r) => r.id));
    for (const id of [
      'defense_approps_conference_jes',
      'full_fydp_projection',
      'execution_reprogramming_feeds',
      'procurement_performer_coverage',
      'milcon_c1',
      'reserve_exhibits',
      'p5_p21_p3a_op5_gaps',
    ]) {
      expect(ids.has(id)).toBe(true);
    }
  });

  test('unsupported/blocked prefixes cannot write canonical', () => {
    expect(sourceKeyForbiddenForCanonical('milcon_army_fy27')).toBe(true);
    expect(sourceKeyForbiddenForCanonical('execution_feed_q1')).toBe(true);
    expect(sourceKeyForbiddenForCanonical('p5_unreviewed_fixture')).toBe(true);
    expect(sourceKeyForbiddenForCanonical('r_doc_army_fy27')).toBe(false);
    expect(sourceKeyForbiddenForCanonical('mystery_scrape')).toBe(false);
  });

  test('model caveat names unavailable families without implying they are loaded', () => {
    const caveat = peSourceCoverageModelCaveat().toLowerCase();
    expect(caveat).toContain('does not currently load');
    expect(caveat).toContain('milcon');
  });
});
