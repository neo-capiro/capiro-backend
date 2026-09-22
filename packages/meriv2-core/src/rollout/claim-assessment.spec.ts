import { describe, expect, it } from '@jest/globals';
import { resolveClaimAssessmentMode } from './claim-assessment';

const TENANT = '17b63099-bc0f-4ac5-b596-496161e9481e';

describe('claim assessment rollout', () => {
  it.each([
    ['off', TENANT, 'chat', 'off'],
    ['shadow', TENANT, 'chat', 'shadow'],
    ['enforce', TENANT, 'chat', 'enforce'],
    ['shadow', '', 'chat', 'off'],
    ['shadow', TENANT, '', 'off'],
    ['junk', TENANT, 'chat', 'off'],
  ])('resolves %s / %s / %s to %s', (mode, tenants, surfaces, expected) => {
    expect(resolveClaimAssessmentMode({
      MERI_CLAIM_ASSESSMENT_MODE: mode,
      MERI_CLAIM_ASSESSMENT_TENANTS: tenants,
      MERI_CLAIM_ASSESSMENT_SURFACES: surfaces,
    }, TENANT, 'chat')).toBe(expected);
  });

  it('does not enroll a different tenant or surface', () => {
    const env = { MERI_CLAIM_ASSESSMENT_MODE: 'shadow', MERI_CLAIM_ASSESSMENT_TENANTS: TENANT,
      MERI_CLAIM_ASSESSMENT_SURFACES: 'chat' };
    expect(resolveClaimAssessmentMode(env, 'c60da102-8c0e-4590-a356-686784f7c51f', 'chat')).toBe('off');
    expect(resolveClaimAssessmentMode(env, TENANT, 'strategy')).toBe('off');
  });
});
