import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createMeriDispatchRequestIdentityV2,
  type MeriDispatchRequestIdentityV2,
  type MeriDispatchRequestMaterialV2,
} from './meri-hermes-dispatch-intent.contract.js';
import {
  MERI_HERMES_RECOVERY_COMMAND_PURPOSE,
  type MeriHermesRecoveryCommandKeyV1,
} from './meri-hermes-dispatch-recovery.contract.js';
import type {
  MeriHermesRecoveryAbortBoundaryV1,
  MeriHermesRecoveryAbortSignalV1,
  MeriHermesRecoveryFetchInitV1,
  MeriHermesRecoveryFetchResponseV1,
  MeriHermesRecoveryFetchV1,
  MeriHermesRecoveryReadableBodyV1,
} from './meri-hermes-dispatch-recovery.transport.js';
import {
  mintMeriHermesReservationCommandV1,
  verifyMeriHermesReservationCommandV1,
} from './meri-hermes-reservation-recovery.contract.js';
import {
  MERI_HERMES_RESERVATION_MAX_RESPONSE_BYTES_V1,
  MeriHermesReservationRecoveryTransportV1,
  MeriHermesReservationTransportUnconfirmedError,
  type MeriHermesReservationResolvedEndpointV1,
  type MeriHermesReservationTransportRequestV1,
} from './meri-hermes-reservation-recovery.transport.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const RUN = '55555555-5555-4555-8555-555555555555';
const SCOPE = `tenant:${TENANT}:user:${ACTOR}`;
const ISSUED = '1790366300000000';
const VERIFY_AT = '1790366320000000';
const EXPIRES = '1790366350000000';
const BASE_URL = 'https://worker.example.test';
const AUTHORIZATION = 'Bearer retained-native-worker-token';
const RECEIPT = `mhrqr1.e30.${Buffer.alloc(32, 11).toString('base64url')}`;

