import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createMeriDispatchRequestIdentityV2,
  type MeriDispatchRequestIdentityV2,
  type MeriDispatchRequestMaterialV2,
} from './meri-hermes-dispatch-intent.contract.js';
import {
  MERI_HERMES_RECOVERY_COMMAND_PURPOSE,
  mintMeriHermesRecoveryCommandV1,
  verifyMeriHermesRecoveryCommandV1,
  type MeriHermesRecoveryCommandKeyV1,
} from './meri-hermes-dispatch-recovery.contract.js';
import type { MeriHermesRecoveryTransportRequestV1 } from
  './meri-hermes-dispatch-recovery-boundary.js';
import {
  MERI_HERMES_RECOVERY_MAX_RESPONSE_BYTES_V1,
  MeriHermesDispatchRecoveryTransportV1,
  MeriHermesRecoveryTransportUnconfirmedError,
  type MeriHermesRecoveryAbortBoundaryV1,
  type MeriHermesRecoveryAbortSignalV1,
  type MeriHermesRecoveryFetchInitV1,
  type MeriHermesRecoveryFetchResponseV1,
  type MeriHermesRecoveryFetchV1,
  type MeriHermesRecoveryReadableBodyV1,
  type MeriHermesRecoveryResolvedEndpointV1,
} from './meri-hermes-dispatch-recovery.transport.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const RUN = '55555555-5555-4555-8555-555555555555';
const OPERATION = '66666666-6666-4666-8666-666666666666';
const SCOPE = `tenant:${TENANT}:user:${ACTOR}`;
const WORKER_RUN = 'worker-run-recovery-1';
const ISSUED = '1790366300000000';
const VERIFY_AT = '1790366320000000';
const EXPIRES = '1790366350000000';
const BASE_URL = 'https://worker.example.test';
const AUTHORIZATION = 'Bearer retained-native-worker-token';
const RECEIPT = `mhrr1.e30.${Buffer.alloc(32, 11).toString('base64url')}`;

const MATERIAL: MeriDispatchRequestMaterialV2 = {
  metadata: {
    version: 2,
    tenantId: TENANT,
    actorType: 'user',
    actorId: ACTOR,
    meriAudience: 'private',
    clientId: null,
    workspaceId: null,
    scopeId: SCOPE,
    conversationId: CONVERSATION,
    userMessageId: '44444444-4444-4444-8444-444444444444',
    runId: RUN,
    idempotencyKey: 'phase4-recovery-transport',
    conversationEpoch: 3,
    workerAudience: 'meri-hermes-scope-worker',
    workerIngressId: 'private-ingress-a',
    workerGeneration: 'worker-image-sha256:2026',
    workerCredentialId: 'worker-credential-2026-09',
    authorizationVersion: 'authorization-v8',
    authorizationPolicyVersion: 'policy-v8',
    grantVersion: 'grant-v4',
    catalogDigest: 'a'.repeat(64),
    toolViewDigest: 'b'.repeat(64),
    sessionHeaderKeyId: 'dispatch-hmac-2026-09',
    claimNotAfterEpochMicros: '1790366400000000',
    deliveryNotAfterEpochMicros: '1790366460000000',
    workerCredentialNotAfterEpochMicros: '1790366460000000',
    reconciliationNotAfterEpochMicros: '1790456460000000',
    retainUntilEpochMicros: '1790546460000000',
  },
  sourceMessage: { body: 'recover this exact turn', metadata: { runtime: 'hermes' } },
  bodyBytes: Buffer.from('{"input":"recover"}', 'utf8'),
  sessionKeyHeaderValue: `${SCOPE}:conversation:${CONVERSATION}:e3`,
  sessionHeaderHmacKey: Buffer.alloc(32, 7),
};
const IDENTITY = createMeriDispatchRequestIdentityV2(MATERIAL);
const COMMAND_KEY: MeriHermesRecoveryCommandKeyV1 = {
  purpose: MERI_HERMES_RECOVERY_COMMAND_PURPOSE,
  keyId: 'phase4-recovery-command-key-2026-09',
  tenantId: TENANT,
  workerAudience: IDENTITY.workerAudience,
  workerIngressId: IDENTITY.workerIngressId,
  workerGeneration: IDENTITY.workerGeneration,
  workerCredentialId: IDENTITY.workerCredentialId,
  secret: Buffer.alloc(32, 41),
  notBeforeEpochMicros: '1790366200000000',
  notAfterEpochMicros: '1790366500000000',
};

