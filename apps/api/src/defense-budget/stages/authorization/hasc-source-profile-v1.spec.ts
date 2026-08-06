import {
  createHascSourceProfileV1,
  hascSourceProfileHashV1,
} from './hasc-source-profile-v1.js';
import { requestOwnershipAllowedForAuthority } from '../stage-source-profile-v1.js';

const INPUT = {
  fiscalYear: 2027,
  reportNumber: 'H. Rept. 119-000',
  sourceDocumentKeys: ['hasc_fy2027_report'],
};

describe('HASC source profile V1', () => {
  it('fixes the authorization track, House chamber, and HASC-owned field', () => {
    const profile = createHascSourceProfileV1(INPUT);
    expect(profile.track).toBe('authorization');
    expect(profile.stage).toBe('hasc');
    expect(profile.authority).toBe('hasc_authorization');
    expect(profile.chamber).toBe('house');
    expect(profile.vehicleClass).toBe('committee_report');
  });

  it('covers all four native line families and general provisions', () => {
    expect(createHascSourceProfileV1(INPUT).requiredLineFamilies).toEqual([
      'rdte_pe',
      'procurement_blin',
      'om_sag',
      'milcon_project',
      'general_provisions',
    ]);
  });

  it('never permits HASC to own the President Budget request field', () => {
    expect(requestOwnershipAllowedForAuthority('hasc_authorization')).toBe(false);
  });

  it('hashes deterministically', () => {
    expect(hascSourceProfileHashV1(INPUT)).toBe(hascSourceProfileHashV1({ ...INPUT }));
  });
});