const MATERIAL: MeriDispatchRequestMaterialV2 = {
  metadata: {
    version: 2, tenantId: TENANT, actorType: 'user', actorId: ACTOR,
    meriAudience: 'private', clientId: null, workspaceId: null, scopeId: SCOPE,
    conversationId: CONVERSATION,
    userMessageId: '44444444-4444-4444-8444-444444444444', runId: RUN,
    idempotencyKey: 'phase4-reservation-transport', conversationEpoch: 3,
    workerAudience: 'meri-hermes-scope-worker', workerIngressId: 'private-ingress-a',
    workerGeneration: 'worker-image-sha256:2026',
    workerCredentialId: 'worker-credential-2026-09',
    authorizationVersion: 'authorization-v8', authorizationPolicyVersion: 'policy-v8',
    grantVersion: 'grant-v4', catalogDigest: 'a'.repeat(64), toolViewDigest: 'b'.repeat(64),
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
  keyId: 'phase4-recovery-command-key-2026-09', tenantId: TENANT,
  workerAudience: IDENTITY.workerAudience, workerIngressId: IDENTITY.workerIngressId,
  workerGeneration: IDENTITY.workerGeneration,
  workerCredentialId: IDENTITY.workerCredentialId,
  secret: Buffer.alloc(32, 41),
  notBeforeEpochMicros: '1790366200000000',
  notAfterEpochMicros: '1790366500000000',
};

class FakeAbortBoundary implements MeriHermesRecoveryAbortBoundaryV1 {
  readonly signal: { aborted: boolean } = { aborted: false };
  async run<T>(
    operation: (signal: MeriHermesRecoveryAbortSignalV1) => Promise<T>,
  ): Promise<T> {
    return operation(this.signal);
  }
}

class StaticHeaders {
  constructor(readonly rows: readonly (readonly [string, string])[]) {}
  entries(): Iterable<readonly [string, string]> { return this.rows; }
}

function readableBody(
  chunks: readonly Uint8Array[],
  options: { onRead?: () => void; onCancel?: () => void } = {},
): MeriHermesRecoveryReadableBodyV1 {
  return {
    getReader() {
      let index = 0;
      return {
        async read() {
          if (index >= chunks.length) return { done: true };
          const value = chunks[index++]!;
          options.onRead?.();
          return { done: false, value };
        },
        async cancel() { options.onCancel?.(); },
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
}): MeriHermesRecoveryFetchResponseV1 {
  const body = options.body ?? Uint8Array.from([0xff, 0x00, 0x7b, 0x0a]);
  return {
    status: options.status ?? 200,
    url: options.url,
    redirected: options.redirected ?? false,
    ...(options.type ? { type: options.type } : {}),
    headers: new StaticHeaders(options.headers ?? [
      ['X-Meri-Dispatch-Reservation-Receipt', RECEIPT],
    ]),
    body: readableBody(options.chunks ?? [body], options),
  };
}

function request(): MeriHermesReservationTransportRequestV1 {
  const commandToken = mintMeriHermesReservationCommandV1({
    identity: IDENTITY,
    idempotencyKey: 'phase4-dispatch-55555555',
    deliveryNotBeforeEpochMicros: '1790366290000000',
    operationId: '77777777-7777-4777-8777-777777777777',
    attemptNonce: Buffer.alloc(16, 33).toString('base64url'),
    notBeforeEpochMicros: ISSUED,
    notAfterEpochMicros: EXPIRES,
  }, COMMAND_KEY);
  const command = verifyMeriHermesReservationCommandV1(
    commandToken, IDENTITY, COMMAND_KEY, VERIFY_AT,
  )!;
  return { identity: IDENTITY, commandToken, command };
}

function endpoint(
  identity: Readonly<MeriDispatchRequestIdentityV2> = IDENTITY,
): MeriHermesReservationResolvedEndpointV1 {
  return { identity, baseUrl: BASE_URL, authorization: AUTHORIZATION };
}

function transportWith(options: {
  resolve?: () => Promise<MeriHermesReservationResolvedEndpointV1>;
  fetch: MeriHermesRecoveryFetchV1;
  abort?: FakeAbortBoundary;
}) {
  return new MeriHermesReservationRecoveryTransportV1({
    resolver: { resolve: options.resolve ?? (async () => endpoint()) },
    fetch: options.fetch,
    abortBoundary: options.abort ?? new FakeAbortBoundary(),
  });
}

describe('dormant Phase 4 unknown-worker reservation HTTPS transport', () => {
  test('sends the exact POST path, no body, two singular headers, and preserves raw bytes', async () => {
    const body = Uint8Array.from([0xff, 0x00, 0x7b, 0x0a]);
    let capturedUrl = '';
    let captured: Readonly<MeriHermesRecoveryFetchInitV1> | null = null;
    const fetch: MeriHermesRecoveryFetchV1 = async (url, init) => {
      capturedUrl = url;
      captured = init;
      return response({ url, body });
    };
    const result = await transportWith({ fetch }).execute(request());
    expect(capturedUrl).toBe(
      `${BASE_URL}/v1/meri/phase4/reservations/lookup-or-seal`,
    );
    expect(new URL(capturedUrl).search).toBe('');
    expect(captured).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(captured!.headers).toEqual([
      ['Authorization', AUTHORIZATION],
      ['X-Meri-Dispatch-Reservation-Command', request().commandToken],
    ]);
    expect('body' in captured!).toBe(false);
    expect(result).toEqual({
      receiptToken: RECEIPT, nativeHttpStatus: 200, nativeResponseBodyBytes: body,
    });
    expect(result.nativeResponseBodyBytes).not.toBe(body);
  });

  test('copies identity, command, and token before the resolver await', async () => {
    const mutable = {
      ...request(), identity: { ...IDENTITY }, command: { ...request().command },
    };
    const originalToken = mutable.commandToken;
    let captured: Readonly<MeriHermesRecoveryFetchInitV1> | null = null;
    const transport = transportWith({
      resolve: async () => {
        mutable.identity.tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        mutable.commandToken = 'mutated-command';
        (mutable.command as unknown as { nativePath: string }).nativePath = '/mutated';
        return endpoint();
      },
      fetch: async (url, init) => {
        captured = init;
        return response({ url });
      },
    });
    await expect(transport.execute(mutable)).resolves.toMatchObject({ receiptToken: RECEIPT });
    expect(captured!.headers[1]).toEqual([
      'X-Meri-Dispatch-Reservation-Command', originalToken,
    ]);
  });

  test('fails closed on lost response, uncertain body, and duplicate or missing receipts', async () => {
    await expect(transportWith({
      fetch: async () => { throw new Error('connection lost after send'); },
    }).execute(request())).rejects.toBeInstanceOf(
      MeriHermesReservationTransportUnconfirmedError,
    );
    await expect(transportWith({
      fetch: async (url) => ({
        ...response({ url }),
        body: { getReader: () => ({
          async read(): Promise<Readonly<{ done: boolean; value?: Uint8Array }>> {
            throw new Error('body lost');
          },
          async cancel() {},
        }) },
      }),
    }).execute(request())).rejects.toBeInstanceOf(
      MeriHermesReservationTransportUnconfirmedError,
    );
    for (const headers of [
      [
        ['X-Meri-Dispatch-Reservation-Receipt', RECEIPT],
        ['x-meri-dispatch-reservation-receipt', RECEIPT],
      ],
      [['X-Meri-Dispatch-Reservation-Receipt', `${RECEIPT}, ${RECEIPT}`]],
      [['Content-Type', 'application/json']],
    ] as const) {
      let reads = 0;
      await expect(transportWith({
        fetch: async (url) => response({
          url, headers, onRead: () => { reads += 1; },
        }),
      }).execute(request())).rejects.toBeInstanceOf(
        MeriHermesReservationTransportUnconfirmedError,
      );
      expect(reads).toBe(0);
    }
  });

  test('rejects declared and streamed oversized responses and cancels them', async () => {
    let declaredReads = 0;
    let declaredCancels = 0;
    await expect(transportWith({
      fetch: async (url) => response({
        url,
        headers: [
          ['X-Meri-Dispatch-Reservation-Receipt', RECEIPT],
          ['Content-Length', String(MERI_HERMES_RESERVATION_MAX_RESPONSE_BYTES_V1 + 1)],
        ],
        onRead: () => { declaredReads += 1; },
        onCancel: () => { declaredCancels += 1; },
      }),
    }).execute(request())).rejects.toBeInstanceOf(
      MeriHermesReservationTransportUnconfirmedError,
    );
    expect(declaredReads).toBe(0);
    expect(declaredCancels).toBe(1);

    let chunkCancels = 0;
    await expect(transportWith({
      fetch: async (url) => response({
        url,
        chunks: [new Uint8Array(40_000), new Uint8Array(30_000)],
        onCancel: () => { chunkCancels += 1; },
      }),
    }).execute(request())).rejects.toBeInstanceOf(
      MeriHermesReservationTransportUnconfirmedError,
    );
    expect(chunkCancels).toBe(1);
  });

  test('rejects redirects, wrong endpoints, wrong identities, origins, auth, and aborts', async () => {
    const cases: Array<() => ReturnType<typeof transportWith>> = [
      () => transportWith({ fetch: async (url) => response({ url, status: 302 }) }),
      () => transportWith({ fetch: async (url) => response({ url, redirected: true }) }),
      () => transportWith({ fetch: async () => response({ url: 'https://other.test/copied' }) }),
      () => transportWith({
        resolve: async () => endpoint({
          ...IDENTITY, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        }),
        fetch: async (url) => response({ url }),
      }),
      () => transportWith({
        resolve: async () => ({ ...endpoint(), baseUrl: `${BASE_URL}/copied` }),
        fetch: async (url) => response({ url }),
      }),
      () => transportWith({
        resolve: async () => ({ ...endpoint(), authorization: 'Basic copied' }),
        fetch: async (url) => response({ url }),
      }),
    ];
    for (const make of cases) {
      await expect(make().execute(request())).rejects.toBeInstanceOf(
        MeriHermesReservationTransportUnconfirmedError,
      );
    }
    const abort = new FakeAbortBoundary();
    abort.signal.aborted = true;
    await expect(transportWith({
      fetch: async (url) => response({ url }), abort,
    }).execute(request())).rejects.toBeInstanceOf(
      MeriHermesReservationTransportUnconfirmedError,
    );
  });

  test('contains no process clock, retry, registration, or native-body parsing path', () => {
    const source = readFileSync(join(
      __dirname, 'meri-hermes-reservation-recovery.transport.ts',
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
