import { AsyncLocalStorage } from 'node:async_hooks';
import type { MeriServerReadonlyCapturePolicy } from '@capiro/meriv2-core';
import {
  createMeriApiCaptureObservations,
  readMeriApiCaptureObservations,
} from './meri-api-capture-observations.js';
import { buildApiOnlyMeriServerCaptureEvidence } from './meri-server-capture-evidence.js';
import { meriReadonlyCaptureCatalogSha256 } from './meri-server-readonly-capture.js';

function policy(id = 'one'): MeriServerReadonlyCapturePolicy {
  return {
    version: 1,
    kind: 'server_readonly_acceptance_capture',
    policyId: `policy-${id}`,
    requestId: `request-${id}`,
    traceId: `trace-${id}`,
    turnId: `turn-${id}`,
    caseId: '01',
    captureRunId: `run-${id}`,
    fixtureVersion: 'v1',
    physicalMapSha256: 'd'.repeat(64),
    resetReceiptId: 'reset',
    seedReceiptId: 'seed',
    fixtureNamespace: 'meri-foundation-20260928',
    tenantId: 'tenant',
    tenantSlug: 'meri-foundation-20260928-t1',
    actorUserId: 'actor',
    conversationId: `conversation-${id}`,
    clientId: null,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60000,
    toolAuthority: 'shared_static_registry_read_only',
    toolCatalogSha256: meriReadonlyCaptureCatalogSha256(),
    dynamicMcpAllowed: false,
    incidentalWriters: 'suppressed',
    expectedCaptureWrites: [
      'context_packet_and_evidence',
      'conversation_user_message',
      'conversation_assistant_message',
    ],
  };
}
function start(model = 'actual-model', input = 10, output = 1) {
  return {
    type: 'message_start',
    message: {
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 0,
      },
    },
  };
}

