import { requestOwnershipAllowedForAuthority } from '../stage-source-profile-v1.js';
import {
  createSascSourceProfileV1,
  sascSourceProfileHashV1,
} from './sasc-source-profile-v1.js';

const INPUT = {
  fiscalYear: 2027,
  reportNumber: 'S. Rept. 119-39',
  sourceDocumentKeys: ['sasc_fy2027_report'],
};

describe('SASC source profile V1', () => {
  it('fixes the authorization track, Senate chamber, and SASC authority', () => {
    const profile = createSascSourceProfileV1(INPUT);
    expect(profile.track).toBe('authorization');
    expect(profile.stage).toBe('sasc');
    expect(profile.authority).toBe('sasc_authorization');
    expect(profile.chamber).toBe('senate');
    expect(profile.vehicleClass).toBe('committee_report');
  });

  it('covers all four native line families and general provisions', () => {
    expect(createSascSourceProfileV1(INPUT).requiredLineFamilies).toEqual([
      'rdte_pe',
      'procurement_blin',
      'om_sag',
      'milcon_project',
      'general_provisions',
    ]);
  });

  it('never permits SASC to own the President Budget request field', () => {
    expect(requestOwnershipAllowedForAuthority('sasc_authorization')).toBe(false);
  });

  it('hashes deterministically', () => {
    expect(sascSourceProfileHashV1(INPUT)).toBe(sascSourceProfileHashV1({ ...INPUT }));
  });
});
