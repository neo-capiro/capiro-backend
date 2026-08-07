import { requestOwnershipAllowedForAuthority } from '../../stage-source-profile-v1.js';
import {
  createNdaaConferenceSourceProfileV1,
  ndaaConferenceSourceProfileHashV1,
} from './ndaa-conference-source-profile-v1.js';

const INPUT = {
  fiscalYear: 2027,
  billId: 'H.R. 5000',
  reportNumber: 'H. Rept. 119-500',
  conferenceReportDocumentKey: 'ndaa_conf_fy2027',
  jointExplanatoryStatementDocumentKey: 'ndaa_jes_fy2027',
};

describe('NDAA conference source profile V1', () => {
  it('fixes joint authorization ownership and both chamber comparisons', () => {
    const profile = createNdaaConferenceSourceProfileV1(INPUT);
    expect(profile.track).toBe('authorization');
    expect(profile.stage).toBe('ndaa_conference');
    expect(profile.authority).toBe('ndaa_conference_authorization');
    expect(profile.chamber).toBe('joint');
    expect(profile.requiredComparisonStages).toEqual(['hasc', 'sasc']);
  });

  it('requires the JES companion when separately declared', () => {
    const profile = createNdaaConferenceSourceProfileV1(INPUT);
    expect(profile.companionDocuments).toEqual([
      {
        companionKind: 'joint_explanatory_statement',
        manifestDocumentKey: 'ndaa_jes_fy2027',
        required: true,
      },
    ]);
  });

  it('never permits conference authority to own the request field', () => {
    expect(requestOwnershipAllowedForAuthority('ndaa_conference_authorization')).toBe(false);
  });

  it('hashes deterministically', () => {
    expect(ndaaConferenceSourceProfileHashV1(INPUT)).toBe(
      ndaaConferenceSourceProfileHashV1({ ...INPUT }),
    );
  });
});
