import { describe, expect, it } from '@jest/globals';
import { resolveAutoCorrectionMode, validateAutoCorrectionConfig } from './auto-correction';

const tenant = '11111111-1111-4111-8111-111111111111';

describe('automatic correction rollout', () => {
  it('defaults/fails closed unless tenant and surface are enrolled', () => {
    expect(resolveAutoCorrectionMode({}, tenant, 'chat')).toBe('off');
    expect(resolveAutoCorrectionMode({
      MERI_AUTO_CORRECTION_MODE: 'shadow',
      MERI_AUTO_CORRECTION_TENANTS: tenant,
      MERI_AUTO_CORRECTION_SURFACES: 'chat',
    }, tenant, 'chat')).toBe('shadow');
  });

  it('validates the capability-specific environment family', () => {
    expect(validateAutoCorrectionConfig({
      MERI_AUTO_CORRECTION_MODE: 'off',
      MERI_AUTO_CORRECTION_TENANTS: '',
      MERI_AUTO_CORRECTION_SURFACES: '',
    })).toEqual({ ok: true, issues: [] });
  });
});
