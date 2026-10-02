import { captureProviderBudgetOwner } from './meri-capture-provider-budget-owner.js';
import type { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import {
  assertCaptureApiRetrievalPlan,
  captureApiProviderScopeActive,
  withCaptureApiProviderScope,
} from './meri-capture-api-provider-scope.js';
import { MeriContextPlaneRuntimeService } from './meri-context-plane-runtime.js';
import {
  captureBudgetTestContext as ctx,
  captureBudgetTestPolicy,
} from './meri-capture-provider-budget.spec-helper.js';
import { TitanEmbeddingProvider } from '../embeddings/titan-embedding.provider.js';
import { NvidiaRerankingProvider } from '../reranking/nvidia-reranking.provider.js';
jest.mock('./meri-capture-provider-budget-owner.js', () => ({
  captureProviderBudgetOwner: jest.fn(),
}));
const owner = jest.mocked(captureProviderBudgetOwner);
const policy = captureBudgetTestPolicy();
const run = (fn: () => Promise<unknown>) =>
  withCaptureApiProviderScope({} as never, ctx, policy, fn);
beforeEach(() => {
  owner.mockReset();
  owner.mockImplementation(async ({ operation }) => {
    if (operation.kind === 'reserve')
      return {
        state: {} as never,
        metadata: {},
        reservationId: 'test-reservation',
        dispatchAllowed: true,
        deadlineAt: new Date(policy.expiresAt).toISOString(),
      };
    return { state: {} as never, metadata: {} };
  });
});
test('rejects non-memory or unscoped plans only inside armed capture', async () => {
  expect(() =>
    assertCaptureApiRetrievalPlan({ subjectScope: 'general', requestedDomains: ['mail'] }),
  ).not.toThrow();
  await run(async () => {
    expect(() =>
      assertCaptureApiRetrievalPlan({
        subjectScope: 'client',
        requestedDomains: ['institutional_knowledge'],
      }),
    ).not.toThrow();
    expect(() =>
      assertCaptureApiRetrievalPlan({ subjectScope: 'client', requestedDomains: ['mail'] }),
    ).toThrow('unqualified');
    expect(() =>
      assertCaptureApiRetrievalPlan({
        subjectScope: 'general',
        requestedDomains: ['institutional_knowledge'],
      }),
    ).toThrow('unqualified');
  });
});
test('real chat runtime admits before activating scope around context resolution', async () => {
  const downstream = jest.fn();
  const contextPlane = {
    resolveChat: jest.fn(async () => {
      expect(owner.mock.calls[0]?.[0].operation).toEqual({ kind: 'admit' });
      expect(captureApiProviderScopeActive()).toBe(true);
      assertCaptureApiRetrievalPlan({ subjectScope: 'client', requestedDomains: ['mail'] });
      return {};
    }),
  };
  const runtime = new MeriContextPlaneRuntimeService({} as never, contextPlane as never);
  // Isolate the runtime ordering from already-tested current-authority database reads.
  jest
    .spyOn(runtime as unknown as { prepareTurn: () => Promise<unknown> }, 'prepareTurn')
    .mockResolvedValue({
      task: 'synthetic memory',
      client: { id: policy.clientId, name: 'synthetic' },
      capturePolicy: { ...policy, turnId: null },
    });
  await expect(
    runtime.runChatTurn(
      ctx,
      {
        conversationId: policy.conversationId,
        body: 'synthetic memory',
        mode: 'new',
      },
      downstream,
    ),
  ).rejects.toThrow('unqualified_retrieval_plan');
  expect(contextPlane.resolveChat).toHaveBeenCalledTimes(1);
  expect(downstream).not.toHaveBeenCalled();
  expect(captureApiProviderScopeActive()).toBe(false);
});
test('Titan cannot dispatch after failed reservation and reports actual usage when admitted', async () => {
  const invoke = jest.fn(async (_command: InvokeModelCommand) => ({
    body: Buffer.from(JSON.stringify({ embedding: [1, 0], inputTextTokenCount: 7 })),
  }));
  const provider = new TitanEmbeddingProvider({
    model: 'test-model',
    dimensions: 2,
    invoker: invoke,
  });
  owner.mockRejectedValueOnce(new Error('reservation denied'));
  await expect(run(() => provider.embed('synthetic'))).rejects.toThrow('reservation denied');
  expect(invoke).not.toHaveBeenCalled();
  await expect(run(() => provider.embed('synthetic'))).resolves.toEqual([1, 0]);
  const actualCommand = invoke.mock.calls[0]![0];
  expect(typeof actualCommand.input.body).toBe('string');
  expect(owner.mock.calls[1]?.[0].operation).toMatchObject({
    kind: 'reserve',
    binding: { maxInputTokens: Buffer.byteLength(actualCommand.input.body as string, 'utf8') },
  });
  const operations = owner.mock.calls.map(([arg]) => arg.operation);
  expect(operations.at(-1)).toMatchObject({
    kind: 'settle',
    input: { outcome: { kind: 'known', inputTokens: 7, outputTokens: 0 } },
  });
});
test('missing Titan usage and failed NVIDIA response remain charged as uncertain', async () => {
  const embedding = new TitanEmbeddingProvider({
    model: 'test-model',
    dimensions: 2,
    invoker: async () => ({ body: Buffer.from(JSON.stringify({ embedding: [1, 0] })) }),
  });
  await run(() => embedding.embed('synthetic'));
  expect(owner.mock.calls.at(-1)?.[0].operation).toMatchObject({
    kind: 'settle',
    input: { outcome: { kind: 'uncertain' } },
  });
  const fetchImpl = jest.fn(async () => new Response('{}', { status: 429 }));
  const reranker = new NvidiaRerankingProvider({ fetchImpl });
  await expect(
    run(() => reranker.rerank({ query: 'synthetic', passages: ['one', 'two'] })),
  ).rejects.toThrow('status=429');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(owner.mock.calls.at(-1)?.[0].operation).toMatchObject({
    kind: 'settle',
    input: { outcome: { kind: 'uncertain' } },
  });
});
test('NVIDIA reservation uses actual configured model and precedes its HTTP call', async () => {
  let callsAtDispatch = 0;
  const fetchImpl = jest.fn(async () => {
    callsAtDispatch = owner.mock.calls.length;
    return new Response(
      JSON.stringify({
        rankings: [{ index: 0, logit: 1 }],
        usage: { prompt_tokens: 4, total_tokens: 4 },
      }),
      { status: 200 },
    );
  });
  const reranker = new NvidiaRerankingProvider({ model: 'actual-test-model', fetchImpl });
  await run(() => reranker.rerank({ query: 'synthetic', passages: ['one'] }));
  expect(callsAtDispatch).toBe(1);
  expect(owner.mock.calls[0]?.[0].operation).toMatchObject({
    kind: 'reserve',
    binding: {
      kind: 'nvidia_rerank',
      provider: 'nvidia-nim',
      model: 'actual-test-model',
      maxOutputTokens: 0,
    },
  });
  expect(owner.mock.calls.at(-1)?.[0].operation).toMatchObject({
    kind: 'settle',
    input: { outcome: { kind: 'known', inputTokens: 4, outputTokens: 0 } },
  });
});
test('NVIDIA reserves repeated query encoding for every scored passage', async () => {
  const fetchImpl = jest.fn(
    async (..._args: Parameters<typeof fetch>) =>
      new Response(
        JSON.stringify({
          rankings: [
            { index: 0, logit: 1 },
            { index: 1, logit: 0 },
          ],
          usage: { prompt_tokens: 6, total_tokens: 6 },
        }),
        { status: 200 },
      ),
  );
  const reranker = new NvidiaRerankingProvider({ model: 'actual-test-model', fetchImpl });
  const passages = ['one', 'two'];
  await run(() => reranker.rerank({ query: 'a query encoded for every passage', passages }));
  const body = fetchImpl.mock.calls[0]![1]!.body as string;
  expect(owner.mock.calls[0]?.[0].operation).toMatchObject({
    kind: 'reserve',
    binding: { maxInputTokens: Buffer.byteLength(body, 'utf8') * passages.length },
  });
});
