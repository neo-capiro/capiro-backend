import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDefenseServeEnvironment } from './defense-config.validation.ts';

function validEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/capiro?connection_limit=8',
    CLERK_SECRET_KEY: 'sk_test_example',
    DEFENSE_CUTOVER_MODE: 'dark',
    DEFENSE_DB_POOL_MAX: '12',
    DEFENSE_INTERNAL_SERVICE_ALLOWLIST: 'meri-orchestrator',
    DEFENSE_INTERNAL_SERVICE_KEYS_JSON: JSON.stringify({
      'meri-orchestrator': '0123456789abcdef0123456789abcdef',
    }),
  };
}

test('valid dark serve environment passes', () => {
  assert.deepEqual(validateDefenseServeEnvironment(validEnv()), {
    valid: true,
    errors: [],
  });
});

test('pool budget is mandatory and bounded', () => {
  const missing = validEnv();
  missing.DATABASE_URL = 'postgresql://user:pass@localhost:5432/capiro';
  assert.equal(validateDefenseServeEnvironment(missing).valid, false);

  const excessive = validEnv();
  excessive.DATABASE_URL =
    'postgresql://user:pass@localhost:5432/capiro?connection_limit=13';
  assert.match(
    validateDefenseServeEnvironment(excessive).errors.join(' '),
    /exceeds DEFENSE_DB_POOL_MAX/,
  );
});

test('serve task rejects parser and promoter credentials', () => {
  const env = validEnv();
  env.NVIDIA_API_KEY = 'forbidden';
  env.DEFENSE_PROMOTER_DATABASE_URL = 'forbidden';
  const result = validateDefenseServeEnvironment(env);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /NVIDIA_API_KEY/);
  assert.match(result.errors.join(' '), /DEFENSE_PROMOTER_DATABASE_URL/);
});
