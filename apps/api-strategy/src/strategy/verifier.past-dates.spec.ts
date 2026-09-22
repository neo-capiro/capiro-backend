import { verifyPlan, type VerifierNode, type VerifyPlanInput } from '@capiro/strategy-verifier';

const milestone: VerifierNode = {
  id: 'submit', kind: 'milestone', subject: 'submission', title: 'Submit package',
  startsOn: '2026-09-09', endsOn: null, dependsOnIds: [],
};
const input = (today: string | null): VerifyPlanInput => ({
  strategyType: 'authorization', nodes: [milestone],
  fiscal: { today, fys: [2027], fyLabels: ['FY27'], focalFy: 'FY27' },
});

describe('verifyPlan past-date option', () => {
  test('defaults off and preserves existing behavior', () => {
    expect(verifyPlan(input('2026-09-10')).violations.map((item) => item.code)).not.toContain('milestone-past-date');
  });

  test('flags a past milestone only when opted in with a usable today', () => {
    expect(verifyPlan(input('2026-09-10'), { enforcePastDates: true }).violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'milestone-past-date', nodeIds: ['submit'] })]),
    );
    expect(verifyPlan(input(null), { enforcePastDates: true }).violations.map((item) => item.code)).not.toContain('milestone-past-date');
  });
});