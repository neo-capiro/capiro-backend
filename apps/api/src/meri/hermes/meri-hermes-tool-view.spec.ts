import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  compileMeriHermesToolViewV1,
  computeMeriHermesObservedToolDigestsV1,
  MERI_HERMES_APPLIED_TOOL_VIEW_DIGEST_ALGORITHM_V1,
  MERI_HERMES_WORKER_CATALOG_DIGEST_ALGORITHM_V1,
  MeriHermesToolViewError,
  type MeriHermesToolViewInputsV1,
  type MeriHermesToolSchemaV1,
} from './meri-hermes-tool-view.js';
import { HermesRuntimeHttpError, MeriHermesRuntimeClient } from './meri-hermes-runtime.client.js';

const base = (): MeriHermesToolViewInputsV1 => ({
  catalogVersion: 'catalog-7',
  expectedCatalogVersion: 'catalog-7',
  meriCatalogDigest: 'e'.repeat(64),
  expectedMeriCatalogDigest: 'e'.repeat(64),
  capabilityMappingVersion: 'mapping-7',
  expectedCapabilityMappingVersion: 'mapping-7',
  capabilityMappingDigest: 'f'.repeat(64),
  expectedCapabilityMappingDigest: 'f'.repeat(64),
  catalogTools: ['search', 'read', 'write', 'clarify', 'record'].map((name) => ({
    type: 'function' as const,
    function: { name, description: `${name} tool`, parameters: { type: 'object' } },
  })),
  deploymentToolNames: ['search', 'read', 'write', 'clarify', 'record'],
  authorizedToolNames: ['search', 'read', 'clarify', 'record'],
  availableToolNames: ['search', 'read', 'write', 'clarify', 'record'],
  requiredToolNames: ['read'],
  relevantToolNames: ['search', 'write'],
  runLocalToolNames: ['clarify', 'record'],
});
const workerCatalog = compileMeriHermesToolViewV1(base()).catalogDigest;
const durableIdempotency = { supported: true, durable: true, retention_seconds: 86_400 };
const runInput = { input: 'hello', idempotencyKey: 'tool-view-test-run' };
const toolViewSigningKey = 'phase4-local-tool-view-signing-key-0123456789abcdef';
const extension = (digest: string = workerCatalog) => ({
  supported: true,
  worker_catalog_sha256: digest,
  worker_catalog_schemas: base().catalogTools,
  worker_catalog_digest_algorithm: MERI_HERMES_WORKER_CATALOG_DIGEST_ALGORITHM_V1,
  applied_tool_view_digest_algorithm: MERI_HERMES_APPLIED_TOOL_VIEW_DIGEST_ALGORITHM_V1,
});

