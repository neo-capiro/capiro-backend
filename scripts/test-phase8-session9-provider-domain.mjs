#!/usr/bin/env node
/**
 * Phase 8 Session 9 — cross-domain provider domain gate.
 *
 * Runs against the BUILT @capiro/defense-domain output so CI exercises the same
 * artifact the services consume. Every assertion is a Session 9 acceptance
 * requirement: deterministic fail-closed selection, failure classification,
 * bounded deterministic retry, idempotency, concurrency refusal, and an audit
 * record that cannot carry a secret, a payload or a dollar.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const domain = require('../packages/defense-domain/dist/index.js');

const {
  // selection
  selectEmbeddingProvider,
  selectClientRelevanceProvider,
  selectCrossDomainProviders,
  assertNoForbiddenProviderConfig,
  ForbiddenProviderConfigError,
  DEFAULT_EMBEDDING_MODEL,
  PROVIDER_LIMITS,
  // retry
  classifyHttpStatus,
  isRetryableFailure,
  nextRetryDecision,
  worstCaseLatencyMs,
  providerIdempotencyKey,
  payloadDigest,
  ProviderConcurrencyGate,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_PROVIDER_CONCURRENCY,
  // audit
  buildProviderAudit,
  assertProviderAuditCarriesNoSecrets,
  ProviderAuditLeakError,
  isDegradedOutcome,
  PROVIDER_OPERATIONS,
  PROVIDER_OUTCOMES,
} = domain;

const LIVE_EMBEDDING_ENV = {
  DEFENSE_EMBEDDING_PROVIDER: 'bedrock',
  DEFENSE_EMBEDDING_REGION: 'us-east-1',
};

const LIVE_RELEVANCE_ENV = {
  DEFENSE_CLIENT_RELEVANCE_PROVIDER: 'internal_service',
  DEFENSE_MAIN_API_BASE_URL: 'https://api.capiro.ai',
  DEFENSE_MAIN_API_INTERNAL_SECRET: 'x'.repeat(40),
};

// ── selection is dark by default and fails closed ──────────────────────────

test('an empty environment selects dark for BOTH ports', () => {
  const selections = selectCrossDomainProviders({});
  assert.equal(selections.embedding.mode, 'dark');
  assert.equal(selections.embedding.live, false);
  assert.equal(selections.clientRelevance.mode, 'dark');
  assert.equal(selections.clientRelevance.live, false);
  assert.equal(selections.anyLive, false);
  // Every dark selection must say why, or an unconfigured deployment is
  // indistinguishable from a misconfigured one.
  assert.ok(selections.embedding.reason.length > 0);
  assert.ok(selections.clientRelevance.reason.length > 0);
});

test('a credential alone can never turn a dark deployment live', () => {
  // The explicit provider switch is required. Credentials appearing in the
  // environment - as they might from a shared task definition - must not be
  // enough on their own.
  const embedding = selectEmbeddingProvider({
    DEFENSE_EMBEDDING_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  });
  assert.equal(embedding.live, false, 'no explicit provider switch means dark');

  const relevance = selectClientRelevanceProvider({
    DEFENSE_MAIN_API_BASE_URL: 'https://api.capiro.ai',
    DEFENSE_MAIN_API_INTERNAL_SECRET: 'secret-value',
  });
  assert.equal(relevance.live, false, 'no explicit provider switch means dark');
});

test('a fully configured embedding provider is selected live', () => {
  const selection = selectEmbeddingProvider(LIVE_EMBEDDING_ENV);
  assert.equal(selection.mode, 'bedrock_embedding');
  assert.equal(selection.live, true);
  assert.equal(selection.resolved.region, 'us-east-1');
  assert.equal(selection.resolved.model, DEFAULT_EMBEDDING_MODEL);
  assert.equal(selection.resolved.timeoutMs, PROVIDER_LIMITS.defaultTimeoutMs);
  assert.equal(selection.resolved.maxAttempts, PROVIDER_LIMITS.defaultAttempts);
});

test('the embedding model id is part of the stored-vector contract', () => {
  // Every vector read filters on context_embeddings.model, so an override must
  // be honoured exactly - a mismatch returns zero rows rather than an error.
  const overridden = selectEmbeddingProvider({
    ...LIVE_EMBEDDING_ENV,
    DEFENSE_EMBEDDING_MODEL: 'amazon.titan-embed-text-v1',
  });
  assert.equal(overridden.resolved.model, 'amazon.titan-embed-text-v1');

  // And apps/api's own variable is honoured when the defense-specific one is
  // absent, so the two services cannot silently disagree.
  const inherited = selectEmbeddingProvider({
    ...LIVE_EMBEDDING_ENV,
    EMBEDDINGS_MODEL: 'amazon.titan-embed-text-v1',
  });
  assert.equal(inherited.resolved.model, 'amazon.titan-embed-text-v1');
});

test('a malformed region, timeout or attempt count selects dark, never a guess', () => {
  for (const override of [
    { DEFENSE_EMBEDDING_REGION: 'not-a-region' },
    { DEFENSE_EMBEDDING_REGION: '' },
    { DEFENSE_EMBEDDING_TIMEOUT_MS: '0' },
    { DEFENSE_EMBEDDING_TIMEOUT_MS: '999999' },
    { DEFENSE_EMBEDDING_TIMEOUT_MS: 'soon' },
    { DEFENSE_EMBEDDING_TIMEOUT_MS: '1.5' },
    { DEFENSE_EMBEDDING_MAX_ATTEMPTS: '0' },
    { DEFENSE_EMBEDDING_MAX_ATTEMPTS: '99' },
  ]) {
    const selection = selectEmbeddingProvider({ ...LIVE_EMBEDDING_ENV, ...override });
    assert.equal(
      selection.live,
      false,
      `${JSON.stringify(override)} must select dark, got ${selection.mode}`,
    );
    assert.ok(selection.reason.length > 0);
  }
});

test('an unknown provider name selects dark rather than guessing', () => {
  const selection = selectEmbeddingProvider({ DEFENSE_EMBEDDING_PROVIDER: 'openai' });
  assert.equal(selection.live, false);
  assert.match(selection.reason, /refusing to guess/);
});

test('a fully configured relevance provider is selected live', () => {
  const selection = selectClientRelevanceProvider(LIVE_RELEVANCE_ENV);
  assert.equal(selection.mode, 'internal_service_relevance');
  assert.equal(selection.live, true);
  assert.equal(selection.resolved.baseUrl, 'https://api.capiro.ai');
  assert.equal(selection.resolved.maxBatch, PROVIDER_LIMITS.defaultRelevanceBatch);
});

test('the relevance base URL must be a bare https origin', () => {
  for (const baseUrl of [
    'http://api.capiro.ai',
    'https://api.capiro.ai/internal',
    'https://api.capiro.ai/?x=1',
    'https://api.capiro.ai/#frag',
    'not a url',
    '',
  ]) {
    const selection = selectClientRelevanceProvider({
      ...LIVE_RELEVANCE_ENV,
      DEFENSE_MAIN_API_BASE_URL: baseUrl,
    });
    assert.equal(selection.live, false, `${baseUrl} must be refused`);
  }
});

test('a missing internal secret selects dark, because the far side is fail-closed', () => {
  const selection = selectClientRelevanceProvider({
    ...LIVE_RELEVANCE_ENV,
    DEFENSE_MAIN_API_INTERNAL_SECRET: '',
  });
  assert.equal(selection.live, false);
  assert.match(selection.reason, /SECRET is not configured/);
});

test('no selection ever carries secret material', () => {
  const selection = selectClientRelevanceProvider(LIVE_RELEVANCE_ENV);
  const serialised = JSON.stringify(selection);
  assert.ok(
    !serialised.includes(LIVE_RELEVANCE_ENV.DEFENSE_MAIN_API_INTERNAL_SECRET),
    'the shared secret must never appear in a selection',
  );
  assert.ok(!/secret|credential|token/i.test(JSON.stringify(selection.resolved)));
});

test('the Session 3 forbidden credential classes are still refused', () => {
  for (const key of [
    'DEFENSE_PROMOTER_ROLE',
    'DEFENSE_SNAPSHOT_ACTIVATION_TOKEN',
    'NVIDIA_API_KEY',
    'SAGEMAKER_MODEL_ADMIN_ROLE',
    'DEFENSE_PARSER_MODEL_KEY',
    'SOME_GPU_ACCESS_CREDENTIAL',
  ]) {
    assert.throws(
      () => assertNoForbiddenProviderConfig({ [key]: 'x' }),
      ForbiddenProviderConfigError,
      `${key} must be refused`,
    );
  }
});

test('the credentials Session 9 DOES introduce are permitted', () => {
  // Neither is in the Session 3 forbidden set, which is precisely why this
  // session can wire them without changing that boundary.
  assert.doesNotThrow(() =>
    assertNoForbiddenProviderConfig({
      DEFENSE_EMBEDDING_PROVIDER: 'bedrock',
      DEFENSE_EMBEDDING_REGION: 'us-east-1',
      DEFENSE_MAIN_API_INTERNAL_SECRET: 'x',
      DEFENSE_MAIN_API_BASE_URL: 'https://api.capiro.ai',
    }),
  );
});

// ── failure classification ─────────────────────────────────────────────────

test('auth failures are terminal and throttles are retryable', () => {
  assert.equal(classifyHttpStatus(401), 'unauthorized');
  assert.equal(classifyHttpStatus(403), 'unauthorized');
  assert.equal(isRetryableFailure('unauthorized'), false, 'hammering an auth failure is an incident');

  assert.equal(classifyHttpStatus(429), 'throttled');
  assert.equal(isRetryableFailure('throttled'), true);

  assert.equal(classifyHttpStatus(408), 'timeout');
  assert.equal(isRetryableFailure('timeout'), true);

  assert.equal(classifyHttpStatus(400), 'invalid_request');
  assert.equal(isRetryableFailure('invalid_request'), false);

  assert.equal(classifyHttpStatus(503), 'unavailable');
  assert.equal(isRetryableFailure('unavailable'), true);

  assert.equal(isRetryableFailure('malformed_response'), false);
});

// ── retry is bounded and deterministic ─────────────────────────────────────

const POLICY = { maxAttempts: 3, timeoutMs: 1_000 };

test('retry backoff is exponential and has no jitter', () => {
  const first = nextRetryDecision({
    failure: 'throttled',
    attemptsMade: 1,
    policy: POLICY,
    elapsedMs: 0,
  });
  const second = nextRetryDecision({
    failure: 'throttled',
    attemptsMade: 2,
    policy: POLICY,
    elapsedMs: 0,
  });
  assert.equal(first.retry, true);
  assert.equal(first.delayMs, DEFAULT_BASE_DELAY_MS);
  assert.equal(second.delayMs, DEFAULT_BASE_DELAY_MS * 2);

  // Determinism: a replay must reproduce the schedule exactly.
  const repeat = nextRetryDecision({
    failure: 'throttled',
    attemptsMade: 1,
    policy: POLICY,
    elapsedMs: 0,
  });
  assert.deepEqual(repeat, first);
});

test('the attempt budget is honoured', () => {
  const decision = nextRetryDecision({
    failure: 'unavailable',
    attemptsMade: 3,
    policy: POLICY,
    elapsedMs: 0,
  });
  assert.equal(decision.retry, false);
  assert.match(decision.reason, /attempt budget exhausted/);
});

test('a terminal failure is never retried', () => {
  for (const failure of ['unauthorized', 'invalid_request', 'malformed_response']) {
    const decision = nextRetryDecision({
      failure,
      attemptsMade: 1,
      policy: POLICY,
      elapsedMs: 0,
    });
    assert.equal(decision.retry, false, `${failure} must be terminal`);
    assert.match(decision.reason, /terminal/);
  }
});

test('the total budget bounds the request independently of maxAttempts', () => {
  // Ten attempts would be allowed by the attempt budget, but the wall-clock
  // ceiling stops the read route from being held open.
  const decision = nextRetryDecision({
    failure: 'timeout',
    attemptsMade: 1,
    policy: { maxAttempts: 10, timeoutMs: 1_000, totalBudgetMs: 1_500 },
    elapsedMs: 1_000,
  });
  assert.equal(decision.retry, false);
  assert.match(decision.reason, /total budget/);
});

test('a provider Retry-After is obeyed when it asks for longer', () => {
  const decision = nextRetryDecision({
    failure: 'throttled',
    attemptsMade: 1,
    policy: { maxAttempts: 3, timeoutMs: 1_000, totalBudgetMs: 60_000 },
    elapsedMs: 0,
    retryAfterMs: 5_000,
  });
  assert.equal(decision.retry, true);
  assert.equal(decision.delayMs, 5_000, 'the provider asked for longer than our backoff');

  // But a shorter Retry-After does not let us go faster than our own backoff.
  const shorter = nextRetryDecision({
    failure: 'throttled',
    attemptsMade: 2,
    policy: { maxAttempts: 3, timeoutMs: 1_000, totalBudgetMs: 60_000 },
    elapsedMs: 0,
    retryAfterMs: 1,
  });
  assert.equal(shorter.delayMs, DEFAULT_BASE_DELAY_MS * 2);
});

test('worst-case latency is computable and bounded', () => {
  // 3 x 1000ms attempts + 100ms + 200ms of backoff.
  assert.equal(worstCaseLatencyMs(POLICY), 3_300);
  assert.equal(
    worstCaseLatencyMs({ maxAttempts: 3, timeoutMs: 1_000, totalBudgetMs: 2_000 }),
    2_000,
    'the total budget caps the worst case',
  );
});

// ── idempotency ────────────────────────────────────────────────────────────

test('the idempotency key is stable, and key order does not matter', () => {
  const a = providerIdempotencyKey({
    provider: 'bedrock',
    operation: 'embed_query',
    model: 'm',
    tenantId: 't1',
    payload: { chars: 12, model: 'm' },
  });
  const b = providerIdempotencyKey({
    provider: 'bedrock',
    operation: 'embed_query',
    model: 'm',
    tenantId: 't1',
    payload: { model: 'm', chars: 12 },
  });
  assert.equal(a, b, 'canonical JSON means key order cannot change the key');
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('the tenant is part of the idempotency key', () => {
  const one = providerIdempotencyKey({
    provider: 'main_api_internal',
    operation: 'relevant_pe_codes',
    model: null,
    tenantId: 'tenant-a',
    payload: { codes: ['PE1'] },
  });
  const two = providerIdempotencyKey({
    provider: 'main_api_internal',
    operation: 'relevant_pe_codes',
    model: null,
    tenantId: 'tenant-b',
    payload: { codes: ['PE1'] },
  });
  assert.notEqual(one, two, 'collapsing tenants would let one serve another its result');
});

test('the payload digest records shape without recording content', () => {
  const digest = payloadDigest({ codes: ['PE0603461F'], minScore: 0.5 });
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.ok(!digest.includes('PE0603461F'));
});

// ── concurrency ────────────────────────────────────────────────────────────

test('the concurrency gate refuses rather than queues', async () => {
  const gate = new ProviderConcurrencyGate('bedrock', 2);
  assert.equal(gate.tryAcquire(), true);
  assert.equal(gate.tryAcquire(), true);
  assert.equal(gate.active, 2);
  assert.equal(gate.tryAcquire(), false, 'queueing on a read path makes an empty result slow');
  gate.release();
  assert.equal(gate.tryAcquire(), true);
});

test('run() does not call the function when the gate is full', async () => {
  const gate = new ProviderConcurrencyGate('bedrock', 1);
  gate.tryAcquire();
  let called = false;
  const result = await gate.run(async () => {
    called = true;
    return 'value';
  });
  assert.equal(result, null);
  assert.equal(called, false, 'a refused slot must not invoke the provider');
});

test('the gate releases on a thrown function', async () => {
  const gate = new ProviderConcurrencyGate('bedrock', 1);
  await assert.rejects(
    gate.run(async () => {
      throw new Error('provider blew up');
    }),
  );
  assert.equal(gate.active, 0, 'a leaked slot would wedge the provider permanently');
});

test('an invalid concurrency limit is refused', () => {
  assert.throws(() => new ProviderConcurrencyGate('p', 0), RangeError);
  assert.throws(() => new ProviderConcurrencyGate('p', 1.5), RangeError);
  assert.ok(DEFAULT_PROVIDER_CONCURRENCY >= 1);
});

// ── audit records ──────────────────────────────────────────────────────────

const VALID_AUDIT = {
  provider: 'bedrock',
  operation: 'embed_query',
  outcome: 'succeeded',
  model: 'amazon.titan-embed-text-v2:0',
  tenantId: 'tenant-a',
  payloadSha256: 'a'.repeat(64),
  idempotencyKey: 'b'.repeat(64),
  attempts: 1,
  latencyMs: 42,
  failureClass: null,
  reason: 'provider answered on attempt 1',
  resultDimension: 1024,
  resultCount: null,
  startedAt: '2026-08-21T00:00:00.000Z',
  finishedAt: '2026-08-21T00:00:00.042Z',
};

test('a valid audit record is accepted and frozen', () => {
  const record = buildProviderAudit(VALID_AUDIT);
  assert.equal(record.outcome, 'succeeded');
  assert.equal(Object.isFrozen(record), true);
});

test('an audit record cannot carry a secret, a payload or a dollar', () => {
  for (const field of [
    'secret',
    'apiKey',
    'authorization',
    'bearerToken',
    'credential',
    'vector',
    'embedding',
    'queryText',
    'peCodes',
    'amountUsd',
    'obligationTotal',
  ]) {
    assert.throws(
      () => assertProviderAuditCarriesNoSecrets({ ...VALID_AUDIT, [field]: 'x' }),
      ProviderAuditLeakError,
      `${field} must be refused on an audit row`,
    );
  }
});

test('a credential-shaped VALUE is refused regardless of its field name', () => {
  assert.throws(
    () => assertProviderAuditCarriesNoSecrets({ ...VALID_AUDIT, reason: 'Bearer abc.def' }),
    ProviderAuditLeakError,
  );
  assert.throws(
    () => assertProviderAuditCarriesNoSecrets({ ...VALID_AUDIT, reason: 'AKIAIOSFODNN7EXAMPLE' }),
    ProviderAuditLeakError,
  );
});

test('the leak guard walks nested structures at any depth', () => {
  assert.throws(
    () =>
      assertProviderAuditCarriesNoSecrets({
        ...VALID_AUDIT,
        nested: { deeper: [{ apiKey: 'leak' }] },
      }),
    ProviderAuditLeakError,
  );
});

test('the safe digest and count fields are named exemptions, not accidents', () => {
  // payloadSha256 is the SAFE form of the payload the guard forbids.
  assert.doesNotThrow(() => assertProviderAuditCarriesNoSecrets(VALID_AUDIT));
});

test('a failed invocation must name a failure class, and a success must not', () => {
  // Mirrors dpi_failure_class_chk, enforced in BOTH directions.
  assert.throws(
    () =>
      buildProviderAudit({
        ...VALID_AUDIT,
        outcome: 'degraded_failed',
        failureClass: null,
        resultDimension: null,
      }),
    /exactly the degraded_failed outcome carries a failure class/,
    'a failure with no named class must be unrepresentable',
  );

  assert.throws(
    () => buildProviderAudit({ ...VALID_AUDIT, failureClass: 'throttled' }),
    /exactly the degraded_failed outcome carries a failure class/,
    'a SUCCESS carrying a failure class must be refused too',
  );

  const failed = buildProviderAudit({
    ...VALID_AUDIT,
    outcome: 'degraded_failed',
    failureClass: 'throttled',
    reason: 'provider throttled us',
    resultDimension: null,
    attempts: 3,
  });
  assert.equal(failed.failureClass, 'throttled');
  assert.equal(failed.resultDimension, null);
});

test('a degraded invocation cannot claim an embedding dimension', () => {
  assert.throws(
    () =>
      buildProviderAudit({
        ...VALID_AUDIT,
        outcome: 'degraded_unconfigured',
        resultDimension: 1024,
      }),
    /dimension/,
  );
});

test('a successful invocation must record a result', () => {
  assert.throws(
    () =>
      buildProviderAudit({
        ...VALID_AUDIT,
        resultDimension: null,
        resultCount: null,
      }),
    /result/,
  );
});

test('a malformed digest or empty reason is refused', () => {
  assert.throws(() => buildProviderAudit({ ...VALID_AUDIT, payloadSha256: 'short' }), RangeError);
  assert.throws(() => buildProviderAudit({ ...VALID_AUDIT, idempotencyKey: 'nope' }), RangeError);
  assert.throws(() => buildProviderAudit({ ...VALID_AUDIT, reason: '   ' }), RangeError);
  assert.throws(() => buildProviderAudit({ ...VALID_AUDIT, attempts: -1 }), RangeError);
  assert.throws(() => buildProviderAudit({ ...VALID_AUDIT, latencyMs: -1 }), RangeError);
});

test('every declared outcome is either success or an explicit degrade', () => {
  assert.equal(PROVIDER_OUTCOMES.length, 5);
  for (const outcome of PROVIDER_OUTCOMES) {
    if (outcome === 'succeeded') {
      assert.equal(isDegradedOutcome(outcome), false);
    } else {
      assert.ok(outcome.startsWith('degraded_'), `${outcome} must be an explicit degrade`);
      assert.equal(isDegradedOutcome(outcome), true);
    }
  }
  assert.deepEqual([...PROVIDER_OPERATIONS], ['embed_query', 'relevant_pe_codes']);
});
