import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertCase01PreparedDeployment, case01SubmissionObservation } from './case01-prepared-guards.mjs';

const expected = JSON.parse(readFileSync(new URL('./scope-input.template.json', import.meta.url))).deployment;
const rejected = (value) => assert.throws(() => assertCase01PreparedDeployment(value),
  { safeCode: 'CASE01_EXACT_DEPLOYMENT_REQUIRED' });
test('exact prepared pair passes pure comparison only', () => {
  assert.equal(assertCase01PreparedDeployment(structuredClone(expected)), undefined);
});
test('older valid-shaped orchestrator ancestor is refused', () => {
  const old = structuredClone(expected);
  old.orchestratorSha = 'ed44f2c6cfdfda5150f75ab198a6e52d2377880f';
  old.builds['meriv2-orchestrator'].sourceSha = old.orchestratorSha;
  old.builds['meriv2-orchestrator'].imageDigest = 'sha256:53b06f768d8a26a8a5c6124f0f7bb55a0e2117fde050706360c6108c98887faa';
  rejected(old);
});
for (const service of ['api', 'meriv2-orchestrator']) {
  for (const field of ['imageDigest', 'buildId', 'buildspecSha256']) {
    test(`same ${service} source with changed ${field} is refused`, () => {
      const changed = structuredClone(expected);
      changed.builds[service][field] += '-changed';
      rejected(changed);
    });
  }
}
test('additional or missing build fields cannot widen expectation', () => {
  rejected({ ...expected, otherSource: expected.apiSha });
  const missing = structuredClone(expected);
  delete missing.builds.api.imageDigest;
  rejected(missing);
});
test('execution intent without returned outcome preserves unknown submission', () => {
  assert.deepEqual(case01SubmissionObservation({ executionAttempted: true }),
    { turnsSent: null, turnsSentStatus: 'UNKNOWN_AFTER_EXECUTION_INTENT' });
});
test('no execution attempt truthfully reports zero', () => {
  assert.deepEqual(case01SubmissionObservation({ executionAttempted: false }),
    { turnsSent: 0, turnsSentStatus: 'NOT_ATTEMPTED' });
});
test('actual native count survives attempted execution', () => {
  for (const count of [0, 1]) assert.deepEqual(case01SubmissionObservation({
    executionAttempted: true, outcome: { synthesisSubmissionCount: count } }),
    { turnsSent: count, turnsSentStatus: 'OBSERVED_NATIVE_OUTCOME' });
});
test('invalid or missing native count after intent stays unknown', () => {
  for (const count of [undefined, null, -1, 2, '0']) assert.deepEqual(case01SubmissionObservation({
    executionAttempted: true, outcome: { synthesisSubmissionCount: count } }),
    { turnsSent: null, turnsSentStatus: 'UNKNOWN_AFTER_EXECUTION_INTENT' });
});
