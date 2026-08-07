import { createHacdSourceProfileV1 } from '../hacd/hacd-source-profile-v1.js';
import { STAGE_AUTHORITY_FIELD, STAGE_CHAMBER, STAGE_TRACK } from '../../stage-vocabulary-v1.js';
import { createSacdSourceProfileV1, sacdSourceProfileHashV1 } from './sacd-source-profile-v1.js';

describe('SAC-D source profile V1', () => {
  const input = {
    fiscalYear: 2027,
    reportNumber: 'S. Rept. 119-200',
    sourceDocumentKeys: ['sacd_fy2027'],
  };

  it('binds Senate appropriations semantics and sacDMark ownership', () => {
    const profile = createSacdSourceProfileV1(input);
    expect(profile).toMatchObject({
      track: 'appropriations',
      stage: 'sac_d',
      authority: 'sacd_appropriations',
      chamber: 'senate',
      vehicleClass: 'committee_report',
    });
    expect(STAGE_TRACK[profile.stage]).toBe('appropriations');
    expect(STAGE_CHAMBER[profile.stage]).toBe('senate');
    expect(STAGE_AUTHORITY_FIELD[profile.authority]).toBe('sacDMark');
    expect(profile.requiredLineFamilies).toEqual(
      expect.arrayContaining(['rdte_pe', 'procurement_blin', 'om_sag', 'milcon_project']),
    );
  });

  it('hashes deterministically', () => {
    expect(sacdSourceProfileHashV1(input)).toBe(sacdSourceProfileHashV1(input));
  });

  it('is not interchangeable with HAC-D', () => {
    const hacd = createHacdSourceProfileV1({
      fiscalYear: 2027,
      reportNumber: 'H. Rept. 119-715',
      sourceDocumentKeys: ['hacd_fy2027'],
    });
    const sacd = createSacdSourceProfileV1(input);
    expect(sacd.stage).not.toBe(hacd.stage);
    expect(sacd.chamber).not.toBe(hacd.chamber);
    expect(STAGE_AUTHORITY_FIELD[sacd.authority]).not.toBe(STAGE_AUTHORITY_FIELD[hacd.authority]);
  });
});
