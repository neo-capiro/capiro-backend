import {
  evaluateWorkloadAuthority,
  parseWorkloadAuthorityRequest,
} from './workload-authority.policy.js';
import type {
  WorkloadAuthorityFacts,
  WorkloadAuthorityRequest,
} from './workload-authority.types.js';

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const now = 1_800_000_000_000;
const minute = 60_000;
const day = 24 * 60 * minute;

function fixture(phase: WorkloadAuthorityRequest['phase'] = 'dispatch', planner = false) {
  const request: WorkloadAuthorityRequest = {
    schemaVersion: 1,
    delegationRef: id(1),
    audience: planner
      ? 'capiro:objective-planner-materialization:v1'
      : 'capiro:objective-strategy-generation:v1',
    operation: planner ? 'objective.plan.prepare' : 'objective.strategy.draft',
    phase,
    attemptId: id(2),
    runId: phase === 'dispatch' ? null : id(3),
    requestFingerprint: 'a'.repeat(64),
    resultRef: ['result_read', 'persist', 'retained_result_read'].includes(phase)
      ? 'result:run-3'
      : null,
    resultHash: ['result_read', 'persist', 'retained_result_read'].includes(phase)
      ? 'b'.repeat(64)
      : null,
  };
  const scope = {
    tenantId: id(4),
    nativeActorId: id(5),
    membershipId: id(6),
    clientId: id(7),
    objectiveId: id(8),
    objectiveRevisionId: id(9),
    objectiveVersion: 2,
    policyRevision: 'c'.repeat(64),
    plannerSource: planner
      ? {
          strategyId: id(10),
          strategyVersionId: id(11),
          strategyVersionDigest: 'd'.repeat(64),
          generationReceiptId: id(12),
          groupsDigest: 'e'.repeat(64),
        }
      : null,
  };
  const {
    schemaVersion: _schema,
    phase: _phase,
    resultRef: _ref,
    resultHash: _hash,
    ...binding
  } = request;
  const facts: WorkloadAuthorityFacts = {
    enabled: true,
    databaseNowMs: now,
    confirmedAtMs: now - minute,
    absoluteExpiresAtMs: now - minute + day,
    originalRunExpiresAtMs: request.runId === null ? null : now + 10 * minute,
    binding,
    original: { ...scope, plannerSource: scope.plannerSource ? { ...scope.plannerSource } : null },
    current: { ...scope, plannerSource: scope.plannerSource ? { ...scope.plannerSource } : null },
    tenantActive: true,
    membershipActive: true,
    roleAllowed: true,
    clientActive: true,
    clientWallAllowed: true,
    objectiveReady: true,
    policyAllowed: true,
    cancelled: false,
    superseded: false,
    attemptActive: true,
    completedResult:
      request.resultRef === null
        ? null
        : {
            attemptId: request.attemptId,
            runId: request.runId!,
            requestFingerprint: request.requestFingerprint,
            resultRef: request.resultRef,
            resultHash: request.resultHash!,
            completedAtMs: now - 1000,
          },
  };
  return { request, facts };
}