describe('request-local Hermes tool-view contract v1', () => {
  test('preserves required and run-local tools while relevance cannot grant a write', () => {
    expect(compileMeriHermesToolViewV1(base()).toolNames).toEqual(['clarify', 'read', 'record', 'search']);
  });

  test('separate overlapping run snapshots cannot change one another or the input', async () => {
    const shared = base();
    const first = compileMeriHermesToolViewV1(shared);
    const second = compileMeriHermesToolViewV1({
      ...shared,
      authorizedToolNames: ['write', 'clarify'],
      requiredToolNames: ['write'],
      relevantToolNames: ['read'],
    });
    const [b, a] = await Promise.all([Promise.resolve(second), Promise.resolve(first)]);
    expect(a.toolNames).toEqual(['clarify', 'read', 'record', 'search']);
    expect(b.toolNames).toEqual(['clarify', 'write']);
    expect(shared.authorizedToolNames).toEqual(['search', 'read', 'clarify', 'record']);
    expect(Object.isFrozen(a.toolNames)).toBe(true);
  });

  test('intersects catalog, deployment ceiling, authorization, and availability', () => {
    const input = base();
    const view = compileMeriHermesToolViewV1({
      ...input,
      relevantToolNames: ['search', 'write', 'unknown'],
      deploymentToolNames: ['read', 'clarify', 'record'],
    });
    expect(view.toolNames).toEqual(['clarify', 'read', 'record']);
  });

  test('a required tool missing from any server-owned gate fails closed', () => {
    const withoutCatalogTool = base();
    expect(() => compileMeriHermesToolViewV1({
      ...withoutCatalogTool,
      catalogTools: withoutCatalogTool.catalogTools.filter((tool) => tool.function.name !== 'read'),
    })).toThrow(new MeriHermesToolViewError('required_tool_unavailable'));
    for (const gate of ['deploymentToolNames', 'authorizedToolNames', 'availableToolNames'] as const) {
      const input = base();
      expect(() => compileMeriHermesToolViewV1({
        ...input,
        [gate]: input[gate].filter((name) => name !== 'read'),
      })).toThrow(new MeriHermesToolViewError('required_tool_unavailable'));
    }
  });

  test('stale or malformed catalog snapshots fail closed', () => {
    expect(() => compileMeriHermesToolViewV1({ ...base(), expectedCatalogVersion: 'catalog-8' }))
      .toThrow(new MeriHermesToolViewError('stale_catalog'));
    expect(() => compileMeriHermesToolViewV1({
      ...base(), expectedCapabilityMappingDigest: '0'.repeat(64),
    })).toThrow(new MeriHermesToolViewError('stale_catalog'));
    expect(() => compileMeriHermesToolViewV1({ ...base(), relevantToolNames: ['bad-name!'] }))
      .toThrow(new MeriHermesToolViewError('invalid_tool_view'));
    expect(() => compileMeriHermesToolViewV1({
      ...base(), catalogTools: [...base().catalogTools, base().catalogTools[0]!],
    })).toThrow(new MeriHermesToolViewError('invalid_tool_view'));
  });

  test('digests cover exact schemas and the final applied subset canonically', () => {
    const first = compileMeriHermesToolViewV1(base());
    const reordered = base();
    const second = compileMeriHermesToolViewV1({
      ...reordered, catalogTools: [...reordered.catalogTools].reverse(),
    });
    expect(second.catalogDigest).toBe(first.catalogDigest);
    expect(second.toolViewDigest).toBe(first.toolViewDigest);
    const changed = base();
    const schemaChanged = compileMeriHermesToolViewV1({
      ...changed,
      catalogTools: changed.catalogTools.map((tool) => tool.function.name === 'read'
        ? { ...tool, function: { ...tool.function, description: 'changed' } }
        : tool),
    });
    expect(schemaChanged.catalogDigest).not.toBe(first.catalogDigest);
    expect(schemaChanged.toolViewDigest).not.toBe(first.toolViewDigest);
  });

  test('matches the shared TypeScript/Python golden digest vector', () => {
    const vector = JSON.parse(readFileSync(resolve(
      __dirname, '../../../../../docker/hermes-worker/overlay/tool-view-digest-vectors.json',
    ), 'utf8')) as {
      catalog: MeriHermesToolSchemaV1[];
      applied: MeriHermesToolSchemaV1[];
      catalogDigest: string;
      toolViewDigest: string;
    };
    expect(computeMeriHermesObservedToolDigestsV1(vector.catalog, vector.applied)).toEqual({
      catalogDigest: vector.catalogDigest,
      toolViewDigest: vector.toolViewDigest,
    });
  });

  test('rejects ambiguous names, types, non-integral numbers, and unsafe integers', () => {
    const input = base();
    const first = input.catalogTools[0]!;
    expect(() => compileMeriHermesToolViewV1({
      ...input, catalogTools: [{ ...first, name: 'different' }, ...input.catalogTools.slice(1)],
    })).toThrow(new MeriHermesToolViewError('invalid_tool_view'));
    expect(() => compileMeriHermesToolViewV1({
      ...input,
      catalogTools: [{ ...first, type: 'not-a-function' as 'function' },
        ...input.catalogTools.slice(1)],
    })).toThrow(new MeriHermesToolViewError('invalid_tool_view'));
    for (const invalid of [0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => compileMeriHermesToolViewV1({
        ...input,
        catalogTools: [{ ...first, function: { ...first.function, invalid } },
          ...input.catalogTools.slice(1)],
      })).toThrow(new MeriHermesToolViewError('invalid_tool_view'));
    }
    const tooMany = Array.from({ length: 4_097 }, (_unused, index) => ({
      type: 'function' as const,
      function: { name: `tool_${index}`, parameters: { type: 'object' } },
    }));
    expect(() => computeMeriHermesObservedToolDigestsV1(tooMany, []))
      .toThrow(new MeriHermesToolViewError('invalid_tool_view'));
    let nested: unknown = 'leaf';
    for (let depth = 0; depth < 66; depth += 1) nested = [nested];
    for (const invalid of [String.fromCharCode(0xd800), 'x'.repeat(1_048_577), nested]) {
      expect(() => computeMeriHermesObservedToolDigestsV1([{
        type: 'function',
        function: { name: 'read', description: invalid, parameters: { type: 'object' } },
      }], [])).toThrow(new MeriHermesToolViewError('invalid_tool_view'));
    }
  });

  test('the pinned client refuses narrowed runs before sending a request', async () => {
    const fetchMock = jest.fn() as unknown as typeof fetch;
    const client = MeriHermesRuntimeClient.withEnv({
      MERI_HERMES_RUNTIME_URL: 'http://localhost:8642',
      MERI_HERMES_API_KEY: 'test-key',
    }, fetchMock);
    await expect(client.createRunWithToolView({ input: 'hello' }, compileMeriHermesToolViewV1(base())))
      .rejects.toMatchObject({
        status: 501,
        code: 'request_local_tool_view_unsupported',
      } satisfies Partial<HermesRuntimeHttpError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('opted-in client sends a signed view only after worker capability negotiation', async () => {
    const fetchMock = jest.fn(async (url: string) => new Response(
      url.endsWith('/v1/capabilities')
        ? JSON.stringify({ features: { runs_idempotency: durableIdempotency,
          meri_request_local_tool_view_v1: extension() } })
        : JSON.stringify({ run_id: 'run_2', status: 'started' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
    const client = MeriHermesRuntimeClient.withEnv({
      MERI_HERMES_RUNTIME_URL: 'http://localhost:8642',
      MERI_HERMES_API_KEY: 'phase4-local-test-api-key-0123456789abcdef',
      MERI_HERMES_TOOL_VIEW_SIGNING_KEY: toolViewSigningKey,
      MERI_HERMES_TOOL_VIEW_V1_CLIENT_ENABLED: '1',
    }, fetchMock);
    await expect(client.createRunWithToolView(runInput, compileMeriHermesToolViewV1(base())))
      .resolves.toMatchObject({ runId: 'run_2' });
    const calls = (fetchMock as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    expect((calls[1][1] as RequestInit).headers).toMatchObject({
      'Idempotency-Key': runInput.idempotencyKey,
    });
    const body = JSON.parse(String((calls[1][1] as RequestInit).body));
    expect(body.input).toBe('hello');
    expect(body.tools).toBeUndefined();
    expect(body.enabled_toolsets).toBeUndefined();
    const signed = body.meri_tool_view_v1;
    expect(signed.signature).toMatch(/^[0-9a-f]{64}$/);
    const payload = JSON.parse(Buffer.from(signed.payload, 'base64url').toString('utf8'));
    expect(payload).toMatchObject({
      version: 1, catalog_version: 'catalog-7', worker_catalog_sha256: workerCatalog,
      worker_catalog_digest_algorithm: MERI_HERMES_WORKER_CATALOG_DIGEST_ALGORITHM_V1,
      applied_tool_view_sha256: compileMeriHermesToolViewV1(base()).toolViewDigest,
      applied_tool_view_digest_algorithm: MERI_HERMES_APPLIED_TOOL_VIEW_DIGEST_ALGORITHM_V1,
      input_sha256: expect.any(String),
      required_tool_names: ['read'],
    });
  });

  test('snapshots run input before awaiting worker capabilities', async () => {
    let resolveCapabilities!: (response: Response) => void;
    const pendingCapabilities = new Promise<Response>((resolve) => {
      resolveCapabilities = resolve;
    });
    const fetchMock = jest.fn(async (url: string) => url.endsWith('/v1/capabilities')
      ? pendingCapabilities
      : new Response(JSON.stringify({ run_id: 'run_snapshot', status: 'started' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const client = MeriHermesRuntimeClient.withEnv({
      MERI_HERMES_RUNTIME_URL: 'http://localhost:8642',
      MERI_HERMES_API_KEY: 'phase4-local-test-api-key-0123456789abcdef',
      MERI_HERMES_TOOL_VIEW_SIGNING_KEY: toolViewSigningKey,
      MERI_HERMES_TOOL_VIEW_V1_CLIENT_ENABLED: '1',
    }, fetchMock);
    const mutable = {
      input: 'original input', idempotencyKey: 'original-idempotency',
      sessionKey: 'original-session', instructions: 'original instructions',
      model: 'original-model', provider: 'original-provider',
      modelOptions: { nested: { temperature: 0 } },
    };
    const promise = client.createRunWithToolView(mutable, compileMeriHermesToolViewV1(base()));
    mutable.input = 'mutated input';
    mutable.idempotencyKey = '';
    mutable.sessionKey = 'mutated-session';
    mutable.instructions = 'mutated instructions';
    mutable.model = 'mutated-model';
    mutable.provider = 'mutated-provider';
    mutable.modelOptions.nested.temperature = 1;
    resolveCapabilities(new Response(JSON.stringify({ features: {
      runs_idempotency: durableIdempotency,
      meri_request_local_tool_view_v1: extension(),
    } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(promise).resolves.toMatchObject({ runId: 'run_snapshot' });
    const request = (fetchMock as jest.Mock).mock.calls[1]?.[1] as RequestInit;
    expect(request.headers).toMatchObject({
      'Idempotency-Key': 'original-idempotency',
      'X-Hermes-Session-Key': 'original-session',
    });
    const sent = JSON.parse(String(request.body));
    expect(sent).toMatchObject({
      input: 'original input', instructions: 'original instructions',
      model: 'original-model', provider: 'original-provider',
      model_options: { nested: { temperature: 0 } },
    });
    const signedPayload = JSON.parse(Buffer.from(
      sent.meri_tool_view_v1.payload, 'base64url',
    ).toString('utf8'));
    expect(signedPayload.input_sha256).toBe(
      createHash('sha256').update('original input').digest('hex'),
    );
  });

  test('opted-in client refuses workers without the extension before run submission', async () => {
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({ features: {} }), { status: 200 })) as unknown as typeof fetch;
    const client = MeriHermesRuntimeClient.withEnv({
      MERI_HERMES_RUNTIME_URL: 'http://localhost:8642',
      MERI_HERMES_API_KEY: 'phase4-local-test-api-key-0123456789abcdef',
      MERI_HERMES_TOOL_VIEW_V1_CLIENT_ENABLED: '1',
    }, fetchMock);
    await expect(client.createRunWithToolView(runInput, compileMeriHermesToolViewV1(base())))
      .rejects.toMatchObject({ code: 'request_local_tool_view_unsupported' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('opted-in client rejects a worker without a digest before run submission', async () => {
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({
      features: { runs_idempotency: durableIdempotency, meri_request_local_tool_view_v1: {
        supported: true, worker_catalog_sha256: 'invalid',
      } },
    }), { status: 200 })) as unknown as typeof fetch;
    const client = MeriHermesRuntimeClient.withEnv({
      MERI_HERMES_RUNTIME_URL: 'http://localhost:8642',
      MERI_HERMES_API_KEY: 'phase4-local-test-api-key-0123456789abcdef',
      MERI_HERMES_TOOL_VIEW_V1_CLIENT_ENABLED: '1',
    }, fetchMock);
    await expect(client.createRunWithToolView(runInput, compileMeriHermesToolViewV1(base())))
      .rejects.toMatchObject({ code: 'request_local_tool_view_unsupported', status: 501 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('opted-in client rejects catalog drift before run submission', async () => {
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({
      features: { runs_idempotency: durableIdempotency,
        meri_request_local_tool_view_v1: extension('f'.repeat(64)) },
    }), { status: 200 })) as unknown as typeof fetch;
    const client = MeriHermesRuntimeClient.withEnv({
      MERI_HERMES_RUNTIME_URL: 'http://localhost:8642',
      MERI_HERMES_API_KEY: 'phase4-local-test-api-key-0123456789abcdef',
      MERI_HERMES_TOOL_VIEW_SIGNING_KEY: toolViewSigningKey,
      MERI_HERMES_TOOL_VIEW_V1_CLIENT_ENABLED: '1',
    }, fetchMock);
    await expect(client.createRunWithToolView(runInput, compileMeriHermesToolViewV1(base())))
      .rejects.toMatchObject({ code: 'request_local_tool_view_unsupported', status: 501 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('client will not sign a raw caller-shaped view even when the worker advertises v1', async () => {
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({
      features: { runs_idempotency: durableIdempotency,
        meri_request_local_tool_view_v1: extension() },
    }), { status: 200 })) as unknown as typeof fetch;
    const client = MeriHermesRuntimeClient.withEnv({
      MERI_HERMES_RUNTIME_URL: 'http://localhost:8642',
      MERI_HERMES_API_KEY: 'phase4-local-test-api-key-0123456789abcdef',
      MERI_HERMES_TOOL_VIEW_SIGNING_KEY: toolViewSigningKey,
      MERI_HERMES_TOOL_VIEW_V1_CLIENT_ENABLED: '1',
    }, fetchMock);
    const forged = Object.freeze({
      version: 1, catalogVersion: 'catalog-7',
      toolNames: ['write'], requiredToolNames: ['write'],
    });
    await expect(client.createRunWithToolView(runInput, forged as never))
      .rejects.toMatchObject({ code: 'invalid_tool_view' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('opted-in client refuses an unkeyed narrowed run before any worker call', async () => {
    const fetchMock = jest.fn() as unknown as typeof fetch;
    const client = MeriHermesRuntimeClient.withEnv({
      MERI_HERMES_RUNTIME_URL: 'http://localhost:8642',
      MERI_HERMES_API_KEY: 'phase4-local-test-api-key-0123456789abcdef',
      MERI_HERMES_TOOL_VIEW_V1_CLIENT_ENABLED: '1',
    }, fetchMock);
    await expect(client.createRunWithToolView({ input: 'hello' }, compileMeriHermesToolViewV1(base())))
      .rejects.toMatchObject({ code: 'tool_view_idempotency_required', status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    { supported: true, durable: false, retention_seconds: 86_400 },
    { supported: true, durable: true, retention_seconds: 60 },
    { supported: true, durable: true, retention_seconds: '86400' },
  ])('opted-in client refuses non-durable or too-short worker idempotency: %p', async runsIdempotency => {
    const fetchMock = jest.fn(async () => new Response(JSON.stringify({
      features: { runs_idempotency: runsIdempotency,
        meri_request_local_tool_view_v1: extension() },
    }), { status: 200 })) as unknown as typeof fetch;
    const client = MeriHermesRuntimeClient.withEnv({
      MERI_HERMES_RUNTIME_URL: 'http://localhost:8642',
      MERI_HERMES_API_KEY: 'phase4-local-test-api-key-0123456789abcdef',
      MERI_HERMES_TOOL_VIEW_SIGNING_KEY: toolViewSigningKey,
      MERI_HERMES_TOOL_VIEW_V1_CLIENT_ENABLED: '1',
    }, fetchMock);
    await expect(client.createRunWithToolView(runInput, compileMeriHermesToolViewV1(base())))
      .rejects.toMatchObject({ code: 'request_local_tool_view_unsupported', status: 501 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('legacy off-mode createRun keeps its existing request body', async () => {
    const fetchMock = jest.fn(async () => new Response(
      JSON.stringify({ run_id: 'run_1', status: 'started' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
    const client = MeriHermesRuntimeClient.withEnv({
      MERI_HERMES_RUNTIME_URL: 'http://localhost:8642',
      MERI_HERMES_API_KEY: 'test-key',
    }, fetchMock);
    await expect(client.createRun({ input: 'hello' })).resolves.toMatchObject({ runId: 'run_1' });
    const init = (fetchMock as jest.Mock).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ input: 'hello' });
  });
});
