import { deriveRuleLifecycleStage, RULE_LIFECYCLE_STAGES } from '@capiro/shared';

describe('deriveRuleLifecycleStage (Phase 1 M4.2, both rails)', () => {
  const TODAY = new Date('2026-06-01T00:00:00Z');

  describe('federal FederalRegisterDocument.type', () => {
    it('PROPOSED_RULE with an open comment window is nprm', () => {
      expect(
        deriveRuleLifecycleStage({
          documentType: 'PROPOSED_RULE',
          commentEndDate: new Date('2026-07-01'),
          effectiveDate: null,
          today: TODAY,
        }),
      ).toBe('nprm');
    });

    it('PROPOSED_RULE past its comment deadline is comment_closed', () => {
      expect(
        deriveRuleLifecycleStage({
          documentType: 'PROPOSED_RULE',
          commentEndDate: new Date('2026-05-01'),
          effectiveDate: null,
          today: TODAY,
        }),
      ).toBe('comment_closed');
    });

    it('RULE not yet effective is final', () => {
      expect(
        deriveRuleLifecycleStage({
          documentType: 'RULE',
          commentEndDate: new Date('2026-04-01'),
          effectiveDate: new Date('2026-08-01'),
          today: TODAY,
        }),
      ).toBe('final');
    });

    it('RULE past its effective date is effective', () => {
      expect(
        deriveRuleLifecycleStage({
          documentType: 'RULE',
          commentEndDate: new Date('2026-04-01'),
          effectiveDate: new Date('2026-05-01'),
          today: TODAY,
        }),
      ).toBe('effective');
    });

    it('PRESIDENTIAL_DOCUMENT is self-executing — final until its effective date, then effective', () => {
      expect(
        deriveRuleLifecycleStage({
          documentType: 'PRESIDENTIAL_DOCUMENT',
          commentEndDate: null,
          effectiveDate: new Date('2026-09-01'),
          today: TODAY,
        }),
      ).toBe('final');
      expect(
        deriveRuleLifecycleStage({
          documentType: 'PRESIDENTIAL_DOCUMENT',
          commentEndDate: null,
          effectiveDate: new Date('2026-01-01'),
          today: TODAY,
        }),
      ).toBe('effective');
    });

    it('NOTICE (and any unrecognized type) sits at notice', () => {
      expect(
        deriveRuleLifecycleStage({
          documentType: 'NOTICE',
          commentEndDate: null,
          effectiveDate: null,
          today: TODAY,
        }),
      ).toBe('notice');
      expect(
        deriveRuleLifecycleStage({
          documentType: 'SOMETHING_UNKNOWN',
          commentEndDate: null,
          effectiveDate: null,
          today: TODAY,
        }),
      ).toBe('notice');
    });
  });

  describe('state StateRule.ruleType', () => {
    it('proposed with an open comment window is nprm', () => {
      expect(
        deriveRuleLifecycleStage({
          documentType: 'proposed',
          commentEndDate: new Date('2026-07-01'),
          effectiveDate: null,
          today: TODAY,
        }),
      ).toBe('nprm');
    });

    it('proposed past its comment deadline is comment_closed', () => {
      expect(
        deriveRuleLifecycleStage({
          documentType: 'proposed',
          commentEndDate: new Date('2026-05-01'),
          effectiveDate: null,
          today: TODAY,
        }),
      ).toBe('comment_closed');
    });

    it('final not yet effective is final; past its effective date is effective', () => {
      expect(
        deriveRuleLifecycleStage({
          documentType: 'final',
          commentEndDate: new Date('2026-04-01'),
          effectiveDate: new Date('2026-08-01'),
          today: TODAY,
        }),
      ).toBe('final');
      expect(
        deriveRuleLifecycleStage({
          documentType: 'final',
          commentEndDate: new Date('2026-04-01'),
          effectiveDate: new Date('2026-05-01'),
          today: TODAY,
        }),
      ).toBe('effective');
    });

    it('emergency and executive_order are self-executing, like a presidential document', () => {
      expect(
        deriveRuleLifecycleStage({
          documentType: 'emergency',
          commentEndDate: null,
          effectiveDate: new Date('2026-05-01'),
          today: TODAY,
        }),
      ).toBe('effective');
      expect(
        deriveRuleLifecycleStage({
          documentType: 'executive_order',
          commentEndDate: null,
          effectiveDate: new Date('2026-09-01'),
          today: TODAY,
        }),
      ).toBe('final');
    });

    it('notice sits at notice', () => {
      expect(
        deriveRuleLifecycleStage({
          documentType: 'notice',
          commentEndDate: null,
          effectiveDate: null,
          today: TODAY,
        }),
      ).toBe('notice');
    });
  });

  it('RULE_LIFECYCLE_STAGES enumerates the 5 stages in pipeline order', () => {
    expect(RULE_LIFECYCLE_STAGES.map((s) => s.key)).toEqual([
      'notice',
      'nprm',
      'comment_closed',
      'final',
      'effective',
    ]);
  });
});
