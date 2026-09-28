import { describe, expect, it } from '@jest/globals';
import { resolveMatchLabelMode, validateMatchLabelConfig } from './match-label';

const tenant = '11111111-1111-4111-8111-111111111111';

describe('match label rollout (Stage 4a design, no caller yet)', () => {
  it('is dark unless the canonical tenant and surface are enrolled', () => {
    expect(resolveMatchLabelMode({}, tenant, 'chat')).toBe('off');
    expect(
      resolveMatchLabelMode(
        {
          MERI_MATCH_LABEL_MODE: 'enforce',
          MERI_MATCH_LABEL_TENANTS: tenant,
          MERI_MATCH_LABEL_SURFACES: 'chat',
        },
        tenant,
        'chat',
      ),
    ).toBe('enforce');
    expect(
      resolveMatchLabelMode(
        {
          MERI_MATCH_LABEL_MODE: 'shadow',
          MERI_MATCH_LABEL_TENANTS: tenant,
          MERI_MATCH_LABEL_SURFACES: 'research',
        },
        tenant,
        'chat',
      ),
    ).toBe('off');
  });

  it('validates the capability-specific environment family', () => {
    expect(
      validateMatchLabelConfig({
        MERI_MATCH_LABEL_MODE: 'off',
        MERI_MATCH_LABEL_TENANTS: '',
        MERI_MATCH_LABEL_SURFACES: '',
      }),
    ).toEqual({ ok: true, issues: [] });
  });
});
