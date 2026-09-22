import { describe, expect, it } from '@jest/globals';
import { resolvePassageSelectionMode, validatePassageSelectionConfig } from './passage-selection';

const tenant = '11111111-1111-4111-8111-111111111111';

describe('passage selection rollout', () => {
  it('is dark unless the canonical tenant and surface are enrolled', () => {
    expect(resolvePassageSelectionMode({}, tenant, 'chat')).toBe('off');
    expect(resolvePassageSelectionMode({
      MERI_PASSAGE_SELECTION_MODE: 'enforce',
      MERI_PASSAGE_SELECTION_TENANTS: tenant,
      MERI_PASSAGE_SELECTION_SURFACES: 'chat',
    }, tenant, 'chat')).toBe('enforce');
    expect(resolvePassageSelectionMode({
      MERI_PASSAGE_SELECTION_MODE: 'shadow',
      MERI_PASSAGE_SELECTION_TENANTS: tenant,
      MERI_PASSAGE_SELECTION_SURFACES: 'research',
    }, tenant, 'chat')).toBe('off');
  });

  it('validates the capability-specific environment family', () => {
    expect(validatePassageSelectionConfig({
      MERI_PASSAGE_SELECTION_MODE: 'off',
      MERI_PASSAGE_SELECTION_TENANTS: '',
      MERI_PASSAGE_SELECTION_SURFACES: '',
    })).toEqual({ ok: true, issues: [] });
  });
});