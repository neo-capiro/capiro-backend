import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedRunnerAccount, TEST_ACCOUNT } from './auth.mjs';

const second = 'qa+clerk_test-portfolio-v2-b4e7c829f2c0@capiro.ai';

test('the designated test account is always allowed', () => {
  assert.equal(allowedRunnerAccount(TEST_ACCOUNT, {}), TEST_ACCOUNT);
});

test('the second reviewer is allowed only when configured and synthetic', () => {
  assert.equal(allowedRunnerAccount(second, { MERI_RUNNER_SECOND_IDENTITY: second }), second);
  assert.throws(() => allowedRunnerAccount(second, {}), /RUNNER_ACCOUNT_NOT_ALLOWED/);
  assert.throws(
    () => allowedRunnerAccount('jordan@capiro.ai', { MERI_RUNNER_SECOND_IDENTITY: 'jordan@capiro.ai' }),
    /RUNNER_ACCOUNT_NOT_ALLOWED/,
  );
  assert.throws(
    () => allowedRunnerAccount('client@customer.com', { MERI_RUNNER_SECOND_IDENTITY: 'client@customer.com' }),
    /RUNNER_ACCOUNT_NOT_ALLOWED/,
  );
  assert.throws(() => allowedRunnerAccount(undefined, { MERI_RUNNER_SECOND_IDENTITY: second }), /RUNNER_ACCOUNT_NOT_ALLOWED/);
});
