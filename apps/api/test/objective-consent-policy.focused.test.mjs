import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OBJECTIVE_CONSENT_POLICY,
  ObjectiveConsentPolicyError,
  objectiveConsentPolicyTerms,
} from '../src/auth/workload-authority/objective-consent-policy.ts';

// Native Node type stripping, with built-in dependencies only. These assertions
// cover duration TERMS ONLY: no credential, current-authority proof, consent
// record, original-receipt accounting, dispatcher or persistence is constructed.
const MINUTE = 60_000;
const DEFAULT = 30 * MINUTE;
const NOW = 1_800_000_000_000;
const MAX_TIME = 8_640_000_000_000_000;
const ACTIONS = ['objective.strategy.draft', 'objective.plan.prepare'];
const INPUT_KEYS = [
  'operation', 'databaseNowMs', 'configuredDurationMs', 'tenantDurationLimitMs',
  'actionDurationLimitMs', 'originalTokenExpiresAtMs', 'originalDelegationExpiresAtMs',
  'priorOutcomeUnconfirmed',
];
const OUTPUT_KEYS = [
  'policyId', 'policyRevision', 'operation', 'confirmedAtMs', 'configuredDurationMs',
  'effectiveDurationMs', 'expiresAtMs', 'tenantDurationLimitMs', 'actionDurationLimitMs',
  'originalTokenExpiresAtMs', 'originalDelegationExpiresAtMs',
];
function input(changes = {}) {
  return {
    operation: ACTIONS[0], databaseNowMs: NOW, configuredDurationMs: null,
    tenantDurationLimitMs: null, actionDurationLimitMs: null,
    originalTokenExpiresAtMs: null, originalDelegationExpiresAtMs: null,
    // A synthetic policy input, not evidence that an owner receipt was checked.
    priorOutcomeUnconfirmed: false,
    ...changes,
  };
}
function rejects(raw, code = 'INPUT_INVALID') {
  assert.throws(() => objectiveConsentPolicyTerms(raw), (error) => {
    assert.ok(error instanceof ObjectiveConsentPolicyError);
    assert.equal(error.code, code);
    assert.equal(error.message, 'Objective consent policy terms are unavailable');
    return true;
  });
}

test('policy revision 1 names exactly two actions and a new 30-minute default', () => {
  assert.deepEqual(OBJECTIVE_CONSENT_POLICY, {
    id: 'capiro.objective-generation-consent', revision: 1,
    defaultDurationMs: DEFAULT, operations: ACTIONS,
  });
  assert.ok(Object.isFrozen(OBJECTIVE_CONSENT_POLICY));
  assert.ok(Object.isFrozen(OBJECTIVE_CONSENT_POLICY.operations));
  assert.equal(Reflect.set(OBJECTIVE_CONSENT_POLICY, 'defaultDurationMs', 24 * 60 * MINUTE), false);
  assert.throws(() => OBJECTIVE_CONSENT_POLICY.operations.push('objective.external.send'), TypeError);
});

for (const operation of ACTIONS) {
  test(`${operation} produces exactly the declared 30-minute terms`, () => {
    const terms = objectiveConsentPolicyTerms(input({ operation }));
    assert.deepEqual(terms, {
      policyId: 'capiro.objective-generation-consent', policyRevision: 1, operation,
      confirmedAtMs: NOW, configuredDurationMs: DEFAULT,
      effectiveDurationMs: DEFAULT, expiresAtMs: NOW + DEFAULT,
      tenantDurationLimitMs: null, actionDurationLimitMs: null,
      originalTokenExpiresAtMs: null, originalDelegationExpiresAtMs: null,
    });
    assert.deepEqual(Object.keys(terms).sort(), [...OUTPUT_KEYS].sort());
    assert.ok(Object.isFrozen(terms));
  });
}

test('configuration may reduce duration down to one millisecond or retain the default', () => {
  for (const configuredDurationMs of [1, 5 * MINUTE, DEFAULT]) {
    const terms = objectiveConsentPolicyTerms(input({ configuredDurationMs }));
    assert.equal(terms.configuredDurationMs, configuredDurationMs);
    assert.equal(terms.effectiveDurationMs, configuredDurationMs);
    assert.equal(terms.expiresAtMs, NOW + configuredDurationMs);
  }
});