describe('pure workload authority policy (synthetic facts, never a grant)', () => {
  test('accepts closed syntax without returning actor/scope or trusting request identity', () => {
    const { request } = fixture();
    expect(parseWorkloadAuthorityRequest(request)).toEqual(request);
    expect(() => parseWorkloadAuthorityRequest({ ...request, tenantId: id(4) })).toThrow(
      'Invalid workload',
    );
    expect(() => parseWorkloadAuthorityRequest({ ...request, nativeActorId: id(5) })).toThrow();
  });

  test.each([
    { schemaVersion: '1' },
    { operation: 'objective.plan.prepare' },
    { audience: 'capiro:objective-planner-materialization:v1' },
    { phase: 'edit' },
    { runId: id(3) },
    { resultRef: 'result:1' },
    { resultHash: 'b'.repeat(64) },
    { attemptId: [id(2)] },
    { requestFingerprint: 'A'.repeat(64) },
    { delegationRef: 'https://private.example' },
  ])('refuses coercion, phase and cross-audience expansion: %j', (patch) => {
    expect(() => parseWorkloadAuthorityRequest({ ...fixture().request, ...patch })).toThrow();
  });

  test('rejects getters, proxies, symbols, exotic prototypes and hidden fields without executing traps', () => {
    const getter = jest.fn(() => 1);
    const value = { ...fixture().request };
    Object.defineProperty(value, 'schemaVersion', { enumerable: true, get: getter });
    expect(() => parseWorkloadAuthorityRequest(value)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const trap = jest.fn(() => {
      throw Error('must not execute');
    });
    expect(() =>
      parseWorkloadAuthorityRequest(new Proxy({}, { get: trap, ownKeys: trap })),
    ).toThrow();
    expect(trap).not.toHaveBeenCalled();
    expect(() =>
      parseWorkloadAuthorityRequest({ ...fixture().request, [Symbol('extra')]: true }),
    ).toThrow();
    expect(() =>
      parseWorkloadAuthorityRequest(Object.assign(Object.create({}), fixture().request)),
    ).toThrow();
    const hidden = { ...fixture().request };
    Object.defineProperty(hidden, 'phase', { value: 'dispatch', enumerable: false });
    expect(() => parseWorkloadAuthorityRequest(hidden)).toThrow();
  });

  test('null-prototype closed request is copied into safe data', () => {
    expect(
      parseWorkloadAuthorityRequest(Object.assign(Object.create(null), fixture().request)),
    ).toEqual(fixture().request);
  });

  test.each([
    'dispatch',
    'resume',
    'source_read',
    'result_read',
    'persist',
    'retained_result_read',
  ] as const)('%s eligibility is bounded, never an issuance receipt', (phase) => {
    const { request, facts } = fixture(phase);
    const result = evaluateWorkloadAuthority(request, facts);
    expect(result).toEqual({
      eligible: true,
      reason: null,
      validUntilMs:
        now + (phase === 'dispatch' || phase === 'retained_result_read' ? 15 : 10) * minute,
    });
    expect(Object.keys(result).sort()).toEqual(['eligible', 'reason', 'validUntilMs']);
  });

  test('Planner pair is separate and cannot exchange audience while retaining a generation binding', () => {
    const { request, facts } = fixture();
    request.audience = 'capiro:objective-planner-materialization:v1';
    request.operation = 'objective.plan.prepare';
    expect(evaluateWorkloadAuthority(request, facts)).toMatchObject({
      eligible: false,
      reason: 'binding_mismatch',
    });
    facts.binding.audience = request.audience;
    facts.binding.operation = request.operation;
    expect(evaluateWorkloadAuthority(request, facts)).toMatchObject({
      eligible: false,
      reason: 'source_changed',
    });
    const valid = fixture('dispatch', true);
    expect(evaluateWorkloadAuthority(valid.request, valid.facts).eligible).toBe(true);
  });

  test.each([
    'strategyId',
    'strategyVersionId',
    'strategyVersionDigest',
    'generationReceiptId',
    'groupsDigest',
  ] as const)('Planner rejects substituted saved lineage %s', (key) => {
    const { request, facts } = fixture('persist', true);
    facts.current.plannerSource![key] = key.endsWith('Digest') ? 'f'.repeat(64) : id(99);
    expect(evaluateWorkloadAuthority(request, facts)).toMatchObject({
      eligible: false,
      reason: 'source_changed',
    });
  });

  test.each(['original', 'current'] as const)(
    'Planner requires %s saved lineage; generation must have none',
    (key) => {
      const plan = fixture('persist', true);
      plan.facts[key].plannerSource = null;
      expect(evaluateWorkloadAuthority(plan.request, plan.facts)).toMatchObject({
        eligible: false,
        reason: 'source_changed',
      });
      const generation = fixture('persist');
      generation.facts[key].plannerSource = fixture('persist', true).facts.original.plannerSource;
      expect(evaluateWorkloadAuthority(generation.request, generation.facts)).toMatchObject({
        eligible: false,
        reason: 'source_changed',
      });
    },
  );

  test.each([
    { strategyVersionId: ['not-a-uuid'] },
    { strategyVersionDigest: 'bad' },
    { generationReceiptId: null },
    { groupsDigest: 'E'.repeat(64) },
    { unexpected: true },
  ])('Planner nested lineage is strict closed data: %j', (patch) => {
    const { request, facts } = fixture('persist', true);
    const bad = {
      ...facts,
      current: { ...facts.current, plannerSource: { ...facts.current.plannerSource, ...patch } },
    };
    expect(evaluateWorkloadAuthority(request, bad)).toMatchObject({
      eligible: false,
      reason: 'malformed_facts',
    });
  });

  test.each(['delegationRef', 'attemptId', 'requestFingerprint', 'runId'] as const)(
    'rejects mismatched stored %s',
    (key) => {
      const { request, facts } = fixture('resume');
      if (key === 'requestFingerprint') facts.binding[key] = 'd'.repeat(64);
      else facts.binding[key] = id(99);
      expect(evaluateWorkloadAuthority(request, facts)).toMatchObject({
        eligible: false,
        reason: 'binding_mismatch',
      });
    },
  );

  test.each([
    'tenantId',
    'nativeActorId',
    'membershipId',
    'clientId',
    'objectiveId',
    'objectiveRevisionId',
    'objectiveVersion',
    'policyRevision',
  ] as const)('does not silently rebind changed %s', (key) => {
    const { request, facts } = fixture();
    if (key === 'objectiveVersion') facts.current[key]++;
    else facts.current[key] = key === 'policyRevision' ? 'd'.repeat(64) : id(99);
    expect(evaluateWorkloadAuthority(request, facts).eligible).toBe(false);
  });

  test.each([
    'tenantActive',
    'membershipActive',
    'roleAllowed',
    'clientActive',
    'clientWallAllowed',
    'objectiveReady',
    'policyAllowed',
    'enabled',
    'attemptActive',
  ] as const)('denies disabled/pending/current-authority fact %s', (key) => {
    const { request, facts } = fixture();
    facts[key] = false;
    expect(evaluateWorkloadAuthority(request, facts).eligible).toBe(false);
  });

  test.each(['cancelled', 'superseded'] as const)(
    '%s blocks every phase including retained lookup',
    (key) => {
      const { request, facts } = fixture('retained_result_read');
      facts[key] = true;
      expect(evaluateWorkloadAuthority(request, facts)).toMatchObject({
        eligible: false,
        reason: key,
      });
    },
  );

  test.each([NaN, Infinity, -1, 1.5, '1800000000000', null])(
    'malformed DB time %s fails closed',
    (value) => {
      const { request, facts } = fixture();
      expect(evaluateWorkloadAuthority(request, { ...facts, databaseNowMs: value })).toMatchObject({
        eligible: false,
        reason: 'malformed_facts',
      });
    },
  );

  test('DB time alone governs host skew, fixed intent ceiling and expiry boundary', () => {
    const { request, facts } = fixture();
    const host = jest.spyOn(Date, 'now').mockImplementation(() => {
      throw Error('host clock forbidden');
    });
    try {
      facts.absoluteExpiresAtMs = now + 1;
      expect(evaluateWorkloadAuthority(request, facts)).toEqual({
        eligible: true,
        reason: null,
        validUntilMs: now + 1,
      });
      facts.databaseNowMs = now + 1;
      expect(evaluateWorkloadAuthority(request, facts)).toMatchObject({
        eligible: false,
        reason: 'expired_intent',
      });
      facts.absoluteExpiresAtMs = facts.confirmedAtMs + day + 1;
      expect(evaluateWorkloadAuthority(request, facts)).toMatchObject({
        eligible: false,
        reason: 'invalid_clock',
      });
      facts.absoluteExpiresAtMs = facts.confirmedAtMs + day;
      facts.confirmedAtMs = facts.databaseNowMs + 1;
      expect(evaluateWorkloadAuthority(request, facts)).toMatchObject({
        eligible: false,
        reason: 'invalid_clock',
      });
    } finally {
      host.mockRestore();
    }
  });

  test('run binding/expiry coherence is required and renewal never extends original expiry', () => {
    const { request, facts } = fixture('resume');
    facts.originalRunExpiresAtMs = now + 1;
    expect(evaluateWorkloadAuthority(request, facts)).toEqual({
      eligible: true,
      reason: null,
      validUntilMs: now + 1,
    });
    facts.databaseNowMs = now + 1;
    expect(evaluateWorkloadAuthority(request, facts)).toMatchObject({
      eligible: false,
      reason: 'run_expired',
    });
    facts.originalRunExpiresAtMs = null;
    expect(evaluateWorkloadAuthority(request, facts)).toMatchObject({
      eligible: false,
      reason: 'invalid_clock',
    });
  });

  test('late terminal outcome is read-recoverable after worker expiry, never writable', () => {
    const { request, facts } = fixture('retained_result_read');
    facts.originalRunExpiresAtMs = now - 10_000;
    facts.attemptActive = false;
    facts.completedResult!.completedAtMs = now - 1000;
    expect(evaluateWorkloadAuthority(request, facts)).toEqual({
      eligible: true,
      reason: null,
      validUntilMs: now + 15 * minute,
    });
    request.phase = 'persist';
    expect(evaluateWorkloadAuthority(request, facts)).toMatchObject({
      eligible: false,
      reason: 'inactive_attempt',
    });
    facts.attemptActive = true;
    expect(evaluateWorkloadAuthority(request, facts)).toMatchObject({
      eligible: false,
      reason: 'run_expired',
    });
    request.phase = 'result_read';
    expect(evaluateWorkloadAuthority(request, facts).eligible).toBe(false);
  });

  test.each(['persist', 'retained_result_read'] as const)(
    '%s refuses completed result predating its confirmed intent',
    (phase) => {
      const { request, facts } = fixture(phase);
      facts.completedResult!.completedAtMs = facts.confirmedAtMs - 1;
      expect(evaluateWorkloadAuthority(request, facts)).toMatchObject({
        eligible: false,
        reason: 'result_mismatch',
      });
    },
  );

  test.each([
    'attemptId',
    'runId',
    'requestFingerprint',
    'resultRef',
    'resultHash',
    'completedAtMs',
  ] as const)('retained read rejects substituted/future completed result %s', (key) => {
    const { request, facts } = fixture('retained_result_read');
    facts.attemptActive = false;
    if (key === 'completedAtMs') facts.completedResult![key] = now + 1;
    else
      facts.completedResult![key] =
        key.endsWith('Hash') || key === 'requestFingerprint' ? 'd'.repeat(64) : id(99);
    expect(evaluateWorkloadAuthority(request, facts)).toMatchObject({
      eligible: false,
      reason: 'result_mismatch',
    });
  });

  test('retained result still requires current wall and unexpired intent', () => {
    const { request, facts } = fixture('retained_result_read');
    facts.clientWallAllowed = false;
    expect(evaluateWorkloadAuthority(request, facts)).toMatchObject({
      eligible: false,
      reason: 'current_authority_denied',
    });
    facts.clientWallAllowed = true;
    facts.databaseNowMs = facts.absoluteExpiresAtMs;
    expect(evaluateWorkloadAuthority(request, facts)).toMatchObject({
      eligible: false,
      reason: 'expired_intent',
    });
  });

  test.each([
    'https://example.test/result',
    '../private',
    '',
    'a'.repeat(257),
    'secret token',
    'x\n',
  ])('opaque resultRef rejects %j', (resultRef) => {
    const { request } = fixture('persist');
    expect(() => parseWorkloadAuthorityRequest({ ...request, resultRef })).toThrow();
  });

  test('facts reject hidden nested authority/accessors and unknown fields without invoking them', () => {
    const { request, facts } = fixture();
    const get = jest.fn(() => id(4));
    Object.defineProperty(facts.current, 'tenantId', { enumerable: true, get });
    expect(evaluateWorkloadAuthority(request, facts)).toMatchObject({
      eligible: false,
      reason: 'malformed_facts',
    });
    expect(get).not.toHaveBeenCalled();
    expect(
      evaluateWorkloadAuthority(request, { ...fixture().facts, adminRole: true }),
    ).toMatchObject({ eligible: false });
    expect(
      evaluateWorkloadAuthority(request, { ...fixture().facts, enabled: 'true' }),
    ).toMatchObject({ eligible: false });
  });
});
