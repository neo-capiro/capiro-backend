import { randomUUID } from 'node:crypto';
import { TitanEmbeddingProvider } from '../embeddings/titan-embedding.provider.js';
import { MemoryCandidateService } from '../memory/memory-candidate.service.js';
import {
  withCase12SetupProviderScope,
  reserveCase12SetupProviderAttempt,
  settleCase12SetupProviderAttempt,
  type Case12SetupProviderOwner,
} from './meri-case12-setup-provider-scope.js';
import {
  withCaptureApiProviderScope,
  reserveCaptureApiProviderAttempt,
} from './meri-capture-api-provider-scope.js';

const titanVector = Array(1024).fill(0.25),
  openaiVector = Array(1536).fill(0.5);
function owner(): jest.Mocked<Case12SetupProviderOwner> {
  return {
    reserve: jest.fn<
      ReturnType<Case12SetupProviderOwner['reserve']>,
      Parameters<Case12SetupProviderOwner['reserve']>
    >(async () => ({ reservationId: randomUUID() })),
    settle: jest.fn<
      ReturnType<Case12SetupProviderOwner['settle']>,
      Parameters<Case12SetupProviderOwner['settle']>
    >(async () => undefined),
  };
}
function service(titan?: TitanEmbeddingProvider) {
  const write = jest.fn(async () => 1),
    outbox = { markIndexedOnFastPath: jest.fn(async () => undefined) };
  const memory = new MemoryCandidateService(
    { withTenant: async (_t: any, fn: any) => fn({ $executeRawUnsafe: write }) } as any,
    { projectClioMemory: async () => titan?.embed('canonical projection text') } as any,
    { get: () => 'test-not-a-secret' } as any,
    {} as any,
    outbox as any,
    {} as any,
  );
  return { memory: memory as any, write, outbox };
}
const payload = {
  kind: 'openai_embeddings' as const,
  provider: 'openai',
  model: 'text-embedding-3-small',
  endpoint: 'https://api.openai.com/v1/embeddings',
  body: 'body',
};
afterEach(() => jest.restoreAllMocks());