test('configuration growth requires a policy revision even if another cap is shorter', () => {
  for (const configuredDurationMs of [DEFAULT + 1, 31 * MINUTE, 24 * 60 * MINUTE, Number.MAX_SAFE_INTEGER]) {
    rejects(input({
      configuredDurationMs, tenantDurationLimitMs: MINUTE,
      actionDurationLimitMs: 2 * MINUTE, originalTokenExpiresAtMs: NOW + 1,
    }), 'POLICY_REVISION_REQUIRED');
  }
});

test('tenant/action duration limits only shorten the configured/default duration', () => {
  for (const [changes, duration] of [
    [{ tenantDurationLimitMs: 10 * MINUTE }, 10 * MINUTE],
    [{ actionDurationLimitMs: 7 * MINUTE }, 7 * MINUTE],
    [{ tenantDurationLimitMs: 10 * MINUTE, actionDurationLimitMs: 7 * MINUTE }, 7 * MINUTE],
    [{ configuredDurationMs: 5 * MINUTE, tenantDurationLimitMs: 10 * MINUTE, actionDurationLimitMs: 7 * MINUTE }, 5 * MINUTE],
    [{ tenantDurationLimitMs: Number.MAX_SAFE_INTEGER, actionDurationLimitMs: 60 * MINUTE }, DEFAULT],
  ]) {
    const terms = objectiveConsentPolicyTerms(input(changes));
    assert.equal(terms.effectiveDurationMs, duration);
    assert.equal(terms.expiresAtMs, NOW + duration);
    assert.equal(terms.tenantDurationLimitMs, changes.tenantDurationLimitMs ?? null);
    assert.equal(terms.actionDurationLimitMs, changes.actionDurationLimitMs ?? null);
  }
});

test('original token and delegation absolute expiries cap terms without extending either', () => {
  for (const [changes, duration] of [
    [{ originalTokenExpiresAtMs: NOW + 9 * MINUTE }, 9 * MINUTE],
    [{ originalDelegationExpiresAtMs: NOW + 4 * MINUTE }, 4 * MINUTE],
    [{ originalTokenExpiresAtMs: NOW + 9 * MINUTE, originalDelegationExpiresAtMs: NOW + 4 * MINUTE }, 4 * MINUTE],
    [{ originalTokenExpiresAtMs: NOW + 1, originalDelegationExpiresAtMs: NOW + DEFAULT }, 1],
    [{ originalTokenExpiresAtMs: NOW + 60 * MINUTE, originalDelegationExpiresAtMs: NOW + 90 * MINUTE }, DEFAULT],
    [{ actionDurationLimitMs: MINUTE, originalTokenExpiresAtMs: NOW + 9 * MINUTE }, MINUTE],
  ]) {
    const terms = objectiveConsentPolicyTerms(input(changes));
    assert.equal(terms.effectiveDurationMs, duration);
    assert.equal(terms.expiresAtMs, NOW + duration);
    assert.equal(terms.originalTokenExpiresAtMs, changes.originalTokenExpiresAtMs ?? null);
    assert.equal(terms.originalDelegationExpiresAtMs, changes.originalDelegationExpiresAtMs ?? null);
  }
});

for (const key of ['originalTokenExpiresAtMs', 'originalDelegationExpiresAtMs']) {
  test(`${key} at zero, in the past or at the current clock refuses terms`, () => {
    for (const expiresAtMs of [0, NOW - 1, NOW]) {
      rejects(input({ [key]: expiresAtMs }), 'AUTHORITY_EXPIRED');
    }
  });
}

test('a valid UNKNOWN outcome refuses terms before growth or expiry can hide it', () => {
  rejects(input({ priorOutcomeUnconfirmed: true }), 'OUTCOME_UNCONFIRMED');
  rejects(input({
    priorOutcomeUnconfirmed: true, configuredDurationMs: DEFAULT + 1,
    originalTokenExpiresAtMs: 0,
  }), 'OUTCOME_UNCONFIRMED');
  rejects(input({ priorOutcomeUnconfirmed: true, databaseNowMs: NaN }), 'INPUT_INVALID');
});

