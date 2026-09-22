import { describe, expect, it } from '@jest/globals';
import {
  resolveCoverageRetrievalMode,
  validateCoverageRetrievalConfig,
} from './coverage-retrieval';

const tenant = '11111111-1111-4111-8111-111111111111';

describe('coverage retrieval rollout', () => {
  it('defaults and fails closed unless tenant and surface are enrolled', () => {
    expect(resolveCoverageRetrievalMode({}, tenant, 'chat')).toBe('off');
    expect(
      resolveCoverageRetrievalMode(
        {
          MERI_COVERAGE_RETRIEVAL_MODE: 'enforce',
          MERI_COVERAGE_RETRIEVAL_TENANTS: tenant,
          MERI_COVERAGE_RETRIEVAL_SURFACES: 'chat',
        },
        tenant,
        'chat',
      ),
    ).toBe('enforce');
    expect(
      resolveCoverageRetrievalMode(
        {
          MERI_COVERAGE_RETRIEVAL_MODE: 'enforce',
          MERI_COVERAGE_RETRIEVAL_TENANTS: tenant,
          MERI_COVERAGE_RETRIEVAL_SURFACES: 'chat',
        },
        tenant,
        'memo',
      ),
    ).toBe('off');
  });

  it('validates the capability-specific environment family', () => {
    expect(
      validateCoverageRetrievalConfig({
        MERI_COVERAGE_RETRIEVAL_MODE: 'off',
        MERI_COVERAGE_RETRIEVAL_TENANTS: '',
        MERI_COVERAGE_RETRIEVAL_SURFACES: '',
      }),
    ).toEqual({ ok: true, issues: [] });
  });
});