it('consumes a settlement capability before the owner awaits, excluding concurrent replay', async () => {
  const budget = owner();
  let release!: () => void;
  budget.settle.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await withCase12SetupProviderScope(budget, async () => {
    const cap = await reserveCase12SetupProviderAttempt(payload);
    const first = settleCase12SetupProviderAttempt(cap, {
      kind: 'known',
      inputTokens: 1,
      outputTokens: 0,
    });
    await expect(
      settleCase12SetupProviderAttempt(cap, { kind: 'known', inputTokens: 1, outputTokens: 0 }),
    ).rejects.toThrow('reservation_invalid');
    expect(budget.settle).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});

it('does not return a newly reserved wire capability after sibling uncertainty', async () => {
  const budget = owner();
  let release!: (value: { reservationId: string }) => void;
  await expect(
    withCase12SetupProviderScope(budget, async () => {
      const first = await reserveCase12SetupProviderAttempt(payload);
      budget.reserve.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const sibling = reserveCase12SetupProviderAttempt({ ...payload, kind: 'bedrock_embeddings' });
      await expect(settleCase12SetupProviderAttempt(first, { kind: 'uncertain' })).rejects.toThrow(
        'usage_uncertain',
      );
      release({ reservationId: randomUUID() });
      await expect(sibling).rejects.toThrow('reservation_unavailable');
    }),
  ).rejects.toThrow('reconciliation_required');
});

it('runs both actual wire methods with durable reservation first and outbox last', async () => {
  const budget = owner(),
    ordering: string[] = [];
  budget.reserve.mockImplementation(async (input: any) => {
    ordering.push(`reserve:${input.kind}`);
    return { reservationId: input.kind };
  });
  budget.settle.mockImplementation(async (id: any) => {
    ordering.push(`settle:${id}`);
  });
  const invoker = jest.fn(async () => {
    expect(ordering).toContain('reserve:bedrock_embeddings');
    ordering.push('titan');
    return {
      body: Buffer.from(JSON.stringify({ embedding: titanVector, inputTextTokenCount: 4 })),
    };
  });
  const titan = new TitanEmbeddingProvider({ invoker }),
    { memory, write, outbox } = service(titan);
  const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    expect(ordering).toContain('reserve:openai_embeddings');
    ordering.push('openai');
    expect(options?.redirect).toBe('error');
    expect(options?.signal).toBeDefined();
    return {
      ok: true,
      json: async () => ({
        data: [{ embedding: openaiVector }],
        usage: { prompt_tokens: 7, total_tokens: 7 },
      }),
    } as Response;
  });
  await withCase12SetupProviderScope(budget, () =>
    memory.dispatchProjectionFastPath('tenant', 'clio', { key: 'key', value: 'value' }, true),
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(invoker).toHaveBeenCalledTimes(1);
  expect(budget.reserve.mock.calls).toHaveLength(2);
  expect(budget.settle.mock.calls).toHaveLength(2);
  expect(write).toHaveBeenCalledTimes(1);
  expect(outbox.markIndexedOnFastPath).toHaveBeenCalledTimes(1);
});
it('refused reservation invokes neither transport nor vector write', async () => {
  const budget = owner();
  budget.reserve.mockRejectedValue(new Error('denied'));
  const fetch = jest.spyOn(globalThis, 'fetch'),
    invoker = jest.fn(),
    { memory, write } = service();
  await expect(
    withCase12SetupProviderScope(budget, () =>
      memory.embedMemory('tenant', 'clio', 'key', 'value', true),
    ),
  ).rejects.toThrow('denied');
  await expect(
    withCase12SetupProviderScope(budget, () =>
      new TitanEmbeddingProvider({ invoker }).embed('text'),
    ),
  ).rejects.toThrow('denied');
  expect(fetch).not.toHaveBeenCalled();
  expect(invoker).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});
it.each(['http', 'transport', 'malformed', 'missing_usage', 'invalid_usage', 'invalid_vector'])(
  'retains uncertain OpenAI %s and stops output',
  async (mode) => {
    const budget = owner(),
      { memory, write } = service();
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (mode === 'transport') throw new Error('transport');
      return {
        ok: mode !== 'http',
        json: async () => {
          if (mode === 'malformed') throw new Error('malformed');
          return {
            data: [{ embedding: mode === 'invalid_vector' ? [1] : openaiVector }],
            ...(mode === 'missing_usage'
              ? {}
              : { usage: { prompt_tokens: mode === 'invalid_usage' ? -1 : 5, total_tokens: 5 } }),
          };
        },
      } as Response;
    });
    await expect(
      withCase12SetupProviderScope(budget, () =>
        memory.embedMemory('tenant', 'clio', 'key', 'value', true),
      ),
    ).rejects.toThrow('usage_uncertain');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(budget.settle).toHaveBeenCalledWith(expect.any(String), { kind: 'uncertain' });
    expect(write).not.toHaveBeenCalled();
  },
);
it.each(['transport', 'malformed', 'missing_usage', 'invalid_vector'])(
  'retains uncertain Titan %s without retry',
  async (mode) => {
    const budget = owner(),
      invoker = jest.fn(async () => {
        if (mode === 'transport') throw new Error('transport');
        return {
          body:
            mode === 'malformed'
              ? Buffer.from('{')
              : Buffer.from(
                  JSON.stringify({
                    embedding: mode === 'invalid_vector' ? [1] : titanVector,
                    ...(mode === 'missing_usage' ? {} : { inputTextTokenCount: 5 }),
                  }),
                ),
        };
      });
    await expect(
      withCase12SetupProviderScope(budget, () =>
        new TitanEmbeddingProvider({ invoker }).embed('text'),
      ),
    ).rejects.toThrow('usage_uncertain');
    expect(invoker).toHaveBeenCalledTimes(1);
    expect(budget.settle).toHaveBeenCalledTimes(1);
  },
);
it('does not recast a failed known settlement as a new uncertain write', async () => {
  const budget = owner();
  budget.settle.mockRejectedValue(new Error('commit outcome unknown'));
  const invoker = jest.fn(async () => ({
    body: Buffer.from(JSON.stringify({ embedding: titanVector, inputTextTokenCount: 5 })),
  }));
  await expect(
    withCase12SetupProviderScope(budget, () =>
      new TitanEmbeddingProvider({ invoker }).embed('text'),
    ),
  ).rejects.toThrow('commit outcome unknown');
  expect(budget.settle).toHaveBeenCalledTimes(1);
});
it('rejects forged/reused reservations, nested scopes and detached work', async () => {
  const budget = owner();
  let delayed!: () => Promise<unknown>;
  await expect(
    withCase12SetupProviderScope(budget, () =>
      settleCase12SetupProviderAttempt({}, { kind: 'uncertain' }),
    ),
  ).rejects.toThrow('reservation_invalid');
  await expect(
    withCase12SetupProviderScope(budget, () =>
      withCase12SetupProviderScope(budget, async () => undefined),
    ),
  ).rejects.toThrow('nested_scope');
  await withCase12SetupProviderScope(budget, async () => {
    const cap = await reserveCase12SetupProviderAttempt(payload);
    await settleCase12SetupProviderAttempt(cap, { kind: 'known', inputTokens: 1, outputTokens: 0 });
    await expect(
      settleCase12SetupProviderAttempt(cap, { kind: 'known', inputTokens: 1, outputTokens: 0 }),
    ).rejects.toThrow('reservation_invalid');
    let resolve!: () => void;
    const trigger = new Promise<void>((r) => (resolve = r));
    const result = trigger.then(() => reserveCase12SetupProviderAttempt(payload));
    delayed = () => {
      resolve();
      return result;
    };
  });
  await expect(delayed()).rejects.toThrow('scope_closed');
});
it('blocks unqualified provider scopes and the wrong Bedrock region before wire', async () => {
  const budget = owner(),
    invoker = jest.fn();
  await expect(
    withCase12SetupProviderScope(budget, () =>
      reserveCaptureApiProviderAttempt({
        kind: 'nvidia_rerank',
        provider: 'nvidia',
        model: 'model',
        inputBytes: 1,
      }),
    ),
  ).rejects.toThrow('capture_overlap');
  await expect(
    withCase12SetupProviderScope(budget, () =>
      new TitanEmbeddingProvider({ region: 'us-west-2', invoker }).embed('text'),
    ),
  ).rejects.toThrow('bedrock_region');
  expect(invoker).not.toHaveBeenCalled();
  expect(budget.reserve).not.toHaveBeenCalled();
});
