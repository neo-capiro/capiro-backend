import { requestOwnershipAllowedForAuthority } from '../../stage-source-profile-v1.js';
import { createHacdSourceProfileV1, hacdSourceProfileHashV1 } from './hacd-source-profile-v1.js';

const INPUT = {
  fiscalYear: 2027,
  reportNumber: 'H. Rept. 119-715',
  sourceDocumentKeys: ['hacd_fy2027_report'],
};

describe('HAC-D source profile V1', () => {
  it('fixes the appropriations track, House chamber, and HAC-D authority', () => {
    const profile = createHacdSourceProfileV1(INPUT);
    expect(profile.track).toBe('appropriations');
    expect(profile.stage).toBe('hac_d');
    expect(profile.authority).toBe('hacd_appropriations');
    expect(profile.chamber).toBe('house');
    expect(profile.vehicleClass).toBe('committee_report');
  });

  it('requires native line families plus general provisions and classified coverage', () => {
    expect(createHacdSourceProfileV1(INPUT).requiredLineFamilies).toEqual([
      'rdte_pe',
      'procurement_blin',
      'om_sag',
      'milcon_project',
      'general_provisions',
      'classified',
    ]);
  });

  it('never permits HAC-D to own the President Budget request field', () => {
    expect(requestOwnershipAllowedForAuthority('hacd_appropriations')).toBe(false);
  });

  it('hashes deterministically', () => {
    expect(hacdSourceProfileHashV1(INPUT)).toBe(hacdSourceProfileHashV1({ ...INPUT }));
  });
});
