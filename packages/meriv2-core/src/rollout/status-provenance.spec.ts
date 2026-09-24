import { describe, expect, it } from '@jest/globals';
import { resolveStatusProvenanceMode, validateStatusProvenanceConfig } from './status-provenance';

const tenant = '11111111-1111-4111-8111-111111111111';

describe('status provenance rollout (Stage 4b design, no caller yet)', () => {
  it('is dark unless the canonical tenant and surface are enrolled', () => {
    expect(resolveStatusProvenanceMode({}, tenant, 'chat')).toBe('off');
    expect(resolveStatusProvenanceMode({
      MERI_STATUS_PROVENANCE_MODE: 'enforce',
      MERI_STATUS_PROVENANCE_TENANTS: tenant,
      MERI_STATUS_PROVENANCE_SURFACES: 'chat',
    }, tenant, 'chat')).toBe('enforce');
    expect(resolveStatusProvenanceMode({
      MERI_STATUS_PROVENANCE_MODE: 'shadow',
      MERI_STATUS_PROVENANCE_TENANTS: tenant,
      MERI_STATUS_PROVENANCE_SURFACES: 'research',
    }, tenant, 'chat')).toBe('off');
  });

  it('validates the capability-specific environment family', () => {
    expect(validateStatusProvenanceConfig({
      MERI_STATUS_PROVENANCE_MODE: 'off',
      MERI_STATUS_PROVENANCE_TENANTS: '',
      MERI_STATUS_PROVENANCE_SURFACES: '',
    })).toEqual({ ok: true, issues: [] });
  });
});
