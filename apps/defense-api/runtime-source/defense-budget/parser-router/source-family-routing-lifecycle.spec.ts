import { routingForLifecycleSource, routingForSourceFamily } from './source-family-routing.js';

describe('lifecycle-aware congressional source routing', () => {
  it.each([
    ['authorization', 'hasc_mark', 'auth_committee_mark', 'hasc'],
    ['authorization', 'sasc_report', 'auth_committee_report', 'sasc'],
    ['appropriations', 'hac_d_mark', 'appr_committee_mark', 'hac_d'],
    ['appropriations', 'sac_d_report', 'appr_committee_report', 'sac_d'],
  ] as const)('routes %s/%s/%s to %s', (track, stage, family, committee) => {
    const route = routingForLifecycleSource(track, stage, family);
    expect(route.budgetCycle).toBe(committee);
    expect(route.authority).toBe(committee);
  });

  it('routes both conference families to their conference authorities', () => {
    expect(
      routingForLifecycleSource('authorization', 'auth_conference', 'auth_conference_report'),
    ).toMatchObject({
      budgetCycle: 'conference',
      documentType: 'conference_report',
      authority: 'ndaa_conference',
    });
    expect(
      routingForLifecycleSource('appropriations', 'appr_conference_or_jes', 'appr_conference_jes'),
    ).toMatchObject({
      budgetCycle: 'conference',
      documentType: 'conference_jes',
      authority: 'appropriations_conference',
    });
  });

  it.each([
    ['appropriations', 'hasc_mark', 'auth_committee_mark'],
    ['authorization', 'sasc_mark', 'appr_committee_mark'],
    ['authorization', 'auth_conference', 'appr_conference_jes'],
    ['authorization', 'hasc_mark', 'auth_committee_report'],
  ] as const)('rejects inconsistent or unsupported %s/%s/%s', (track, stage, family) => {
    expect(() => routingForLifecycleSource(track, stage, family)).toThrow(
      /Invalid congressional routing/,
    );
  });

  it.each([
    ['authorization', 'auth_enacted', 'auth_public_law'],
    ['appropriations', 'appr_enacted', 'appr_public_law'],
  ] as const)(
    'keeps native statutory composition mandatory for %s/%s/%s',
    (track, stage, family) => {
      expect(() => routingForLifecycleSource(track, stage, family)).toThrow(
        /native statutory composition/,
      );
    },
  );

  it('keeps the static mapping for non-congressional sources', () => {
    expect(routingForLifecycleSource('request', 'president_budget_request', 'pb_r1')).toEqual(
      routingForSourceFamily('pb_r1'),
    );
  });
});
