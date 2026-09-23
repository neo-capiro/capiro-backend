import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPreservedControlsStillLive,
  computeControlChanges,
  controlledEnvironment,
  replaceControlledEnvironment,
  resolveControlPolicy,
  validateControlPolicy,
} from './meriv2-release-controls.mjs';

const dark = {
  MERI_COVERAGE_RETRIEVAL_MODE: 'off',
  MERI_COVERAGE_RETRIEVAL_TENANTS: '',
  MERI_JEV_TIMEOUT_MS: '8000',
};
const live = [
  { name: 'UNRELATED', value: 'kept' },
  { name: 'MERI_COVERAGE_RETRIEVAL_MODE', value: 'enforce' },
  { name: 'MERI_COVERAGE_RETRIEVAL_TENANTS', value: 'all' },
  { name: 'MERI_JEV_TIMEOUT_MS', value: '8000' },
];
const changes = computeControlChanges(live, dark);

function record(environment) {
  return controlledEnvironment(environment);
}

test('live-enforce without an explicit policy refuses and lists changes', () => {
  assert.throws(
    () => resolveControlPolicy(changes),
    /MERI_COVERAGE_RETRIEVAL_MODE.*enforce.*off.*--preserve-live-controls.*--reset-controls/,
  );
});

test('--preserve-live-controls carries every live controlled value', () => {
  const policy = resolveControlPolicy(changes, { preserveLiveControls: true });
  const proposed = replaceControlledEnvironment(live, dark, policy);
  assert.equal(policy, 'preserve-live');
  assert.deepEqual(record(proposed), record(live));
  assert.equal(proposed.find(({ name }) => name === 'UNRELATED')?.value, 'kept');
  assert.equal(
    validateControlPolicy({
      policy,
      liveControls: record(live),
      intendedControls: dark,
      proposedControls: record(proposed),
    }),
    true,
  );
});

test('--reset-controls forces the intended dark values', () => {
  const policy = resolveControlPolicy(changes, { resetControls: true });
  const proposed = replaceControlledEnvironment(live, dark, policy);
  assert.equal(policy, 'reset');
  assert.deepEqual(record(proposed), dark);
  assert.equal(
    validateControlPolicy({
      policy,
      liveControls: record(live),
      intendedControls: dark,
      proposedControls: record(proposed),
    }),
    true,
  );
});

test('executor rejects drift between preserve preparation and execution', () => {
  assert.throws(
    () =>
      assertPreservedControlsStillLive(record(live), {
        ...record(live),
        MERI_COVERAGE_RETRIEVAL_MODE: 'shadow',
      }),
    /drifted.*MERI_COVERAGE_RETRIEVAL_MODE/,
  );
});

test('executor rejects a reset manifest whose proposed values are not dark', () => {
  assert.throws(
    () =>
      validateControlPolicy({
        policy: 'reset',
        liveControls: record(live),
        intendedControls: dark,
        proposedControls: record(live),
      }),
    /reset controlPolicy values mismatch/,
  );
});

test('a genuinely dark service keeps unchanged dark behavior', () => {
  const darkEnvironment = Object.entries(dark).map(([name, value]) => ({ name, value }));
  const darkChanges = computeControlChanges(darkEnvironment, dark);
  const policy = resolveControlPolicy(darkChanges);
  assert.equal(policy, 'dark');
  assert.deepEqual(
    replaceControlledEnvironment(darkEnvironment, dark, policy),
    [...darkEnvironment].sort((left, right) => left.name.localeCompare(right.name)),
  );
});

test('mutually exclusive control decisions are rejected', () => {
  assert.throws(
    () => resolveControlPolicy(changes, { preserveLiveControls: true, resetControls: true }),
    /exactly one/,
  );
});