test('explicit null means known nonapplicability; missing/undefined ceilings are invalid', () => {
  const nullableKeys = INPUT_KEYS.filter((key) => !['operation', 'databaseNowMs', 'priorOutcomeUnconfirmed'].includes(key));
  assert.equal(objectiveConsentPolicyTerms(input()).effectiveDurationMs, DEFAULT);
  for (const key of nullableKeys) {
    rejects(input({ [key]: undefined }));
    const missing = input();
    delete missing[key];
    rejects(missing);
  }
});

test('the closed contract rejects unknown keys and budget/model expiry substitutes', () => {
  for (const name of ['budgetExpiresAtMs', 'modelExpiresAtMs', 'workerExpiresAtMs', 'policyRevision', 'tenantId', 'credential']) {
    rejects(input({ [name]: NOW + MINUTE }));
  }
  for (const [required, substitute] of [
    ['originalTokenExpiresAtMs', 'budgetExpiresAtMs'],
    ['originalDelegationExpiresAtMs', 'modelExpiresAtMs'],
  ]) {
    const raw = input();
    delete raw[required];
    raw[substitute] = NOW + MINUTE;
    rejects(raw); // Same own-key count cannot conceal a missing required field.
  }
  const hidden = input();
  Object.defineProperty(hidden, 'privateUnknown', { value: 'synthetic-private-input', enumerable: false });
  rejects(hidden);
  const symbol = input();
  symbol[Symbol('unknown')] = true;
  rejects(symbol);
});

const INVALID_NUMBERS = [
  ['databaseNowMs', -1], ['databaseNowMs', 0.5], ['databaseNowMs', NaN],
  ['databaseNowMs', Infinity], ['databaseNowMs', Number.MAX_SAFE_INTEGER + 1],
  ['databaseNowMs', MAX_TIME + 1],
  ['configuredDurationMs', 0], ['configuredDurationMs', -1], ['configuredDurationMs', 0.5],
  ['configuredDurationMs', NaN], ['configuredDurationMs', Infinity],
  ['configuredDurationMs', Number.MAX_SAFE_INTEGER + 1],
  ['tenantDurationLimitMs', 0], ['tenantDurationLimitMs', NaN],
  ['tenantDurationLimitMs', '60000'], ['actionDurationLimitMs', 0],
  ['actionDurationLimitMs', Infinity], ['actionDurationLimitMs', -Infinity],
  ['originalTokenExpiresAtMs', -1], ['originalTokenExpiresAtMs', NaN],
  ['originalTokenExpiresAtMs', MAX_TIME + 1], ['originalTokenExpiresAtMs', '1800000000001'],
  ['originalDelegationExpiresAtMs', -1], ['originalDelegationExpiresAtMs', 0.5],
  ['originalDelegationExpiresAtMs', Infinity], ['originalDelegationExpiresAtMs', Number.MAX_SAFE_INTEGER + 1],
];
for (const [index, [key, value]] of INVALID_NUMBERS.entries()) {
  test(`rejects unsafe/nonfinite/noninteger numeric input ${index + 1}: ${key}`, () => {
    rejects(input({ [key]: value }));
  });
}

test('timestamp addition must remain valid even if an absolute cap would later shorten it', () => {
  rejects(input({ databaseNowMs: MAX_TIME - DEFAULT + 1, originalTokenExpiresAtMs: MAX_TIME }));
  const terms = objectiveConsentPolicyTerms(input({ databaseNowMs: MAX_TIME - 1, configuredDurationMs: 1 }));
  assert.equal(terms.confirmedAtMs, MAX_TIME - 1);
  assert.equal(terms.expiresAtMs, MAX_TIME);
  assert.equal(terms.effectiveDurationMs, 1);
  assert.equal(objectiveConsentPolicyTerms(input({ databaseNowMs: 0 })).expiresAtMs, DEFAULT);
});

