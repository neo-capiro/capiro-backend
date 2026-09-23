import { describe, expect, it, jest } from '@jest/globals';
import { logJevConfigIssues, resolveJevConfig, resolveJevProviderMode } from './jev-config';

const TENANT = '17b63099-bc0f-4ac5-b596-496161e9481e';

describe('Jev configuration', () => {
  it('defaults dark and unavailable without a key', () => {
    expect(resolveJevConfig({})).toMatchObject({
      available: false,
      reasons: ['missing_api_key'],
      apiKeyPresent: false,
      model: 'jev-1.13.0',
      timeoutMs: 8000,
      maxAttempts: 2,
      routing: 'llm',
      tasks: [],
    });
  });

  it.each(['jev-latest', 'jev-preview', 'other-1.2.3'])('rejects moving/invalid model %s', (model) => {
    const result = resolveJevConfig({ TYPESAFE_API_KEY: 'secret', MERI_JEV_MODEL: model });
    expect(result.available).toBe(false);
    expect(result.reasons).toContain('moving_alias_or_invalid_model');
  });

  it('clamps numeric bounds, validates routing, and reports unknown tasks', () => {
    const result = resolveJevConfig({
      TYPESAFE_API_KEY: 'secret',
      MERI_JEV_TIMEOUT_MS: '999999',
      MERI_JEV_MAX_ATTEMPTS: '0',
      MERI_CHAT_EVIDENCE_JUDGE: 'unknown',
      MERI_JEV_TASKS: 'claim_support,wat',
    });
    expect(result).toMatchObject({ timeoutMs: 30000, maxAttempts: 1, routing: 'llm' });
    expect(result.tasks).toEqual(['claim_support']);
    expect(result.reasons).toEqual(['invalid_routing', 'unknown_task:wat']);
  });

  it('requires tenant and surface rollout enrollment', () => {
    const env = {
      MERI_JEV_PROVIDER_MODE: 'enforce',
      MERI_JEV_PROVIDER_TENANTS: TENANT,
      MERI_JEV_PROVIDER_SURFACES: 'chat',
    };
    expect(resolveJevProviderMode(env, TENANT, 'chat')).toBe('enforce');
    expect(resolveJevProviderMode(env, TENANT, 'memo')).toBe('off');
  });

  it('logs issue codes without key material', () => {
    const warn = jest.fn();
    logJevConfigIssues({ warn }, { TYPESAFE_API_KEY: 'super-secret' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('super-secret');
  });

  it('recognizes the provisional status-selection task', () => {
    expect(resolveJevConfig({ TYPESAFE_API_KEY: 'secret', MERI_JEV_TASKS: 'status_selection' }))
      .toMatchObject({ available: true, tasks: ['status_selection'] });
  });
});