class StaticHeaders {
  constructor(private readonly values: readonly (readonly [string, string])[]) {}
  entries(): Iterable<readonly [string, string]> {
    return this.values;
  }
}

class FakeAbortBoundary implements MeriHermesRecoveryAbortBoundaryV1 {
  readonly signal: { aborted: boolean } = { aborted: false };
  invocations = 0;

  async run<T>(
    operation: (signal: MeriHermesRecoveryAbortSignalV1) => Promise<T>,
  ): Promise<T> {
    this.invocations += 1;
    return operation(this.signal);
  }
}

function readableBody(
  chunks: readonly Uint8Array[],
  options: { onRead?: () => void; onCancel?: () => void; onAcquire?: () => void } = {},
): MeriHermesRecoveryReadableBodyV1 {
  let acquired = false;
  return {
    getReader() {
      if (acquired) throw new Error('body stream acquired twice');
      acquired = true;
      options.onAcquire?.();
      let index = 0;
      return {
        async read() {
          if (index >= chunks.length) return { done: true };
          const value = chunks[index++]!;
          options.onRead?.();
          return { done: false, value };
        },
        async cancel() {
          options.onCancel?.();
        },
        releaseLock() {},
      };
    },
  };
}

function response(options: {
  url: string;
  status?: number;
  redirected?: boolean;
  type?: string;
  headers?: readonly (readonly [string, string])[];
  body?: Uint8Array;
  chunks?: readonly Uint8Array[];
  onRead?: () => void;
  onCancel?: () => void;
  onAcquire?: () => void;
}): MeriHermesRecoveryFetchResponseV1 {
  const body = options.body ?? Uint8Array.from([0xff, 0x00, 0x7b, 0x0a]);
  return {
    status: options.status ?? 200,
    url: options.url,
    redirected: options.redirected ?? false,
    ...(options.type ? { type: options.type } : {}),
    headers: new StaticHeaders(options.headers ?? [
      ['X-Meri-Dispatch-Recovery-Receipt', RECEIPT],
    ]),
    body: readableBody(options.chunks ?? [body], options),
  };
}

function request(action: 'status' | 'stop' = 'status'):
MeriHermesRecoveryTransportRequestV1 {
  const nativeBodyBytes = action === 'status' ? Buffer.alloc(0) : Buffer.from('{}');
  const commandToken = mintMeriHermesRecoveryCommandV1({
    identity: IDENTITY,
    workerRunId: WORKER_RUN,
    action,
    operationId: OPERATION,
    attemptNonce: Buffer.alloc(16, 31).toString('base64url'),
    nativeBodyBytes,
    notBeforeEpochMicros: ISSUED,
    notAfterEpochMicros: EXPIRES,
  }, COMMAND_KEY);
  const command = verifyMeriHermesRecoveryCommandV1(
    commandToken, IDENTITY, WORKER_RUN, COMMAND_KEY, VERIFY_AT,
  )!;
  return {
    identity: IDENTITY,
    workerRunId: WORKER_RUN,
    action,
    commandToken,
    command,
    nativeBodyBytes,
  };
}

function endpoint(
  identity: Readonly<MeriDispatchRequestIdentityV2> = IDENTITY,
): MeriHermesRecoveryResolvedEndpointV1 {
  return {
    identity,
    workerRunId: WORKER_RUN,
    baseUrl: BASE_URL,
    authorization: AUTHORIZATION,
  };
}

function transportWith(options: {
  resolve?: () => Promise<MeriHermesRecoveryResolvedEndpointV1>;
  fetch: MeriHermesRecoveryFetchV1;
  abort?: FakeAbortBoundary;
}): MeriHermesDispatchRecoveryTransportV1 {
  return new MeriHermesDispatchRecoveryTransportV1({
    resolver: {
      resolve: options.resolve ?? (async () => endpoint()),
    },
    fetch: options.fetch,
    abortBoundary: options.abort ?? new FakeAbortBoundary(),
  });
}

