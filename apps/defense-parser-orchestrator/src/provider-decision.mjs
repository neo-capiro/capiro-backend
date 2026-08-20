// Phase 8 Session 5 — negative provider-decision contract.
//
// Session 5 may close through exactly one of two mutually exclusive paths:
//
//   A. LIVE_PROVIDER_ACCEPTED  — genuine provider output exists, source-grounded
//      scoring passes, and the enforced live-benchmark verifier passes. That path
//      is owned by the live-benchmark evidence contract and is unchanged.
//
//   B. PROVIDER_NOT_ADOPTED    — the approved provider/package/runtime could not
//      reach governed inference after bounded live attempts. This module owns
//      that path.
//
// This artifact is deliberately NOT interchangeable with live-benchmark evidence.
// It asserts the absence of provider output; it may never assert accuracy.
import { sha256Hex } from './session5.mjs';

export const PROVIDER_DECISION_SCHEMA_VERSION =
  'phase8_session5_provider_decision_v1';

export const SESSION5_PINNED_MODEL_PACKAGE_ARN =
  'arn:aws:sagemaker:us-east-1:865070037744:model-package/nvidia-nemotron-parse-6673990e627d314f8aceb69f5e816587';

export const NEGATIVE_PROVIDER_DECISION = 'NVIDIA_NOT_ADOPTED';
export const NEGATIVE_PROVIDER_STATUS = 'OPERATIONALLY_BLOCKED';

/** The only conclusions the retained diagnostic actually supports. */
export const SUPPORTED_BATCH_RESULT = 'MODELDATASOURCE_UNSUPPORTED';
export const SUPPORTED_ASYNC_RESULT = 'ENDPOINT_NEVER_INSERVICE';

export const REQUIRED_EXECUTION_PATHS = Object.freeze([
  'sagemaker_batch_transform',
  'sagemaker_async_inference',
]);

/**
 * Keys that would smuggle an unearned accuracy claim into a negative decision.
 * A negative closeout must never imply Nemotron was scored.
 */
export const FORBIDDEN_ACCURACY_KEYS = Object.freeze([
  'accuracyScore',
  'acceptedPageClasses',
  'benchmarkResult',
  'invocations',
  'liveBenchmarkAccepted',
  'nvidiaObservationCount',
  'pageClassDecisions',
  'providerOutputs',
  'score',
  'scores',
]);

/** Zero-idle fields that must all be exactly 0 in a negative closeout. */
export const REQUIRED_ZERO_IDLE_COUNTERS = Object.freeze([
  'activeEndpoints',
  'activeEndpointConfigs',
  'activeTransformJobs',
  'activeScalableTargets',
  'activeGpuCapacity',
  'ledgerActiveJobs',
  'activeReservations',
]);

export const SESSION5_AUTHORIZED_HARD_CAP_USD = 150;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Content hash over the decision minus its own `contentSha256`, mirroring the
 * live-benchmark result hash so the artifact cannot be quietly hand-edited.
 */
export function providerDecisionContentSha256(decision) {
  const withoutHash = { ...decision };
  delete withoutHash.contentSha256;
  return sha256Hex(withoutHash);
}

/**
 * Validate a Session 5 negative provider-decision artifact.
 *
 * Returns `{ acceptable, failures }`. `acceptable` is true only when every
 * negative-path requirement holds; it never implies a successful benchmark.
 */
