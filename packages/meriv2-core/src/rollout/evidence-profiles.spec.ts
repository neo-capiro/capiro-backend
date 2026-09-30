import { describe, expect, it } from '@jest/globals';
import { resolveEvidenceProfilesMode, validateEvidenceProfilesConfig } from './evidence-profiles';

const tenant = '11111111-1111-4111-8111-111111111111';

describe('evidence profiles rollout', () => {
  it('is dark unless the canonical tenant and surface are enrolled', () => {
    expect(resolveEvidenceProfilesMode({}, tenant, 'chat')).toBe('off');
    expect(
      resolveEvidenceProfilesMode(
        {
          MERI_EVIDENCE_PROFILES_MODE: 'enforce',
          MERI_EVIDENCE_PROFILES_TENANTS: tenant,
          MERI_EVIDENCE_PROFILES_SURFACES: 'chat',
        },
        tenant,
        'chat',
      ),
    ).toBe('enforce');
    expect(
      resolveEvidenceProfilesMode(
        {
          MERI_EVIDENCE_PROFILES_MODE: 'shadow',
          MERI_EVIDENCE_PROFILES_TENANTS: tenant,
          MERI_EVIDENCE_PROFILES_SURFACES: 'research',
        },
        tenant,
        'chat',
      ),
    ).toBe('off');
  });

  it('validates the capability-specific environment family', () => {
    expect(
      validateEvidenceProfilesConfig({
        MERI_EVIDENCE_PROFILES_MODE: 'off',
        MERI_EVIDENCE_PROFILES_TENANTS: '',
        MERI_EVIDENCE_PROFILES_SURFACES: '',
      }),
    ).toEqual({ ok: true, issues: [] });
  });
});