describe('dormant Phase 4 recovery HTTPS transport', () => {
  it('sends the exact status path, empty query, two singular headers, and preserves raw bytes', async () => {
    const body = Uint8Array.from([0xff, 0x00, 0x7b, 0x0a]);
    let capturedUrl = '';
    let captured: Readonly<MeriHermesRecoveryFetchInitV1> | null = null;
    let reads = 0;
    let acquisitions = 0;
    const fetch: MeriHermesRecoveryFetchV1 = async (url, init) => {
      capturedUrl = url;
      captured = init;
      return response({
        url, body,
        onRead: () => { reads += 1; },
        onAcquire: () => { acquisitions += 1; },
      });
    };
    const transport = transportWith({ fetch });

    const result = await transport.execute(request());
    expect(capturedUrl).toBe(`${BASE_URL}/v1/runs/${WORKER_RUN}`);
    expect(new URL(capturedUrl).search).toBe('');
    expect(captured).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(captured!.headers).toEqual([
      ['Authorization', AUTHORIZATION],
      ['X-Meri-Dispatch-Recovery-Command', request().commandToken],
    ]);
    expect('body' in captured!).toBe(false);
    expect(reads).toBe(1);
    expect(acquisitions).toBe(1);
    expect(result).toEqual({
      receiptToken: RECEIPT,
      nativeHttpStatus: 200,
      nativeResponseBodyBytes: body,
    });
    expect(result.nativeResponseBodyBytes).not.toBe(body);
  });

  it('copies stop body and command material before the resolver await', async () => {
    const mutable = {
      ...request('stop'),
      identity: { ...IDENTITY },
      command: { ...request('stop').command },
      nativeBodyBytes: Uint8Array.from(Buffer.from('{}')),
    };
    const originalToken = mutable.commandToken;
    let captured: Readonly<MeriHermesRecoveryFetchInitV1> | null = null;
    const transport = transportWith({
      resolve: async () => {
        mutable.identity.tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        mutable.workerRunId = 'mutated-worker';
        mutable.commandToken = 'mutated-command';
        mutable.command.nativePath = '/mutated';
        mutable.nativeBodyBytes.fill(0x78);
        return endpoint();
      },
      fetch: async (url, init) => {
        captured = init;
        return response({ url });
      },
    });

    await expect(transport.execute(mutable)).resolves.toMatchObject({
      receiptToken: RECEIPT,
    });
    expect(captured).toMatchObject({ method: 'POST' });
    expect(Buffer.from(captured!.body!)).toEqual(Buffer.from('{}'));
    expect(captured!.headers[1]).toEqual([
      'X-Meri-Dispatch-Recovery-Command', originalToken,
    ]);
  });

  it('fails closed when the response is lost or the body read is uncertain', async () => {
    const lost = transportWith({
      fetch: async () => { throw new Error('connection lost after send'); },
    });
    await expect(lost.execute(request()))
      .rejects.toBeInstanceOf(MeriHermesRecoveryTransportUnconfirmedError);

    const readLost = transportWith({
      fetch: async (url) => ({
        ...response({ url }),
        body: {
          getReader() {
            return {
              async read(): Promise<Readonly<{ done: boolean; value?: Uint8Array }>> {
                throw new Error('response body lost');
              },
              async cancel() {},
            };
          },
        },
      }),
    });
    await expect(readLost.execute(request()))
      .rejects.toBeInstanceOf(MeriHermesRecoveryTransportUnconfirmedError);
  });

  it('rejects duplicate, collapsed-duplicate, or missing receipt headers', async () => {
    for (const headers of [
      [
        ['X-Meri-Dispatch-Recovery-Receipt', RECEIPT],
        ['x-meri-dispatch-recovery-receipt', RECEIPT],
      ],
      [['X-Meri-Dispatch-Recovery-Receipt', `${RECEIPT}, ${RECEIPT}`]],
      [['Content-Type', 'application/octet-stream']],
    ] as const) {
      let reads = 0;
      const transport = transportWith({
        fetch: async (url) => response({
          url, headers, onRead: () => { reads += 1; },
        }),
      });
      await expect(transport.execute(request()))
        .rejects.toBeInstanceOf(MeriHermesRecoveryTransportUnconfirmedError);
      expect(reads).toBe(0);
    }
  });

  it('rejects declared and chunked oversized bodies and cancels before retention', async () => {
    let declaredReads = 0;
    let declaredCancels = 0;
    const declared = transportWith({
      fetch: async (url) => response({
        url,
        headers: [
          ['X-Meri-Dispatch-Recovery-Receipt', RECEIPT],
          ['Content-Length', String(MERI_HERMES_RECOVERY_MAX_RESPONSE_BYTES_V1 + 1)],
        ],
        body: Uint8Array.from([1]),
        onRead: () => { declaredReads += 1; },
        onCancel: () => { declaredCancels += 1; },
      }),
    });
    await expect(declared.execute(request()))
      .rejects.toBeInstanceOf(MeriHermesRecoveryTransportUnconfirmedError);
    expect(declaredReads).toBe(0);
    expect(declaredCancels).toBe(1);

    let chunkReads = 0;
    let chunkCancels = 0;
    const chunked = transportWith({
      fetch: async (url) => response({
        url,
        chunks: [new Uint8Array(40_000), new Uint8Array(30_000)],
        onRead: () => { chunkReads += 1; },
        onCancel: () => { chunkCancels += 1; },
      }),
    });
    await expect(chunked.execute(request()))
      .rejects.toBeInstanceOf(MeriHermesRecoveryTransportUnconfirmedError);
    expect(chunkReads).toBe(2);
    expect(chunkCancels).toBe(1);
  });

  it('rejects every redirect signal and a response from another endpoint', async () => {
    for (const fetch of [
      async (url: string) => response({ url, status: 302 }),
      async (url: string) => response({ url, redirected: true }),
      async (url: string) => response({ url, type: 'opaqueredirect' }),
      async () => response({ url: 'https://other.example.test/v1/runs/copied' }),
    ]) {
      const transport = transportWith({ fetch });
      await expect(transport.execute(request()))
        .rejects.toBeInstanceOf(MeriHermesRecoveryTransportUnconfirmedError);
    }
  });

  it('rejects a resolver result bound to another identity before fetch', async () => {
    const fetch = jest.fn(async (url: string) => response({ url }));
    const wrongIdentity = {
      ...IDENTITY,
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    };
    const transport = transportWith({
      resolve: async () => endpoint(wrongIdentity),
      fetch,
    });
    await expect(transport.execute(request()))
      .rejects.toBeInstanceOf(MeriHermesRecoveryTransportUnconfirmedError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects retained native Authorization values outside exact Bearer token form', async () => {
    const fetch = jest.fn(async (url: string) => response({ url }));
    for (const authorization of [
      'Basic copied',
      'Token copied',
      'Bearer token with spaces',
      'bearer wrong-case',
    ]) {
      const transport = transportWith({
        resolve: async () => ({ ...endpoint(), authorization }),
        fetch,
      });
      await expect(transport.execute(request()))
        .rejects.toBeInstanceOf(MeriHermesRecoveryTransportUnconfirmedError);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects non-origin HTTPS resolver URLs and pre-aborted execution', async () => {
    const fetch = jest.fn(async (url: string) => response({ url }));
    for (const baseUrl of [
      'http://worker.example.test',
      'https://worker.example.test/native',
      'https://worker.example.test/?copied=1',
      'https://user:pass@worker.example.test',
    ]) {
      const transport = transportWith({
        resolve: async () => ({ ...endpoint(), baseUrl }),
        fetch,
      });
      await expect(transport.execute(request()))
        .rejects.toBeInstanceOf(MeriHermesRecoveryTransportUnconfirmedError);
    }
    const abort = new FakeAbortBoundary();
    abort.signal.aborted = true;
    const aborted = transportWith({ fetch, abort });
    await expect(aborted.execute(request()))
      .rejects.toBeInstanceOf(MeriHermesRecoveryTransportUnconfirmedError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('contains no process clock, retry, registration, or native-body parsing path', () => {
    const source = readFileSync(join(
      __dirname, 'meri-hermes-dispatch-recovery.transport.ts',
    ), 'utf8');
    expect(source).not.toContain('Date.now');
    expect(source).not.toContain('new Date');
    expect(source).not.toContain('setTimeout');
    expect(source).not.toContain('JSON.parse');
    expect(source).not.toContain('response.json');
    expect(source).not.toContain('@Injectable');
    expect(source).not.toContain('Module');
  });
});
