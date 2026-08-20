import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  PROVIDER_DECISION_SCHEMA_VERSION,
  SESSION5_PINNED_MODEL_PACKAGE_ARN,
  evaluateProviderDecision,
  providerDecisionContentSha256,
} from '../src/provider-decision.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const DECISION_PATH = join(
  REPO_ROOT,
  'docs',
  'defense-budget',
  'phase8-session5-provider-decision.json',
);
const LIVE_EVIDENCE_PATH = join(
  REPO_ROOT,
  'docs',
  'defense-budget',
  'phase8-session5-live-benchmark-evidence.json',
);

function committedDecision() {
  return JSON.parse(readFileSync(DECISION_PATH, 'utf8'));
}

/** Rehash after mutating, so tests target the rule under test, not the hash. */
function resealed(overrides) {
  const next = { ...committedDecision(), ...overrides };
  next.contentSha256 = providerDecisionContentSha256(next);
  return next;
}

function assertRefused(decision, expectedFragment) {
  const verdict = evaluateProviderDecision(decision);
  assert.equal(verdict.acceptable, false);
  assert.ok(
    verdict.failures.some((f) => f.includes(expectedFragment)),
    `expected a failure mentioning "${expectedFragment}", got: ${verdict.failures.join(' | ')}`,
  );
}

test('the committed Session 5 negative provider decision is acceptable', () => {
  const verdict = evaluateProviderDecision(committedDecision());
  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.acceptable, true);
});

test('the committed decision records the exact evaluated package and no provider output', () => {
  const decision = committedDecision();
  assert.equal(decision.schemaVersion, PROVIDER_DECISION_SCHEMA_VERSION);
  assert.equal(decision.modelPackageArn, SESSION5_PINNED_MODEL_PACKAGE_ARN);
  assert.equal(decision.decision, 'NVIDIA_NOT_ADOPTED');
  assert.equal(decision.successfulInvokeEndpointAsync, 0);
  assert.equal(decision.providerOutputsProduced, 0);
  assert.equal(decision.accuracyBenchmarkCompleted, false);
  assert.equal(decision.endpointReachedInService, false);
  assert.equal(decision.nvidiaRoutingEnabled, false);
  assert.equal(decision.productionParser, 'DETERMINISTIC_PRIMARY');
});

test('the negative decision never impersonates live benchmark evidence', () => {
  assert.notEqual(DECISION_PATH, LIVE_EVIDENCE_PATH);
  assert.equal(existsSync(LIVE_EVIDENCE_PATH), false);
  assert.equal(
    PROVIDER_DECISION_SCHEMA_VERSION,
    'phase8_session5_provider_decision_v1',
  );
});

test('a negative decision may not carry an accuracy claim', () => {
  for (const key of [
    'accuracyScore',
    'acceptedPageClasses',
    'benchmarkResult',
    'liveBenchmarkAccepted',
    'nvidiaObservationCount',
    'pageClassDecisions',
  ]) {
    assertRefused(resealed({ [key]: key === 'accuracyScore' ? 0.97 : true }), key);
  }
});

test('retained provider output cannot be closed out as not-adopted', () => {
  assertRefused(
    resealed({ providerOutputsProduced: 3 }),
    'providerOutputsProduced must be 0',
  );
  assertRefused(
    resealed({ successfulInvokeEndpointAsync: 1 }),
    'successfulInvokeEndpointAsync must be 0',
  );
  assertRefused(
    resealed({ endpointReachedInService: true }),
    'endpointReachedInService must be false',
  );
  assertRefused(
    resealed({ accuracyBenchmarkCompleted: true }),
    'accuracyBenchmarkCompleted must be false',
  );
});

test('production routing must be provably untouched', () => {
  assertRefused(
    resealed({ nvidiaRoutingEnabled: true }),
    'nvidiaRoutingEnabled must be false',
  );
  assertRefused(
    resealed({ productionRoutingChanged: true }),
    'productionRoutingChanged must be false',
  );
  assertRefused(
    resealed({ productionParser: 'NVIDIA_PRIMARY' }),
    'productionParser must be DETERMINISTIC_PRIMARY',
  );
  assertRefused(
    resealed({ phase2StillMandatory: false }),
    'phase2StillMandatory must be true',
  );
  assertRefused(
    resealed({ providerNeutralContractPresent: false }),
    'providerNeutralContractPresent must be true',
  );
});

test('any surviving GPU capacity or reservation refuses the closeout', () => {
  const base = committedDecision();
  for (const counter of [
    'activeEndpoints',
    'activeEndpointConfigs',
    'activeTransformJobs',
    'activeScalableTargets',
    'activeGpuCapacity',
    'ledgerActiveJobs',
    'activeReservations',
  ]) {
    assertRefused(
      resealed({ zeroIdleProof: { ...base.zeroIdleProof, [counter]: 1 } }),
      `zeroIdleProof.${counter} must be 0`,
    );
  }
  assertRefused(resealed({ zeroIdleProven: false }), 'zeroIdleProven must be true');
  assertRefused(
    resealed({ activeReservedSpendUsd: 1 }),
    'activeReservedSpendUsd must be 0',
  );
});

test('settled historical spend is bounded by the authorized hard cap', () => {
  const ok = evaluateProviderDecision(resealed({ settledBenchmarkSpendUsd: 150 }));
  assert.deepEqual(ok.failures, []);
  assertRefused(
    resealed({ settledBenchmarkSpendUsd: 151 }),
    'must not exceed the authorized hard cap',
  );
  assertRefused(
    resealed({ settledBenchmarkSpendUsd: -1 }),
    'must be a non-negative number',
  );
});

test('package identity and evaluated execution paths are pinned', () => {
  assertRefused(
    resealed({
      modelPackageArn:
        'arn:aws:sagemaker:us-east-1:865070037744:model-package/some-other-package',
    }),
    'modelPackageArn must be the exact evaluated Marketplace package',
  );
  assertRefused(
    resealed({ executionPathsEvaluated: ['sagemaker_async_inference'] }),
    'executionPathsEvaluated must include sagemaker_batch_transform',
  );
  assertRefused(
    resealed({ batchResult: 'SOMETHING_ELSE' }),
    'batchResult must be MODELDATASOURCE_UNSUPPORTED',
  );
  assertRefused(
    resealed({ asyncResult: 'ENDPOINT_FAILED_WITH_REASON' }),
    'asyncResult must be ENDPOINT_NEVER_INSERVICE',
  );
  assertRefused(
    resealed({ asyncAttempts: 0 }),
    'asyncAttempts must be a positive integer',
  );
});

test('a hand-edited decision artifact is refused', () => {
  const tampered = { ...committedDecision(), asyncAttempts: 99 };
  assertRefused(tampered, 'contentSha256 does not match the decision content');
  assertRefused(
    { ...committedDecision(), contentSha256: 'nope' },
    'contentSha256 must be a lowercase 64-character SHA-256',
  );
});

test('non-object input is refused rather than coerced', () => {
  for (const value of [null, undefined, 'NVIDIA_NOT_ADOPTED', 42, []]) {
    const verdict = evaluateProviderDecision(value);
    assert.equal(verdict.acceptable, false);
  }
});

test('the verifier refuses to assert both closeout paths at once', () => {
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          join('scripts', 'verify-phase8-session5.mjs'),
          '--enforce-live-benchmark',
          '--enforce-provider-decision',
        ],
        { cwd: REPO_ROOT, stdio: 'pipe' },
      ),
    (error) => {
      assert.equal(error.status, 2);
      assert.match(String(error.stderr), /mutually exclusive/);
      return true;
    },
  );
});