test('unsupported actions, unknown outcome flags and malformed roots are rejected', () => {
  for (const operation of ['objective.strategy.edit', 'objective.external.send', '', null, 1]) {
    rejects(input({ operation }));
  }
  for (const priorOutcomeUnconfirmed of [null, undefined, 'false', 0, {}]) {
    rejects(input({ priorOutcomeUnconfirmed }));
  }
  for (const raw of [undefined, null, 1, 'input', [], new Date(0), new Map(), () => input()]) rejects(raw);
  for (const key of INPUT_KEYS) {
    const raw = input();
    delete raw[key];
    rejects(raw);
  }
});

test('exact null-prototype data input is accepted without changing it', () => {
  const raw = Object.freeze(Object.assign(Object.create(null), input()));
  const terms = objectiveConsentPolicyTerms(raw);
  assert.equal(terms.expiresAtMs, NOW + DEFAULT);
  assert.deepEqual(Object.keys(raw).sort(), [...INPUT_KEYS].sort());
  assert.equal(Object.getPrototypeOf(raw), null);
});

test('input, constants and previous/new terms remain immutable; no old record is accepted', () => {
  const raw = Object.freeze(input({
    originalTokenExpiresAtMs: NOW + 10 * MINUTE,
    originalDelegationExpiresAtMs: NOW + 5 * MINUTE,
  }));
  const originalInput = structuredClone(raw);
  const previousTerms = objectiveConsentPolicyTerms(raw);
  const previousSnapshot = structuredClone(previousTerms);
  const nextTerms = objectiveConsentPolicyTerms(Object.freeze({ ...raw, databaseNowMs: NOW + MINUTE }));
  assert.notStrictEqual(previousTerms, nextTerms);
  assert.deepEqual(raw, originalInput);
  assert.deepEqual(previousTerms, previousSnapshot);
  assert.equal(nextTerms.expiresAtMs, previousTerms.expiresAtMs);
  assert.equal(nextTerms.effectiveDurationMs, 4 * MINUTE);
  assert.ok(Object.isFrozen(nextTerms));
  assert.throws(() => { nextTerms.expiresAtMs = NOW + DEFAULT; }, TypeError);
  assert.equal(Object.hasOwn(nextTerms, 'credential'), false);
  assert.equal(Object.hasOwn(nextTerms, 'authorized'), false);
  assert.equal(Object.hasOwn(nextTerms, 'consentId'), false);
  rejects({ ...raw, oldConsent: previousTerms });
  assert.deepEqual(previousTerms, previousSnapshot);
});

test('proxy inputs, including revoked proxies, fail before any trap is called', () => {
  let calls = 0;
  const trap = () => { calls += 1; throw new Error('proxy trap must not run'); };
  const malicious = new Proxy(input(), {
    get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, has: trap,
  });
  rejects(malicious);
  assert.equal(calls, 0);
  const revocable = Proxy.revocable(input(), { get: trap, getPrototypeOf: trap, ownKeys: trap });
  revocable.revoke();
  rejects(revocable.proxy);
  assert.equal(calls, 0);
});

test('accessor inputs fail without invoking any getter or setter', () => {
  for (const key of INPUT_KEYS) {
    let calls = 0;
    const raw = input();
    Object.defineProperty(raw, key, {
      enumerable: true, configurable: true,
      get() { calls += 1; throw new Error('getter must not run'); },
      set() { calls += 1; throw new Error('setter must not run'); },
    });
    rejects(raw);
    assert.equal(calls, 0, key);
  }
});

test('invalid nested/coercible values are rejected without property or coercion hooks', () => {
  let calls = 0;
  const trap = () => { calls += 1; throw new Error('coercion must not run'); };
  const nestedProxy = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap });
  rejects(input({ configuredDurationMs: nestedProxy }));
  rejects(input({ operation: nestedProxy }));
  const coercible = { valueOf: trap, toString: trap, [Symbol.toPrimitive]: trap };
  rejects(input({ actionDurationLimitMs: coercible }));
  assert.equal(calls, 0);
});
