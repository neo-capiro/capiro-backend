import { describe, expect, it } from '@jest/globals';
import { LEARNING_TENANTS_ENV, learningTenantSelected } from './rollout';

const TENANT = '17b63099-bc0f-4ac5-b596-496161e9481e';
const OTHER = '0ae60fee-f3d0-4cf8-a705-b842c39f2666';

describe('learningTenantSelected', () => {
  it('names the env var every Phase 27 control reads', () => {
    expect(LEARNING_TENANTS_ENV).toBe('LEARNING_TENANTS');
  });

  it('fails closed when the allowlist is unset', () => {
    expect(learningTenantSelected(TENANT, undefined)).toBe(false);
  });

  it('fails closed when the allowlist is empty or whitespace', () => {
    expect(learningTenantSelected(TENANT, '')).toBe(false);
    expect(learningTenantSelected(TENANT, '   ')).toBe(false);
    expect(learningTenantSelected(TENANT, ' , , ')).toBe(false);
  });

  it('selects a tenant named exactly in the allowlist', () => {
    expect(learningTenantSelected(TENANT, TENANT)).toBe(true);
  });

  it('selects from a comma- or space-separated list', () => {
    expect(learningTenantSelected(TENANT, `${OTHER},${TENANT}`)).toBe(true);
    expect(learningTenantSelected(TENANT, `${OTHER} ${TENANT}`)).toBe(true);
    expect(learningTenantSelected(TENANT, `${OTHER}, ${TENANT}`)).toBe(true);
  });

  it('does NOT select a tenant absent from the allowlist', () => {
    expect(learningTenantSelected(OTHER, TENANT)).toBe(false);
  });

  it('is case-insensitive and trims surrounding whitespace', () => {
    expect(learningTenantSelected(TENANT.toUpperCase(), TENANT)).toBe(true);
    expect(learningTenantSelected(`  ${TENANT}  `, TENANT)).toBe(true);
  });

  it('treats `all` as the only general-availability value', () => {
    expect(learningTenantSelected(TENANT, 'all')).toBe(true);
    expect(learningTenantSelected(OTHER, 'all')).toBe(true);
    expect(learningTenantSelected(TENANT, 'ALL')).toBe(true);
  });

  it('rejects a near-match rather than prefix-matching it', () => {
    expect(learningTenantSelected(TENANT, TENANT.slice(0, -1))).toBe(false);
    expect(learningTenantSelected(TENANT.slice(0, -1), TENANT)).toBe(false);
    expect(learningTenantSelected(TENANT, `${TENANT}x`)).toBe(false);
  });

  it('fails closed for an absent tenant id even when the allowlist says all', () => {
    expect(learningTenantSelected(null, 'all')).toBe(false);
    expect(learningTenantSelected(undefined, 'all')).toBe(false);
    expect(learningTenantSelected('', 'all')).toBe(false);
    expect(learningTenantSelected('   ', 'all')).toBe(false);
  });

  it('reads process.env by default so callers may omit the second argument', () => {
    const prior = process.env[LEARNING_TENANTS_ENV];
    try {
      process.env[LEARNING_TENANTS_ENV] = TENANT;
      expect(learningTenantSelected(TENANT)).toBe(true);
      expect(learningTenantSelected(OTHER)).toBe(false);
      delete process.env[LEARNING_TENANTS_ENV];
      expect(learningTenantSelected(TENANT)).toBe(false);
    } finally {
      if (prior === undefined) delete process.env[LEARNING_TENANTS_ENV];
      else process.env[LEARNING_TENANTS_ENV] = prior;
    }
  });
});
