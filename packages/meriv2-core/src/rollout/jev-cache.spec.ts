import { describe, expect, it } from '@jest/globals';
import { resolveJevCacheMode, validateJevCacheConfig } from './jev-cache';

const tenant = '11111111-1111-4111-8111-111111111111';

describe('Jev cache rollout', () => {
  it('is dark by default and requires tenant and surface enrollment', () => {
    expect(resolveJevCacheMode({}, tenant, 'chat')).toBe('off');
    expect(resolveJevCacheMode({ MERI_JEV_CACHE_MODE: 'shadow', MERI_JEV_CACHE_TENANTS: tenant,
      MERI_JEV_CACHE_SURFACES: 'chat' }, tenant, 'chat')).toBe('shadow');
    expect(resolveJevCacheMode({ MERI_JEV_CACHE_MODE: 'enforce', MERI_JEV_CACHE_TENANTS: tenant,
      MERI_JEV_CACHE_SURFACES: 'research' }, tenant, 'chat')).toBe('off');
  });

  it('validates its environment family', () => {
    expect(validateJevCacheConfig({ MERI_JEV_CACHE_MODE: 'off', MERI_JEV_CACHE_TENANTS: '',
      MERI_JEV_CACHE_SURFACES: '' })).toEqual({ ok: true, issues: [] });
  });
});
