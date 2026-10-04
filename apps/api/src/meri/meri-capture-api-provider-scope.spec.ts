import { captureProviderBudgetOwner } from './meri-capture-provider-budget-owner.js';
import { BedrockRuntimeClient, type InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import {
  assertCaptureApiRetrievalPlan,
  captureApiProviderScopeActive,
  withCaptureApiProviderScope,
} from './meri-capture-api-provider-scope.js';
import { MeriContextPlaneRuntimeService } from './meri-context-plane-runtime.js';
import { planMeriTurn } from './meri-context-plane.service.js';
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

test('capture rejects unreviewed Titan region before reservation and keeps ordinary region configuration', async () => {
  const invoker = jest.fn(async () => ({
    body: Buffer.from(JSON.stringify({ embedding: [1, 0], inputTextTokenCount: 2 })),
  }));
  const provider = new TitanEmbeddingProvider({ region: 'eu-west-1', dimensions: 2, invoker });
  await expect(run(() => provider.embed('unit'))).rejects.toThrow('meri_capture_provider_wire');
  expect(owner).not.toHaveBeenCalled();
  expect(invoker).not.toHaveBeenCalled();
  await expect(provider.embed('unit')).resolves.toEqual([1, 0]);
  expect(invoker).toHaveBeenCalledTimes(1);
});

test.each([
  'http://ai.api.nvidia.com/v1/retrieval/nvidia/unit/reranking',
  'https://proxy.invalid/v1/ranking',
  'https://ai.api.nvidia.com/v1/retrieval/nvidia/unit/reranking?paid=1',
])(
  'capture rejects unreviewed NVIDIA endpoint %s before reservation, ordinary remains configurable',
  async (endpointUrl) => {
    const fetchImpl = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            rankings: [{ index: 0, logit: 1 }],
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
          { status: 200 },
        ),
    );
    const provider = new NvidiaRerankingProvider({ endpointUrl, model: 'nvidia/unit', fetchImpl });
    await expect(run(() => provider.rerank({ query: 'unit', passages: ['unit'] }))).rejects.toThrow(
      'meri_capture_provider_wire',
    );
    expect(owner).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    await provider.rerank({ query: 'unit', passages: ['unit'] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  },
);

test('capture Titan SDK has fixed regional endpoint and one attempt; NVIDIA cannot redirect', async () => {
  const send = jest
    .spyOn(BedrockRuntimeClient.prototype, 'send')
    .mockImplementation(async () => ({
      body: Buffer.from(JSON.stringify({ embedding: [1, 0], inputTextTokenCount: 2 })),
    }));
  try {
    const provider = new TitanEmbeddingProvider({ region: 'us-east-1', dimensions: 2 });
    await run(() => provider.embed('unit'));
    const sdk = (provider as unknown as { captureBedrock: BedrockRuntimeClient }).captureBedrock;
    expect(await sdk.config.region()).toBe('us-east-1');
    expect(await sdk.config.maxAttempts()).toBe(1);
    expect(await sdk.config.endpoint!()).toMatchObject({
      protocol: 'https:',
      hostname: 'bedrock-runtime.us-east-1.amazonaws.com',
    });
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    send.mockRestore();
  }
  const fetchImpl = jest.fn(
    async (..._args: Parameters<typeof fetch>) =>
      new Response(
        JSON.stringify({
          rankings: [{ index: 0, logit: 1 }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
        { status: 200 },
      ),
  );
  const provider = new NvidiaRerankingProvider({ fetchImpl });
  await run(() => provider.rerank({ query: 'unit', passages: ['unit'] }));
  expect(fetchImpl.mock.calls[0]![1]!.redirect).toBe('error');
});
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
test.each(['20', '72'])(
  'case %s admits only the existing selected-client analysis context plan',
  async (caseId) => {
    await withCaptureApiProviderScope({} as never, ctx, { ...policy, caseId }, async () => {
      const task =
        caseId === '20'
          ? 'Find PE 0912345T and give me its FY27 request.'
          : 'Read Aster’s latest memo.';
      const nativePlan = planMeriTurn({
        task,
        uiClientId: '33333333-3333-4333-8333-333333333333',
        uiClientName: 'Aster Defense',
      });
      expect(nativePlan.subjectScope).toBe('client');
      expect(nativePlan.requestedDomains).toEqual([
        'clients',
        'contacts',
        'strategies_work',
        'institutional_knowledge',
      ]);
      expect(() => assertCaptureApiRetrievalPlan(nativePlan)).not.toThrow();
      for (const requestedDomains of [
        ['mail'],
        ['institutional_knowledge'],
        ['contacts', 'contacts', 'institutional_knowledge'],
        ['contacts', 'strategies_work', 'mail'],
      ])
        expect(() =>
          assertCaptureApiRetrievalPlan({ subjectScope: 'client', requestedDomains }),
        ).toThrow('unqualified');
      expect(() =>
        assertCaptureApiRetrievalPlan({
          subjectScope: 'general',
          requestedDomains: ['contacts', 'strategies_work', 'institutional_knowledge'],
        }),
      ).toThrow('unqualified');
    });
  },
);
test('case74 cannot reuse controlled-read provider ingress', async () => {
  await withCaptureApiProviderScope({} as never, ctx, { ...policy, caseId: '74' }, async () => {
    expect(() =>
      assertCaptureApiRetrievalPlan({
        subjectScope: 'client',
        requestedDomains: ['contacts', 'strategies_work', 'institutional_knowledge'],
      }),
    ).toThrow('unqualified');
  });
});
test('case12 retrospective approval recall naturally plans selected authorized client memory only', async () => {
  await withCaptureApiProviderScope({} as never, ctx, { ...policy, caseId: '12' }, async () => {
    const base = {
      uiClientId: '33333333-3333-4333-8333-333333333333',
      uiClientName: 'Aster Defense',
      authorizedClientNames: ['Aster Defense', 'Bluehaven Robotics'],
    };
    const positivePrompts = [
      'What did we approve about Aster Defense’s autonomous maritime demo?',
      "What did we approve about Aster Defense's autonomous maritime demo?",
      'What did we approve about Aster’s autonomous maritime demo?',
      "What did we approve about Aster's autonomous maritime demo?",
    ];
    for (const task of positivePrompts) {
      const nativePlan = planMeriTurn({ ...base, task });
      expect(nativePlan).toMatchObject({
        subjectScope: 'client',
        targetHint: null,
        queryClass: 'semantic_recall',
        requestedDomains: ['institutional_knowledge'],
      });
      expect(() => assertCaptureApiRetrievalPlan(nativePlan)).not.toThrow();
    }

    // Exercise the exact preserved wording through the ordinary native planner.
    const originalNativePlan = planMeriTurn({
      ...base,
      task: 'What did we approve about Aster’s autonomous maritime demo?',
    });
    expect(originalNativePlan.requestedDomains).toEqual(['institutional_knowledge']);

    const notMemoryOnly = (task: string, overrides: Record<string, unknown> = {}) =>
      planMeriTurn({ ...base, ...overrides, task } as Parameters<typeof planMeriTurn>[0]);
    for (const task of [
      'What did we approve about Bluehaven’s autonomous maritime demo?',
      'What did we approve about Aster’s autonomous maritime demo and Bluehaven’s demo?',
      'What did we approve about Aster’s autonomous maritime demo, but not its payload?',
      'What did we approve about Aster’s autonomous maritime demo? Check the launch date.',
      'What did we approve about Aster’s autonomous maritime demo in the email?',
      'What did we approve about Aster’s autonomous maritime demo in the document?',
      'Approve Aster’s autonomous maritime demo.',
    ])
      expect(notMemoryOnly(task).requestedDomains).not.toEqual(['institutional_knowledge']);

    expect(notMemoryOnly('What did we approve about Aster’s autonomous maritime demo?', {
      authorizedClientNames: ['Aster Defense', 'Aster Maritime', 'Bluehaven Robotics'],
    }).requestedDomains).not.toEqual(['institutional_knowledge']);
    expect(notMemoryOnly('What did we approve about Aster’s autonomous maritime demo?', {
      authorizedClientNames: ['Bluehaven Robotics'],
    }).requestedDomains).not.toEqual(['institutional_knowledge']);
    expect(notMemoryOnly('What did we approve about Aster’s autonomous maritime demo?', {
      uiClientId: '44444444-4444-4444-8444-444444444444',
      uiClientName: 'Bluehaven Robotics',
    }).requestedDomains).not.toEqual(['institutional_knowledge']);
    expect(notMemoryOnly('What did we approve about Aster’s autonomous maritime demo?', {
      uiClientId: null,
      uiClientName: null,
    }).requestedDomains).not.toEqual(['institutional_knowledge']);
    expect(notMemoryOnly('What did we approve about Aster Maritime’s autonomous maritime demo?').requestedDomains)
      .not.toEqual(['institutional_knowledge']);
    expect(notMemoryOnly('What did we approve about Aster’s autonomous maritime demo in the email?').requestedDomains)
      .toContain('mail');
  });
});

test('case14 next-turn recall uses the real memory-only plan and cannot admit approval or mail retrieval', async () => {
  await withCaptureApiProviderScope({} as never, ctx, { ...policy, caseId: '14' }, async () => {
    const nativePlan = planMeriTurn({
      task: 'What is the recently approved Aster memory? Cite its source.',
      uiClientId: '33333333-3333-4333-8333-333333333333',
      uiClientName: 'Aster Defense',
    });
    expect(nativePlan.subjectScope).toBe('client');
    expect(nativePlan.requestedDomains).toEqual(['institutional_knowledge']);
    expect(() => assertCaptureApiRetrievalPlan(nativePlan)).not.toThrow();
    expect(() =>
      assertCaptureApiRetrievalPlan({ subjectScope: 'client', requestedDomains: ['mail'] }),
    ).toThrow('unqualified');
  });
});
test('original case01 briefing preference prompt stays on its selected client memory rail', async () => {
  const nativePlan = planMeriTurn({
    task: 'What do we know about Aster’s briefing preferences?',
    uiClientId: '33333333-3333-4333-8333-333333333333',
    uiClientName: 'Aster Defense',
    authorizedClientNames: ['Aster Defense', 'Bluehaven Robotics'],
  });
  expect(nativePlan).toMatchObject({
    subjectScope: 'client',
    targetHint: null,
    requestedDomains: ['institutional_knowledge'],
  });
  await run(async () => expect(() => assertCaptureApiRetrievalPlan(nativePlan)).not.toThrow());
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