describe('request-owned API capture observations', () => {
  it('captures provider-reported model, cumulative per-round usage and actual tool attempt/source IDs', () => {
    const p = policy();
    const observations = createMeriApiCaptureObservations(p, () => p);
    const first = observations.startAnthropicRequest();
    first(start());
    first({ type: 'message_delta', usage: { output_tokens: 3 } });
    first({ type: 'message_delta', usage: { output_tokens: 7 } });
    first({ type: 'message_stop' });
    const second = observations.startAnthropicRequest();
    second(start('actual-model', 20, 2));
    second({ type: 'message_stop' });
    observations.recordTool({
      callId: 'provider-tool-17',
      name: 'search_public_web',
      denied: false,
      sourceIds: ['source-9'],
      outcome: {
        index: 0,
        ok: true,
        result: { results: [] },
        timedOut: false,
        latencyMs: 1,
        attempts: 2,
      },
    });
    const result = buildApiOnlyMeriServerCaptureEvidence({
      policy: p,
      observations,
      userMessageId: p.turnId!,
      assistantMessageId: 'assistant',
      citations: [{ id: 'source-9' }],
      usage: { inputTokens: 999, outputTokens: 999 },
      secret: 'local-test-secret',
    }).receipt;
    expect(result.usage).toMatchObject({
      provider: { value: 'anthropic' },
      model: { value: 'actual-model' },
      inputTokens: { value: 30 },
      outputTokens: { value: 9 },
      cacheReadTokens: { value: 4 },
      cacheCreationTokens: { value: 0 },
      estimatedCostUsd: { status: 'NOT_RUN', value: null },
    });
    expect(result.toolCalls).toEqual([
      {
        callId: 'provider-tool-17',
        name: 'search_public_web',
        attempt: 2,
        status: 'partial',
        readOnly: true,
        sourceIds: ['source-9'],
      },
    ]);
    expect(result.sources[0]?.toolCallId).toBe('provider-tool-17');
    expect(result.releases.orchestrator.releaseRevision.status).toBe('NOT_RUN');
    expect(result.status).toBe('BLOCKED');
  });

  it('leaves absent provider work NOT_RUN and absent model/usage UNKNOWN after an actual request', () => {
    const p = policy();
    const observations = createMeriApiCaptureObservations(p, () => p);
    expect(readMeriApiCaptureObservations(observations, p).usage.inputTokens.status).toBe(
      'NOT_RUN',
    );
    observations.startAnthropicRequest()({ type: 'content_block_delta' });
    const usage = readMeriApiCaptureObservations(observations, p).usage;
    expect(usage.provider.value).toBe('anthropic');
    expect(usage.model).toMatchObject({ status: 'UNKNOWN', value: null });
    expect(usage.inputTokens).toMatchObject({ status: 'UNKNOWN', value: null });
    expect(usage.cacheReadTokens.value).toBeNull();
  });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid usage %s without converting it to observed zero',
    (value) => {
      const p = policy();
      const observations = createMeriApiCaptureObservations(p, () => p);
      const observe = observations.startAnthropicRequest();
      observe(start('actual-model', value));
      expect(readMeriApiCaptureObservations(observations, p).usage.inputTokens.status).toBe(
        'UNKNOWN',
      );
    },
  );

  it('does not add partial reporting into a falsely complete aggregate', () => {
    const p = policy();
    const observations = createMeriApiCaptureObservations(p, () => p);
    observations.startAnthropicRequest()(start());
    observations.startAnthropicRequest()({
      type: 'message_start',
      message: { model: 'other-model', usage: { input_tokens: 5 } },
    });
    const usage = readMeriApiCaptureObservations(observations, p).usage;
    expect(usage.inputTokens.value).toBe(15);
    expect(usage.outputTokens.status).toBe('UNKNOWN');
    expect(usage.cacheReadTokens.status).toBe('UNKNOWN');
    expect(usage.model.status).toBe('UNKNOWN');
  });

  it('keeps output totals unknown after a truncated stream and rejects usage after its stop', () => {
    const p = policy();
    const observations = createMeriApiCaptureObservations(p, () => p);
    const observe = observations.startAnthropicRequest();
    observe(start());
    observe({ type: 'message_delta', usage: { output_tokens: 7 } });
    expect(readMeriApiCaptureObservations(observations, p).usage).toMatchObject({
      inputTokens: { value: 10 },
      outputTokens: { status: 'UNKNOWN', value: null },
    });
    observe({ type: 'message_stop' });
    expect(readMeriApiCaptureObservations(observations, p).usage.outputTokens.value).toBe(7);
    observe({ type: 'message_delta', usage: { output_tokens: 8 } });
    expect(readMeriApiCaptureObservations(observations, p).usage.outputTokens.status).toBe('UNKNOWN');
  });

  it.each([
    'policyId',
    'requestId',
    'traceId',
    'turnId',
    'caseId',
    'captureRunId',
    'conversationId',
    'tenantId',
    'actorUserId',
    'clientId',
    'fixtureVersion',
  ] as const)('rejects rebound %s at snapshot and at late observation', (key) => {
    const p = policy();
    let current = p;
    const observations = createMeriApiCaptureObservations(p, () => current);
    const observe = observations.startAnthropicRequest();
    current = { ...p, [key]: 'different' };
    expect(() => readMeriApiCaptureObservations(observations, current)).toThrow('binding_mismatch');
    expect(() => readMeriApiCaptureObservations(observations, p)).toThrow('binding_mismatch');
    expect(() => observe(start())).toThrow('binding_mismatch');
  });

  it('rejects expired policy, duplicate tool IDs, missing owner and fabricated collector handles', () => {
    expect(() =>
      createMeriApiCaptureObservations({ ...policy(), expiresAt: 1 }, () => policy()),
    ).toThrow();
    const p = policy();
    const observations = createMeriApiCaptureObservations(p, () => p);
    const call = {
      callId: 'real-id',
      name: 'search_public_web',
      denied: true,
      sourceIds: [],
      outcome: {
        index: 0,
        ok: true,
        result: { ok: false },
        timedOut: false,
        latencyMs: 0,
        attempts: 1,
      },
    };
    observations.recordTool(call);
    expect(readMeriApiCaptureObservations(observations, p).toolCalls[0]?.status).toBe('denied');
    expect(() => observations.recordTool(call)).toThrow('tool_observation_invalid');
    expect(() => observations.recordTool({ ...call, callId: '', name: 'unknown-tool' })).toThrow();
    expect(() => readMeriApiCaptureObservations({ ...observations }, p)).toThrow('owner_missing');
  });

  it('isolates concurrent requests and rejects using another request collector in the current context', async () => {
    const runtime = new AsyncLocalStorage<MeriServerReadonlyCapturePolicy>();
    const current = () => runtime.getStore() ?? null;
    const one = policy('one');
    const two = policy('two');
    const a = await runtime.run(one, async () => {
      const collector = createMeriApiCaptureObservations(one, current);
      await Promise.resolve();
      collector.startAnthropicRequest()(start('model-one'));
      return collector;
    });
    const [resultA, resultB] = await Promise.all([
      runtime.run(one, async () => {
        await Promise.resolve();
        return readMeriApiCaptureObservations(a, one);
      }),
      runtime.run(two, async () => {
        const b = createMeriApiCaptureObservations(two, current);
        await Promise.resolve();
        b.startAnthropicRequest()(start('model-two', 25));
        expect(() => readMeriApiCaptureObservations(a, one)).toThrow('binding_mismatch');
        return readMeriApiCaptureObservations(b, two);
      }),
    ]);
    expect(resultA.usage.model.value).toBe('model-one');
    expect(resultB.usage.model.value).toBe('model-two');
    expect(resultA.usage.inputTokens.value).toBe(10);
    expect(resultB.usage.inputTokens.value).toBe(25);
  });
});
