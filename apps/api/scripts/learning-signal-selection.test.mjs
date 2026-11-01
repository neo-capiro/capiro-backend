import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseLearningSignalSelection,
  runLearningSignalSelection,
} from './learning-signal-selection.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const signalId = '22222222-2222-4222-8222-222222222222';
const selected = ['--tenant', tenantId, '--signal', signalId];

test('single selection dispatches once without tenant enumeration or batch', async () => {
  const calls = [];
  const result = await runLearningSignalSelection(
    parseLearningSignalSelection(selected),
    {
      async generateForSignal(...args) {
        calls.push(args);
        return { eligibility: 'eligible' };
      },
      async processBatch() {
        assert.fail('batch forbidden');
      },
    },
    async () => assert.fail('enumeration forbidden'),
  );
  assert.deepEqual(calls, [[tenantId, signalId]]);
  assert.deepEqual(result, { tenants: 1, totalProcessed: 1, byEligibility: { eligible: 1 } });
});

for (const args of [
  ['--signal', signalId],
  ['--tenant'],
  ['--tenant', tenantId, '--signal'],
  ['--tenant', '--signal', signalId],
  ['--tenant', tenantId, '--signal', 'bad'],
  ['--tenant', 'bad', '--signal', signalId],
  [...selected, '--signal', signalId],
  [...selected, '--tenant', tenantId],
  [...selected, '--all'],
  ['--unknown', tenantId],
  ['--tenant', ` ${tenantId}`, '--signal', signalId],
]) {
  test(`malformed selection refuses before dispatch: ${JSON.stringify(args)}`, () => {
    assert.throws(() => parseLearningSignalSelection(args));
  });
}

test('flag order does not widen selection', () => {
  assert.deepEqual(parseLearningSignalSelection(['--signal', signalId, '--tenant', tenantId]), {
    mode: 'signal',
    tenantId,
    signalId,
  });
});

test('foreign/missing signal refusal propagates without retry or batch fallback', async () => {
  let calls = 0;
  const refusal = new Error('tenant-scoped signal not found');
  await assert.rejects(
    runLearningSignalSelection(
      parseLearningSignalSelection(selected),
      {
        async generateForSignal() {
          calls++;
          throw refusal;
        },
        async processBatch() {
          assert.fail('batch forbidden');
        },
      },
      async () => assert.fail('enumeration forbidden'),
    ),
    (error) => error === refusal,
  );
  assert.equal(calls, 1);
});

test('disabled generation remains unprocessed without fallback', async () => {
  const result = await runLearningSignalSelection(
    parseLearningSignalSelection(selected),
    {
      async generateForSignal() {
        return null;
      },
      async processBatch() {
        assert.fail('batch forbidden');
      },
    },
    async () => assert.fail('enumeration forbidden'),
  );
  assert.equal(result.totalProcessed, 0);
  assert.deepEqual(result.byEligibility, {});
});

test('existing outcome is reported once without creating a different selection', async () => {
  const result = await runLearningSignalSelection(
    parseLearningSignalSelection(selected),
    {
      async generateForSignal() {
        return { eligibility: 'duplicate' };
      },
      async processBatch() {
        assert.fail('batch forbidden');
      },
    },
    async () => assert.fail('enumeration forbidden'),
  );
  assert.deepEqual(result.byEligibility, { duplicate: 1 });
});

for (const scoped of [false, true]) {
  test(`preserves batch mode and limit, tenant selected=${scoped}`, async () => {
    const calls = [];
    let enumerations = 0;
    const result = await runLearningSignalSelection(
      parseLearningSignalSelection(scoped ? ['--tenant', tenantId] : []),
      {
        async generateForSignal() {
          assert.fail('single forbidden');
        },
        async processBatch(...args) {
          calls.push(args);
          return [{ eligibility: 'eligible' }];
        },
      },
      async () => {
        enumerations++;
        return [tenantId, 'another-tenant'];
      },
    );
    assert.equal(enumerations, scoped ? 0 : 1);
    assert.deepEqual(
      calls,
      scoped
        ? [[tenantId, 200]]
        : [
            [tenantId, 200],
            ['another-tenant', 200],
          ],
    );
    assert.equal(result.totalProcessed, scoped ? 1 : 2);
  });
}
