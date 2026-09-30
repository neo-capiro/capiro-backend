import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTHORIZED_TENANTS } from '../capture-transport.mjs';
import { AUTHORIZED_TENANTS as FIXTURE_TENANTS } from '../fixture-provisioning/contract.mjs';

test('collector admits only the exact two canonical synthetic tenant identities', () => {
  const expected = Object.fromEntries(
    Object.values(FIXTURE_TENANTS).map(({ slug, id }) => [slug, id]),
  );
  assert.deepEqual(AUTHORIZED_TENANTS, expected);
  assert.equal(AUTHORIZED_TENANTS[FIXTURE_TENANTS.T2.slug], '52e91176-08f0-4d89-9633-bc212f5bdbbf');
  assert.notEqual(
    AUTHORIZED_TENANTS[FIXTURE_TENANTS.T2.slug],
    '52e91176-08f-4d89-9633-bc212f5bdbbf',
  );
  assert.equal(AUTHORIZED_TENANTS['meri-foundation-20260928-t3'], undefined);
  assert.equal(AUTHORIZED_TENANTS['capiro-internal'], undefined);
  assert.equal(
    Object.values(AUTHORIZED_TENANTS).includes('52e91176-08f-4d89-9633-bc212f5bdbbf'),
    false,
  );
});