export function evaluateProviderDecision(decision) {
  const failures = [];
  const fail = (message) => failures.push(message);

  if (!isPlainObject(decision)) {
    return { acceptable: false, failures: ['provider decision must be an object'] };
  }

  if (decision.schemaVersion !== PROVIDER_DECISION_SCHEMA_VERSION) {
    fail('schemaVersion must be ' + PROVIDER_DECISION_SCHEMA_VERSION);
  }
  if (decision.decision !== NEGATIVE_PROVIDER_DECISION) {
    fail('decision must be ' + NEGATIVE_PROVIDER_DECISION);
  }
  if (decision.status !== NEGATIVE_PROVIDER_STATUS) {
    fail('status must be ' + NEGATIVE_PROVIDER_STATUS);
  }
  if (decision.operationallyBlocked !== true) {
    fail('operationallyBlocked must be true');
  }
  if (decision.provider !== 'nemotron_parse') {
    fail('provider must be nemotron_parse');
  }
  if (decision.modelPackageArn !== SESSION5_PINNED_MODEL_PACKAGE_ARN) {
    fail('modelPackageArn must be the exact evaluated Marketplace package');
  }

  const paths = Array.isArray(decision.executionPathsEvaluated)
    ? decision.executionPathsEvaluated
    : [];
  for (const required of REQUIRED_EXECUTION_PATHS) {
    if (!paths.includes(required)) {
      fail('executionPathsEvaluated must include ' + required);
    }
  }

  if (decision.batchResult !== SUPPORTED_BATCH_RESULT) {
    fail('batchResult must be ' + SUPPORTED_BATCH_RESULT);
  }
  if (decision.asyncResult !== SUPPORTED_ASYNC_RESULT) {
    fail('asyncResult must be ' + SUPPORTED_ASYNC_RESULT);
  }
  if (!Number.isInteger(decision.asyncAttempts) || decision.asyncAttempts < 1) {
    fail('asyncAttempts must be a positive integer (bounded live attempts)');
  }

  // The core truth claims: nothing was produced and nothing was scored.
  if (decision.successfulInvokeEndpointAsync !== 0) {
    fail('successfulInvokeEndpointAsync must be 0');
  }
  if (decision.providerOutputsProduced !== 0) {
    fail('providerOutputsProduced must be 0');
  }
  if (decision.accuracyBenchmarkCompleted !== false) {
    fail('accuracyBenchmarkCompleted must be false');
  }
  if (decision.endpointReachedInService !== false) {
    fail('endpointReachedInService must be false');
  }

  // Production posture must be provably unchanged.
  if (decision.nvidiaRoutingEnabled !== false) {
    fail('nvidiaRoutingEnabled must be false');
  }
  if (decision.productionParser !== 'DETERMINISTIC_PRIMARY') {
    fail('productionParser must be DETERMINISTIC_PRIMARY');
  }
  if (decision.productionDecision !== 'DETERMINISTIC_PRIMARY') {
    fail('productionDecision must be DETERMINISTIC_PRIMARY');
  }
  if (decision.productionRoutingChanged !== false) {
    fail('productionRoutingChanged must be false');
  }
  if (decision.providerNeutralContractPresent !== true) {
    fail('providerNeutralContractPresent must be true');
  }
  if (decision.phase2StillMandatory !== true) {
    fail('phase2StillMandatory must be true');
  }

  // Zero idle.
  if (decision.zeroIdleProven !== true) {
    fail('zeroIdleProven must be true');
  }
  const proof = isPlainObject(decision.zeroIdleProof) ? decision.zeroIdleProof : null;
  if (!proof) {
    fail('zeroIdleProof must be an object');
  } else {
    for (const counter of REQUIRED_ZERO_IDLE_COUNTERS) {
      if (proof[counter] !== 0) {
        fail('zeroIdleProof.' + counter + ' must be 0');
      }
    }
    if (typeof proof.checkedAt !== 'string' || !proof.checkedAt) {
      fail('zeroIdleProof.checkedAt must be recorded');
    }
  }

  // Settled historical spend is allowed and must be distinguished from
  // an active reservation, which must be zero.
  const settled = decision.settledBenchmarkSpendUsd;
  if (typeof settled !== 'number' || !Number.isFinite(settled) || settled < 0) {
    fail('settledBenchmarkSpendUsd must be a non-negative number');
  } else if (settled > SESSION5_AUTHORIZED_HARD_CAP_USD) {
    fail(
      'settledBenchmarkSpendUsd must not exceed the authorized hard cap USD ' +
        SESSION5_AUTHORIZED_HARD_CAP_USD,
    );
  }
  if (decision.activeReservedSpendUsd !== 0) {
    fail('activeReservedSpendUsd must be 0');
  }

  // A negative decision may never carry an accuracy claim.
  for (const key of FORBIDDEN_ACCURACY_KEYS) {
    if (key in decision) {
      fail('negative provider decision must not contain ' + key);
    }
  }

  if (
    typeof decision.contentSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(decision.contentSha256)
  ) {
    fail('contentSha256 must be a lowercase 64-character SHA-256');
  } else if (decision.contentSha256 !== providerDecisionContentSha256(decision)) {
    fail('contentSha256 does not match the decision content');
  }

  return { acceptable: failures.length === 0, failures };
}
