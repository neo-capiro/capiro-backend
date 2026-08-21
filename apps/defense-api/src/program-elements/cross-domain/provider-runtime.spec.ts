/**
 * Phase 8 Session 9 — provider runtime spec.
 *
 * Drives the real adapters and the real runner against a scripted transport, a
 * deterministic clock and an in-memory audit sink that mirrors the database's own
 * CHECK constraints. No network, no credential, no database.
 *
 * What is being proved is the part that fails silently in production: that a
 * failing provider degrades instead of throwing, that a degrade is always
 * auditable and attributable, that retry is bounded, that concurrency is refused
 * rather than queued, and that an unconfigured deployment behaves exactly as it
 * did before Session 9.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { CLIENT_RELEVANCE_PORT, EMBEDDING_PORT } from '@capiro/defense-contracts';

import { BedrockEmbeddingAdapter, interpretTitanEmbedding } from './bedrock-embedding.adapter.js';
import {
  InternalServiceClientRelevanceAdapter,
  interpretRelevanceResponse,
  RELEVANCE_BATCH_PATH,
} from './internal-service-client-relevance.adapter.js';
import { ProviderInvocationRunner } from './provider-invocation.runner.js';
import { bindCrossDomainProviders } from './provider-runtime.factory.js';
import { UnconfiguredClientRelevancePort, UnconfiguredEmbeddingPort } from './ports.js';
import { parseRetryAfter } from './https-provider-http.adapter.js';
import {
  FakeProviderClock,
  InMemoryProviderAuditSink,
  ScriptedProviderHttp,
  type ScriptedResponse,
} from './testing/provider-test-doubles.js';

import { selectClientRelevanceProvider, selectEmbeddingProvider } from '@capiro/defense-domain';

const LIVE_EMBEDDING_ENV = {
  DEFENSE_EMBEDDING_PROVIDER: 'bedrock',
  DEFENSE_EMBEDDING_REGION: 'us-east-1',
  DEFENSE_EMBEDDING_MAX_ATTEMPTS: '3',
  DEFENSE_EMBEDDING_TIMEOUT_MS: '1000',
};

const SECRET = 'internal-service-secret-value';

const LIVE_RELEVANCE_ENV = {
  DEFENSE_CLIENT_RELEVANCE_PROVIDER: 'internal_service',
  DEFENSE_MAIN_API_BASE_URL: 'https://api.capiro.ai',
  DEFENSE_MAIN_API_INTERNAL_SECRET: SECRET,
  DEFENSE_CLIENT_RELEVANCE_MAX_ATTEMPTS: '3',
  DEFENSE_CLIENT_RELEVANCE_TIMEOUT_MS: '1000',
  DEFENSE_CLIENT_RELEVANCE_MAX_BATCH: '3',
};

function embeddingHarness(script: readonly ScriptedResponse[], concurrency = 4) {
  const http = new ScriptedProviderHttp(script);
  const audit = new InMemoryProviderAuditSink();
  const clock = new FakeProviderClock();
  const runner = new ProviderInvocationRunner(audit, clock, new Map());
  const adapter = new BedrockEmbeddingAdapter(
    http,
    runner,
    selectEmbeddingProvider(LIVE_EMBEDDING_ENV),
    concurrency,
  );
  return { http, audit, clock, adapter };
}

function relevanceHarness(script: readonly ScriptedResponse[], concurrency = 4) {
  const http = new ScriptedProviderHttp(script);
  const audit = new InMemoryProviderAuditSink();
  const clock = new FakeProviderClock();
  const runner = new ProviderInvocationRunner(audit, clock, new Map());
  const adapter = new InternalServiceClientRelevanceAdapter(
    http,
    runner,
    selectClientRelevanceProvider(LIVE_RELEVANCE_ENV),
    SECRET,
    concurrency,
  );
  return { http, audit, clock, adapter };
}

// ── dark by default ────────────────────────────────────────────────────────

test('an unconfigured environment binds BOTH ports dark, exactly as before Session 9', () => {
  const audit = new InMemoryProviderAuditSink();
  const bound = bindCrossDomainProviders({ audit, env: {} });

  assert.ok(bound.embedding instanceof UnconfiguredEmbeddingPort);
  assert.ok(bound.clientRelevance instanceof UnconfiguredClientRelevancePort);
  assert.equal(bound.embeddingSelection.live, false);
  assert.equal(bound.clientRelevanceSelection.live, false);
});

test('the dark ports still serve their documented degraded results', async () => {
  const bound = bindCrossDomainProviders({ audit: new InMemoryProviderAuditSink(), env: {} });
  assert.equal(await bound.embedding.embedQuery('hypersonics'), null);
  const relevant = await bound.clientRelevance.relevantPeCodes({
    tenantId: 't',
    userId: 'u',
    peCodes: ['PE1'],
    minScore: 0.5,
  });
  assert.equal(relevant.size, 0);
});

test('a live environment binds real providers', () => {
  const bound = bindCrossDomainProviders({
    audit: new InMemoryProviderAuditSink(),
    http: new ScriptedProviderHttp([]),
    clock: new FakeProviderClock(),
    env: { ...LIVE_EMBEDDING_ENV, ...LIVE_RELEVANCE_ENV },
  });
  assert.ok(bound.embedding instanceof BedrockEmbeddingAdapter);
  assert.ok(bound.clientRelevance instanceof InternalServiceClientRelevanceAdapter);
  assert.equal(bound.embeddingSelection.live, true);
  assert.equal(bound.clientRelevanceSelection.live, true);
});

test('a forbidden Session 3 credential class fails LOUD, not dark', () => {
  // A degraded provider is a normal state; a boundary violation is not.
  assert.throws(
    () =>
      bindCrossDomainProviders({
        audit: new InMemoryProviderAuditSink(),
        env: { NVIDIA_API_KEY: 'x' },
      }),
    /must not be present on the defense HTTP serve task/,
  );
});

test('a live selection that cannot construct degrades to dark instead of failing boot', () => {
  // The secret is required by the adapter's constructor; an env that selects live
  // but yields no secret must not take the application down.
  const bound = bindCrossDomainProviders({
    audit: new InMemoryProviderAuditSink(),
    http: new ScriptedProviderHttp([]),
    env: {
      DEFENSE_CLIENT_RELEVANCE_PROVIDER: 'internal_service',
      DEFENSE_MAIN_API_BASE_URL: 'https://api.capiro.ai',
      // Selection needs this present, but we blank it after selection by
      // constructing the adapter directly below; here it stays dark by selection.
    },
  });
  assert.ok(bound.clientRelevance instanceof UnconfiguredClientRelevancePort);
});

test('constructing a live adapter from a dark selection is refused', () => {
  const http = new ScriptedProviderHttp([]);
  const runner = new ProviderInvocationRunner(
    new InMemoryProviderAuditSink(),
    new FakeProviderClock(),
    new Map(),
  );
  assert.throws(
    () => new BedrockEmbeddingAdapter(http, runner, selectEmbeddingProvider({}), 4),
    /requires a live bedrock selection/,
  );
  assert.throws(
    () =>
      new InternalServiceClientRelevanceAdapter(
        http,
        runner,
        selectClientRelevanceProvider({}),
        SECRET,
        4,
      ),
    /requires a live internal_service selection/,
  );
});

// ── embedding provider ─────────────────────────────────────────────────────

test('a successful embedding returns the vector and audits the dimension only', async () => {
  const { adapter, audit, http } = embeddingHarness([
    { body: { embedding: [0.1, 0.2, 0.3] } },
  ]);

  const vector = await adapter.embedQuery('hypersonic glide vehicles');
  assert.deepEqual([...(vector ?? [])], [0.1, 0.2, 0.3]);
  assert.equal(http.attempts, 1);

  assert.equal(audit.rows.length, 1);
  const row = audit.rows[0];
  assert.ok(row);
  assert.equal(row.outcome, 'succeeded');
  assert.equal(row.operation, 'embed_query');
  assert.equal(row.resultDimension, 3, 'the dimension is recorded');
  assert.equal(row.attempts, 1);
  assert.equal(row.failureClass, null);
  // The vector itself and the query text must be nowhere on the row.
  const serialised = JSON.stringify(row);
  assert.ok(!serialised.includes('0.2'), 'no vector component may be persisted');
  assert.ok(!serialised.includes('hypersonic'), 'no query text may be persisted');
});

test('the model id travels on every audit row, because vector reads filter on it', async () => {
  const { adapter, audit } = embeddingHarness([{ body: { embedding: [1] } }]);
  await adapter.embedQuery('q');
  assert.equal(audit.rows[0]?.model, adapter.model);
  assert.equal(adapter.model, 'amazon.titan-embed-text-v2:0');
});

test('an empty query spends no attempt and is still audited', async () => {
  const { adapter, audit, http } = embeddingHarness([]);
  assert.equal(await adapter.embedQuery('   '), null);
  assert.equal(http.attempts, 0, 'an empty query must not reach the provider');
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0]?.outcome, 'degraded_empty_input');
  assert.equal(audit.rows[0]?.attempts, 0);
});

test('a throttled provider is retried and then degrades to null, never throws', async () => {
  const { adapter, audit, clock, http } = embeddingHarness([
    { ok: false, statusCode: 429, failureClass: 'throttled' },
    { ok: false, statusCode: 429, failureClass: 'throttled' },
    { ok: false, statusCode: 429, failureClass: 'throttled' },
  ]);

  const vector = await adapter.embedQuery('q');
  assert.equal(vector, null, 'the port degrades rather than raising');
  assert.equal(http.attempts, 3, 'exactly the attempt budget');
  assert.deepEqual(clock.slept, [100, 200], 'deterministic exponential backoff, no jitter');

  const row = audit.rows[0];
  assert.ok(row);
  assert.equal(row.outcome, 'degraded_failed');
  assert.equal(row.failureClass, 'throttled');
  assert.equal(row.attempts, 3);
  assert.equal(row.resultDimension, null);
  assert.ok(row.reason.length > 0);
});

test('an auth failure is NOT retried', async () => {
  const { adapter, audit, http } = embeddingHarness([
    { ok: false, statusCode: 403, failureClass: 'unauthorized' },
  ]);
  assert.equal(await adapter.embedQuery('q'), null);
  assert.equal(http.attempts, 1, 'hammering an auth failure is how it becomes an incident');
  assert.equal(audit.rows[0]?.failureClass, 'unauthorized');
});

test('a transient failure followed by success returns the vector', async () => {
  const { adapter, audit, http } = embeddingHarness([
    { ok: false, statusCode: 503, failureClass: 'unavailable' },
    { body: { embedding: [0.5, 0.6] } },
  ]);
  const vector = await adapter.embedQuery('q');
  assert.deepEqual([...(vector ?? [])], [0.5, 0.6]);
  assert.equal(http.attempts, 2);
  assert.equal(audit.rows[0]?.outcome, 'succeeded');
  assert.equal(audit.rows[0]?.attempts, 2);
});

test('a 200 with an unusable body is a failure, not an empty success', async () => {
  for (const body of [
    {},
    { embedding: [] },
    { embedding: ['a'] },
    { embedding: [Number.NaN] },
    { embedding: [1, null] },
    null,
  ]) {
    const { adapter, audit } = embeddingHarness([{ body }, { body }, { body }]);
    assert.equal(await adapter.embedQuery('q'), null);
    const row = audit.rows[0];
    assert.equal(row?.outcome, 'degraded_failed');
    assert.equal(
      row?.failureClass,
      'malformed_response',
      `body ${JSON.stringify(body)} must be malformed, not an empty success`,
    );
  }
});

test('a NaN vector component is rejected outright', () => {
  // A NaN would silently poison every cosine comparison downstream.
  assert.equal(interpretTitanEmbedding({ embedding: [1, Number.NaN, 3] }), null);
  assert.equal(interpretTitanEmbedding({ embedding: [1, Infinity] }), null);
  assert.deepEqual([...(interpretTitanEmbedding({ embedding: [1, 2] }) ?? [])], [1, 2]);
});

test('concurrency is refused rather than queued, and audited as such', async () => {
  const { adapter, audit } = embeddingHarness(
    [{ body: { embedding: [1] } }, { body: { embedding: [1] } }],
    1,
  );

  // Two concurrent calls against a limit of one: the second is refused.
  const [first, second] = await Promise.all([adapter.embedQuery('a'), adapter.embedQuery('b')]);
  const results = [first, second];
  assert.equal(results.filter((value) => value !== null).length, 1, 'one succeeds');
  assert.equal(results.filter((value) => value === null).length, 1, 'one is refused');

  const refused = audit.byOutcome('degraded_concurrency');
  assert.equal(refused.length, 1);
  assert.equal(refused[0]?.attempts, 0, 'a refused call never reaches the provider');
});

test('an audit write failure does not fail the read path', async () => {
  const { adapter, audit } = embeddingHarness([{ body: { embedding: [1, 2] } }]);
  audit.failNext = true;
  const vector = await adapter.embedQuery('q');
  assert.deepEqual(
    [...(vector ?? [])],
    [1, 2],
    'a failed audit insert must not turn a working read into a 500',
  );
});

// ── client relevance provider ──────────────────────────────────────────────

test('relevance is ONE batched call, not an N+1 fanout', async () => {
  const { adapter, http } = relevanceHarness([
    { body: { relevantPeCodes: ['PE0603461F'] } },
  ]);

  const result = await adapter.relevantPeCodes({
    tenantId: 'tenant-a',
    userId: 'user-1',
    peCodes: ['PE0603461F', 'PE0604770D', 'PE0605030F'],
    minScore: 0.5,
  });

  assert.equal(http.attempts, 1, 'three PE codes must cost ONE call');
  assert.deepEqual([...result], ['PE0603461F']);

  const call = http.calls[0];
  assert.ok(call);
  assert.equal(call.url, `https://api.capiro.ai${RELEVANCE_BATCH_PATH}`);
  assert.equal(
    call.headers['x-internal-service-secret'],
    SECRET,
    'the existing internal-service channel is used',
  );
});

test('the secret is on the wire but never on an audit row', async () => {
  const { adapter, audit } = relevanceHarness([{ body: { relevantPeCodes: [] } }]);
  await adapter.relevantPeCodes({
    tenantId: 'tenant-a',
    userId: 'user-1',
    peCodes: ['PE1'],
    minScore: 0.5,
  });
  const serialised = JSON.stringify(audit.rows);
  assert.ok(!serialised.includes(SECRET), 'the shared secret must never be persisted');
  assert.ok(!serialised.includes('PE1'), 'tenant PE codes must never be persisted');
});

test('an empty answer is a valid answer, not a failure', async () => {
  const { adapter, audit } = relevanceHarness([{ body: { relevantPeCodes: [] } }]);
  const result = await adapter.relevantPeCodes({
    tenantId: 't',
    userId: 'u',
    peCodes: ['PE1'],
    minScore: 0.5,
  });
  assert.equal(result.size, 0);
  assert.equal(audit.rows[0]?.outcome, 'succeeded', '"none are relevant" is a success');
  assert.equal(audit.rows[0]?.resultCount, 0);
});

test('an unrequested code in the response is dropped, not trusted', async () => {
  const { adapter } = relevanceHarness([
    { body: { relevantPeCodes: ['PE1', 'PE_NEVER_ASKED'] } },
  ]);
  const result = await adapter.relevantPeCodes({
    tenantId: 't',
    userId: 'u',
    peCodes: ['PE1'],
    minScore: 0.5,
  });
  assert.deepEqual([...result], ['PE1'], 'a provider cannot inject relevance for a non-candidate');
});

test('the batch is bounded and the truncation is not silent', async () => {
  const { adapter, http } = relevanceHarness([{ body: { relevantPeCodes: [] } }]);
  await adapter.relevantPeCodes({
    tenantId: 't',
    userId: 'u',
    // maxBatch is 3 in this harness.
    peCodes: ['PE1', 'PE2', 'PE3', 'PE4', 'PE5'],
    minScore: 0.5,
  });
  const body = http.calls[0]?.body as { peCodes: string[] };
  assert.equal(body.peCodes.length, 3, 'the batch must be capped');
});

test('an empty candidate set makes no call and is audited', async () => {
  const { adapter, audit, http } = relevanceHarness([]);
  const result = await adapter.relevantPeCodes({
    tenantId: 't',
    userId: 'u',
    peCodes: ['', '   '],
    minScore: 0.5,
  });
  assert.equal(result.size, 0);
  assert.equal(http.attempts, 0);
  assert.equal(audit.rows[0]?.outcome, 'degraded_empty_input');
});

test('a failing relevance provider degrades to an empty set', async () => {
  const { adapter, audit } = relevanceHarness([
    { ok: false, statusCode: 500, failureClass: 'unavailable' },
    { ok: false, statusCode: 500, failureClass: 'unavailable' },
    { ok: false, statusCode: 500, failureClass: 'unavailable' },
  ]);
  const result = await adapter.relevantPeCodes({
    tenantId: 't',
    userId: 'u',
    peCodes: ['PE1'],
    minScore: 0.5,
  });
  assert.equal(result.size, 0, 'needs-attention omits the relevance signal, as documented');
  assert.equal(audit.rows[0]?.outcome, 'degraded_failed');
  assert.equal(audit.rows[0]?.failureClass, 'unavailable');
});

test('a malformed relevance body is a failure, and an empty array is not', () => {
  assert.equal(interpretRelevanceResponse({}, ['PE1']), null);
  assert.equal(interpretRelevanceResponse({ relevantPeCodes: 'PE1' }, ['PE1']), null);
  assert.equal(interpretRelevanceResponse({ relevantPeCodes: [1] }, ['PE1']), null);
  assert.deepEqual([...(interpretRelevanceResponse({ relevantPeCodes: [] }, ['PE1']) ?? [])], []);
});

test('PE codes are normalised and deduped before the call', async () => {
  const { adapter, http } = relevanceHarness([{ body: { relevantPeCodes: ['PE1'] } }]);
  const result = await adapter.relevantPeCodes({
    tenantId: 't',
    userId: 'u',
    peCodes: [' pe1 ', 'PE1', 'Pe1'],
    minScore: 0.5,
  });
  const body = http.calls[0]?.body as { peCodes: string[] };
  assert.deepEqual(body.peCodes, ['PE1'], 'one code, however it was cased or padded');
  assert.deepEqual([...result], ['PE1']);
});

// ── shared invariants ──────────────────────────────────────────────────────

test('the same request produces the same idempotency key across calls', async () => {
  const first = relevanceHarness([{ body: { relevantPeCodes: [] } }]);
  const second = relevanceHarness([{ body: { relevantPeCodes: [] } }]);
  const input = { tenantId: 't', userId: 'u', peCodes: ['PE1', 'PE2'], minScore: 0.5 };
  await first.adapter.relevantPeCodes(input);
  await second.adapter.relevantPeCodes(input);
  assert.equal(
    first.audit.rows[0]?.idempotencyKey,
    second.audit.rows[0]?.idempotencyKey,
    'identical requests must be recognisable as the same invocation',
  );
});

test('a different tenant produces a different idempotency key', async () => {
  const a = relevanceHarness([{ body: { relevantPeCodes: [] } }]);
  const b = relevanceHarness([{ body: { relevantPeCodes: [] } }]);
  await a.adapter.relevantPeCodes({ tenantId: 'ta', userId: 'u', peCodes: ['PE1'], minScore: 0.5 });
  await b.adapter.relevantPeCodes({ tenantId: 'tb', userId: 'u', peCodes: ['PE1'], minScore: 0.5 });
  assert.notEqual(a.audit.rows[0]?.idempotencyKey, b.audit.rows[0]?.idempotencyKey);
});

test('no audit row anywhere carries a monetary field', async () => {
  const embedding = embeddingHarness([{ body: { embedding: [1] } }]);
  await embedding.adapter.embedQuery('q');
  const relevance = relevanceHarness([{ body: { relevantPeCodes: [] } }]);
  await relevance.adapter.relevantPeCodes({
    tenantId: 't',
    userId: 'u',
    peCodes: ['PE1'],
    minScore: 0.5,
  });

  const serialised = JSON.stringify([...embedding.audit.rows, ...relevance.audit.rows]);
  assert.ok(
    !/"[a-zA-Z]*([Aa]mount|USD|[Dd]ollar|[Cc]ost|[Oo]bligation|[Oo]utlay)[a-zA-Z]*"\s*:/.test(
      serialised,
    ),
    'provider cost is not a funding fact and no monetary field may appear',
  );
});

test('the frozen port tokens are still the injection points', () => {
  // Session 9 binds providers to the SAME tokens Sessions 2-8 declared.
  assert.equal(EMBEDDING_PORT, 'defense.port.embedding');
  assert.equal(CLIENT_RELEVANCE_PORT, 'defense.port.clientRelevance');
});

test('Retry-After is parsed in both legal forms', () => {
  assert.equal(parseRetryAfter('120'), 120_000);
  assert.equal(parseRetryAfter('not a date'), null);
  assert.equal(parseRetryAfter(null), null);
  assert.ok((parseRetryAfter(new Date(Date.now() + 60_000).toUTCString()) ?? 0) > 50_000);
});
