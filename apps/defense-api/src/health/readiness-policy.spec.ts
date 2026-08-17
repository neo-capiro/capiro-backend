import assert from 'node:assert/strict';
import test from 'node:test';
import { decideDefenseReadiness } from './readiness-policy.ts';

const base = {
  configValid: true,
  databaseReachable: true,
  databaseRoleAuthorized: true,
  activeSnapshotId: null,
} as const;

test('dark mode remains ready while honestly reporting domain unavailable', () => {
  assert.deepEqual(
    decideDefenseReadiness({ ...base, cutoverMode: 'dark' }),
    {
      ready: true,
      httpStatus: 200,
      domainAvailability: 'unavailable',
      reasons: ['active_snapshot_unavailable'],
    },
  );
});

test('strict mode blocks without an active snapshot', () => {
  assert.deepEqual(
    decideDefenseReadiness({ ...base, cutoverMode: 'strict' }),
    {
      ready: false,
      httpStatus: 503,
      domainAvailability: 'unavailable',
      reasons: ['active_snapshot_unavailable'],
    },
  );
});

test('unauthorized database role blocks both modes', () => {
  const decision = decideDefenseReadiness({
    ...base,
    databaseRoleAuthorized: false,
    activeSnapshotId: 'snapshot-1',
    cutoverMode: 'dark',
  });
  assert.equal(decision.ready, false);
  assert.equal(decision.httpStatus, 503);
  assert.deepEqual(decision.reasons, ['database_role_unauthorized']);
});

test('strict mode is ready with a valid active pointer', () => {
  assert.deepEqual(
    decideDefenseReadiness({ ...base, activeSnapshotId: 'snapshot-1', cutoverMode: 'strict' }),
    {
      ready: true,
      httpStatus: 200,
      domainAvailability: 'available',
      reasons: [],
    },
  );
});

test('invalid configuration blocks both modes even with a valid pointer', () => {
  const decision = decideDefenseReadiness({
    ...base,
    configValid: false,
    activeSnapshotId: 'snapshot-1',
    cutoverMode: 'dark',
  });
  assert.equal(decision.ready, false);
  assert.equal(decision.httpStatus, 503);
  assert.deepEqual(decision.reasons, ['config_invalid']);
});

test('a failed database query blocks both modes even with a valid pointer', () => {
  const decision = decideDefenseReadiness({
    ...base,
    databaseReachable: false,
    databaseRoleAuthorized: false,
    activeSnapshotId: null,
    cutoverMode: 'dark',
  });
  assert.equal(decision.ready, false);
  assert.equal(decision.httpStatus, 503);
  assert.deepEqual(decision.reasons, ['database_unreachable', 'active_snapshot_unavailable']);
});
